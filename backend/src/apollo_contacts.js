// Minimal Apollo Contacts scraper
// Usage (args via URLSearchParams from frontend SSE route):
//   --orgIds=["56d...","..."]
//   --headless=true|false
//   --apolloEmail=... --apolloPassword=... (optional)
//   --pageTimeoutMs=15000
// Emits JSON lines to stdout to be consumed by SSE wrapper in Next.js route.

const minimist = require('minimist');
// Reuse the exact same Puppeteer/session boot flow as the companies scraper
// to keep UA, headers, executablePath, userDataDir, and Cloudflare handling identical
const { createApolloSession, closeApolloSession } = require('./crawlers/apollo');

function println(obj) {
  try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch {}
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0)))); }

function buildPeopleUrl(orgId, page, seniorities, sortByField, sortAscending) {
  const base = `https://app.apollo.io/#/organizations/${orgId}/people`;
  const parts = [];
  parts.push(`page=${page}`);
  parts.push(`sortAscending=${sortAscending ? 'true' : 'false'}`);
  parts.push(`sortByField=${encodeURIComponent(sortByField || 'recommendations_score')}`);
  const list = Array.isArray(seniorities) && seniorities.length ? seniorities : ['owner','founder','c_suite','partner'];
  for (const s of list) parts.push(`personSeniorities[]=${encodeURIComponent(String(s))}`);
  return `${base}?${parts.join('&')}`;
}

// Set by main; used by scrapeOrg for server-side CSV export
let appendContactsCsvRow = null;
let contactsCsvEmittedPath = false;
// Cloudflare activity detector assigned in main
let isCfActive = () => false;
let contactsRowsWritten = 0;

async function loginIfNeeded(page, email, password, timeoutMs) {
  try {
    await page.goto('https://app.apollo.io/#/login', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('input[name="email"]', { visible: true, timeout: 4000 });
  } catch {
    // Already logged in
    return;
  }
  if (!email || !password) {
    // Wait for manual login before proceeding
    println({ type: 'status', source: 'apollo-contacts', message: 'awaiting_manual_login' });
    const deadline = Date.now() + Math.max(180000, Number(timeoutMs || 60000));
    while (Date.now() < deadline) {
      try {
        // Consider logged in if app shell markers are present
        const loggedIn = await page.evaluate(() => {
          return Boolean(document.querySelector('a[href*="#/companies"], a[href*="#/organizations/"]'));
        });
        if (loggedIn) {
          println({ type: 'status', source: 'apollo-contacts', message: 'manual_login_detected' });
          try { await sleep(postLoginDelayMs); } catch {}
          break;
        }
      } catch {}
      await sleep(1000);
    }
    return;
  }
  await page.type('input[name="email"]', email, { delay: 20 });
  await page.type('input[name="password"]', password, { delay: 20 });
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: timeoutMs }).catch(()=>{}),
  ]);
  await sleep(2000);
}

async function waitForSessionCookie(page, timeoutMs) {
  const deadline = Date.now() + Math.max(30000, Number(timeoutMs || 15000));
  while (Date.now() < deadline) {
    try {
      const cookies = await page.cookies();
      const hasSession = cookies.some(c => (c.domain || '').includes('apollo.io') && c.name === '_leadgenie_session');
      if (hasSession) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function waitForCloudflare(page, timeoutMs) {
  const deadline = Date.now() + Math.max(60000, Number(timeoutMs || 20000));
  let announced = false;
  let lastClickTs = 0;
  const tryClickChallenge = async () => {
    let clicked = false;
    try {
      const frames = page.frames();
      for (const fr of frames) {
        const url = String(fr.url() || '');
        if (/challenge|cloudflare|turnstile/i.test(url)) {
          const selCandidates = [
            'input[type="checkbox"]',
            'div[role="button"]',
            'button',
            '.cf-turnstile .ctp-checkbox',
            '[data-cf] [role="button"]'
          ];
          for (const sel of selCandidates) {
            const el = await fr.$(sel);
            if (el) {
              try { await el.click({ delay: 10 }); clicked = true; break; } catch {}
            }
          }
          if (clicked) break;
        }
      }
      if (!clicked) {
        const iframeHandle = await page.$('iframe[src*="challenge"], iframe[src*="cloudflare"], iframe[src*="turnstile"]');
        if (iframeHandle) {
          const box = await iframeHandle.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + Math.max(8, box.height / 2));
            await page.mouse.down();
            await page.mouse.up();
            clicked = true;
          }
        }
      }
    } catch {}
    if (clicked) { println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_click' }); lastClickTs = Date.now(); }
    return clicked;
  };
  while (Date.now() < deadline) {
    try {
      const result = await page.evaluate(() => {
        const txt = (document.body && document.body.innerText) || '';
        const iframe = document.querySelector('iframe[src*="challenge"], iframe[src*="cloudflare"], iframe[src*="turnstile"]');
        const btn = Array.from(document.querySelectorAll('button, input, div[role="button"]')).find(e => /verify|human|continue|check|i am human/i.test((e.textContent || e.getAttribute('aria-label') || e.getAttribute('value') || '').trim()));
        const has = Boolean(iframe || /verify you are human|checking your browser|just a moment/i.test(txt) || btn);
        return { has, hasIframe: Boolean(iframe), hasBtn: Boolean(btn) };
      });
      if (result && result.has) {
        if (!announced) { println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_detected' }); announced = true; }
        if (Date.now() - lastClickTs > 1500) { await tryClickChallenge(); }
        await sleep(1000);
        continue;
      }
      if (announced) println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_cleared' });
      return true;
    } catch {}
    await sleep(1000);
  }
  println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_timeout' });
  return false;
}

async function scrapeOrg(page, orgId, timeoutMs, pages, seniorities, sortByField, sortAscending) {
  let total = 0;
  for (let p = 1; p <= pages; p++) {
    const url = buildPeopleUrl(orgId, p, seniorities, sortByField, sortAscending);
    println({ type: 'status', source: 'apollo-contacts', message: 'org_page_start', orgId, page: p, url });
    // Robust navigation with retry to avoid transient "detached frame"/context errors
    let navOk = false;
    for (let na = 0; na < 3 && !navOk; na++) {
      try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        try { await waitForCloudflare(page, timeoutMs); } catch {}
        await sleep(250);
        navOk = true;
      } catch (e) {
        const msg = String(e && (e.message || e));
        if (/Execution context was destroyed|Cannot find context|Target closed|detached/i.test(msg)) {
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch {}
          await sleep(500);
          continue;
        }
        break;
      }
    }
    // Fast-skip if this org page clearly has 0 contacts
    try {
      const totalOnPage = await page.evaluate(() => {
        const footer = document.querySelector('[data-interaction-boundary="Table Pagination"] .zp_tMpqI');
        const t = footer ? (footer.textContent || '').trim() : '';
        const m = t.match(/of\s+([0-9,]+)/i);
        if (m) {
          const n = parseInt(String(m[1] || '').replace(/,/g, ''), 10);
          return Number.isFinite(n) ? n : null;
        }
        // Fallback count chip
        const chip = document.querySelector('[data-count-size]');
        if (chip) {
          const v = (chip.textContent || '').trim();
          const k = v.replace(/[,]/g, '').replace(/K$/i, '000');
          const nn = parseInt(k, 10);
          return Number.isFinite(nn) ? nn : null;
        }
        return null;
      });
      if (totalOnPage === 0) {
        println({ type: 'status', source: 'apollo-contacts', message: 'org_page_no_results', orgId, page: p });
        continue;
      }
    } catch {}
    // If CF recently challenged, PAUSE and wait for manual resolution
    if (typeof isCfActive === 'function' && isCfActive()) {
      println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_active_pausing' });
      // Wait indefinitely until CF is resolved (no auto-reload)
      while (isCfActive()) {
        await sleep(2000);
        try {
          const stillActive = await page.evaluate(() => {
            const txt = (document.body && document.body.innerText) || '';
            const iframe = document.querySelector('iframe[src*="challenge"], iframe[src*="cloudflare"], iframe[src*="turnstile"]');
            const btn = Array.from(document.querySelectorAll('button, input, div[role="button"]')).find(e => /verify|human|continue|check|i am human/i.test((e.textContent || e.getAttribute('aria-label') || e.getAttribute('value') || '').trim()));
            return Boolean(iframe || /verify you are human|checking your browser|just a moment/i.test(txt) || btn);
          });
          if (!stillActive) {
            isCfActive = () => false; // Clear the flag
            println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_resolved' });
            break;
          }
        } catch {}
      }
    }

    // If login is required and no credentials were provided, prompt and wait
    let needsLogin = false;
    try {
      await page.waitForSelector('input[name="email"]', { visible: true, timeout: 3000 });
      needsLogin = true;
    } catch {}
    if (needsLogin) {
      println({ type: 'status', source: 'apollo-contacts', message: 'awaiting_manual_login', orgId });
      // Wait up to 2 minutes for manual login
      const start = Date.now();
      let loggedIn = false;
      while (Date.now() - start < 120000 && !loggedIn) {
        await sleep(2000);
        try {
          const hasTable = await page.$('table tbody tr');
          if (hasTable) loggedIn = true;
        } catch {}
      }
      if (!loggedIn) {
        println({ type: 'error', source: 'apollo-contacts', message: 'login_timeout' });
        continue;
      } else {
        println({ type: 'status', source: 'apollo-contacts', message: 'manual_login_detected' });
      }
    }

    // SPA load stabilization with short cap for empty pages
    let hasRows = false;
    const orgPageDeadline = Date.now() + 5000; // hard-cap ~5s on clearly-empty pages
    for (let attempt = 0; attempt < 2 && !hasRows; attempt++) {
      if (Date.now() > orgPageDeadline) break;
      try {
        // Nudge the virtualized table: scroll the table container rather than window
        await page.evaluate(() => {
          const c = document.querySelector('[data-id="scrollable-table-container"]');
          if (c && c.scrollTo && typeof c.scrollTo === 'function') {
            try { c.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
            try { c.scrollTo({ top: (c.scrollHeight || 0), behavior: 'auto' }); } catch {}
          } else {
            window.scrollTo(0, document.body.scrollHeight);
          }
        });
      } catch {}
      try {
        // Wait for an actual contact cell to be present
        await page.waitForSelector('[data-testid="contact-name-cell"] a[data-to^="/people/"]', { visible: true, timeout: 2000 });
        hasRows = true;
      } catch (e) {
        const msg = String(e && (e.message || e));
        if (/Execution context was destroyed|Cannot find context|Target closed|detached/i.test(msg)) {
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch {}
          try { await waitForCloudflare(page, timeoutMs); } catch {}
          await sleep(250);
          continue;
        }
        if (typeof isCfActive === 'function' && isCfActive()) {
          println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_active_skipping_attempt' });
          await sleep(1000);
          continue;
        }
        // small settle delay then retry
        await sleep(250);
      }
    }
    if (!hasRows) {
      println({ type: 'debug', source: 'apollo-contacts', info: 'no_rows', orgId, page: p });
      continue;
    }
    // Extract people using Apollo contact grid structure
    const rows = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+\n\s+/g, ' ').trim();
    const out = [];
      const push = (rec) => {
        if (!rec) return;
        // Require at least a name or a LinkedIn/person URL
        if (!rec.fullName && !rec.linkedinUrl && !rec.personUrl) return;
        out.push(rec);
      };
      const extractFromEl = (root) => {
        try {
          let fullName = '';
          let firstName = '';
          let lastName = '';
          let jobTitle = '';
          let companyName = '';
          let linkedinUrl = '';
      let personUrl = '';
          let location = '';

          // LinkedIn link (explicit aria-label on button link)
          const ln = root.querySelector('a[aria-label="linkedin link"], a[href*="linkedin.com/in"]');
          if (ln && ln.href) linkedinUrl = ln.href;

          // Person URL (Apollo internal) from contact-name cell anchor
          const ap = root.querySelector('[data-testid="contact-name-cell"] a[data-to^="/people/"]');
          if (ap) personUrl = ap.getAttribute('href') || '';
          
          // Build full Apollo contact URL
          let apolloContactUrl = '';
          if (personUrl) {
            apolloContactUrl = personUrl.startsWith('http') ? personUrl : `https://app.apollo.io${personUrl}`;
          }

          // Company name anchor
          const compA = root.querySelector('a[data-to^="/organizations/"] span, a[data-to^="/organizations/"]');
          if (compA) companyName = norm(compA.textContent || '');

          // Contact name from contact-name cell anchor text
          const nameA = root.querySelector('[data-testid="contact-name-cell"] a[data-to^="/people/"]');
          if (nameA) fullName = norm(nameA.textContent || '');
          if (fullName) {
            const parts = fullName.split(/\s+/);
            firstName = parts[0] || '';
            lastName = parts.slice(1).join(' ');
          }

          // Title cell (aria-colindex 2) or explicit job title span
          const titleCell = root.querySelector('[aria-colindex="2"] .zp_FEm_X, [data-id="contact.job_title"], [class*="job title" i]');
          if (titleCell) jobTitle = norm(titleCell.textContent || '');

          // Location cell (aria-colindex 9) or data-id contact.location
          let locText = '';
          const locCell = root.querySelector('[aria-colindex="9"] .zp_FEm_X, [data-id="contact.location"], [aria-label="Location"]');
          if (locCell) locText = norm(locCell.textContent || '');
          if (!locText) {
            const locEl = Array.from(root.querySelectorAll('span, div')).find(e => /[,]/.test((e.textContent || '')) && /[A-Za-z]/.test((e.textContent || '')) && (e.textContent || '').length < 80);
            if (locEl) locText = norm(locEl.textContent || '');
          }
          location = locText;

          push({ firstName, lastName, fullName, jobTitle, companyName, linkedinUrl, personUrl, apolloContactUrl, location });
        } catch {}
      };

      // Only consider data rows: explicit row ids present in Apollo grid
      const roleRows = Array.from(document.querySelectorAll('[role="row"][id^="table-row-"]'));
      for (const r of roleRows) extractFromEl(r);

      if (out.length === 0) {
        const trs = Array.from(document.querySelectorAll('table tbody tr'));
        for (const tr of trs) extractFromEl(tr);
    }
    return out;
    });
    try { println({ type: 'debug', source: 'apollo-contacts', info: 'people_rows_found', orgId, page: p, count: Array.isArray(rows) ? rows.length : 0 }); } catch {}
    for (const pr of rows) {
      println({ type: 'person', source: 'apollo-contacts', orgId, ...pr });
      try { if (typeof appendContactsCsvRow === 'function') appendContactsCsvRow({
        orgId: orgId,
        companyName: pr.companyName || '',
        companyWebsite: '',
        orgUrl: `https://app.apollo.io/#/organizations/${orgId}`,
        contactName: pr.fullName || `${pr.firstName || ''} ${pr.lastName || ''}`.trim(),
        title: pr.jobTitle || '',
        linkedin: pr.linkedinUrl || '',
        location: pr.location || '',
        apolloContactUrl: pr.apolloContactUrl || '',
        source: 'Apollo',
      }); contactsRowsWritten += 1; println({ type: 'status', source: 'apollo-contacts', message: 'contacts_csv_appended', total: contactsRowsWritten }); } catch {}
    }
    total += rows.length;
    
    // If no contacts found on this page, still add the company info with NA values
    if (rows.length === 0 && p === 1) {
      try { if (typeof appendContactsCsvRow === 'function') appendContactsCsvRow({
        orgId: orgId,
        companyName: '',
        companyWebsite: '',
        orgUrl: `https://app.apollo.io/#/organizations/${orgId}`,
        contactName: 'NA',
        title: 'NA',
        linkedin: 'NA',
        location: 'NA',
        apolloContactUrl: 'NA',
        source: 'Apollo',
      }); contactsRowsWritten += 1; println({ type: 'status', source: 'apollo-contacts', message: 'contacts_csv_appended_no_contacts', total: contactsRowsWritten }); } catch {}
    }
    
    println({ type: 'status', source: 'apollo-contacts', message: 'org_page_done', orgId, page: p, rows: rows.length });

    // In-page pagination: click Next until disabled or we reach requested pages
    let uiPage = 1;
    while (uiPage < pages) {
      const moved = await page.evaluate(() => {
        const root = document.querySelector('[data-interaction-boundary="Table Pagination"]') || document;
        const btn = root.querySelector('button[aria-label="Next"]');
        const el = btn;
        if (el && !(el).hasAttribute('disabled')) {
          (el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }
        return false;
      });
      if (!moved) break;
      try {
        // Wait footer text to change
        const before = await page.evaluate(() => {
          const el = document.querySelector('[data-interaction-boundary="Table Pagination"] .zp_tMpqI');
          return el ? (el.textContent || '').trim() : '';
        });
        await page.waitForFunction((prev) => {
          const el = document.querySelector('[data-interaction-boundary="Table Pagination"] .zp_tMpqI');
          const t = el ? (el.textContent || '').trim() : '';
          return t && t !== prev;
        }, { timeout: Math.max(4000, timeoutMs) }, before);
        // Fast-skip if this page has 0
        const totalOnPage = await page.evaluate(() => {
          const footer = document.querySelector('[data-interaction-boundary] .zp_tMpqI');
          const t = footer ? (footer.textContent || '').trim() : '';
          const m = t.match(/of\s+([0-9,]+)/i);
          if (m) {
            const n = parseInt(String(m[1] || '').replace(/,/g, ''), 10);
            return Number.isFinite(n) ? n : null;
          }
          return null;
        });
        if (totalOnPage === 0) break;
      } catch {}
      // Nudge virtualized table then extract again
      try {
        await page.evaluate(() => {
          const c = document.querySelector('[data-id="scrollable-table-container"]');
          if (c && c.scrollTo && typeof c.scrollTo === 'function') {
            try { c.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
            try { c.scrollTo({ top: (c.scrollHeight || 0), behavior: 'auto' }); } catch {}
          } else {
            window.scrollTo(0, document.body.scrollHeight);
          }
        });
      } catch {}
      try { await page.waitForSelector('[data-testid="contact-name-cell"] a[data-to^="/people/"]', { visible: true, timeout: 5000 }); } catch {}
      const more = await page.evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+\n\s+/g, ' ').trim();
        const out = [];
        const roleRows = Array.from(document.querySelectorAll('[role="row"][id^="table-row-"]'));
        const lnSel = 'a[aria-label="linkedin link"], a[href*="linkedin.com/in"]';
        const nameSel = '[data-testid="contact-name-cell"] a[data-to^="/people/"]';
        for (const root of roleRows) {
          try {
            let fullName = '';
            let firstName = '';
            let lastName = '';
            let jobTitle = '';
            let companyName = '';
            let linkedinUrl = '';
            let personUrl = '';
            let location = '';
            const ln = root.querySelector(lnSel);
            if (ln && ln.href) linkedinUrl = ln.href;
            const ap = root.querySelector(nameSel);
            if (ap) { personUrl = ap.getAttribute('href') || ''; fullName = norm(ap.textContent || ''); }
            
            // Build full Apollo contact URL
            let apolloContactUrl = '';
            if (personUrl) {
              apolloContactUrl = personUrl.startsWith('http') ? personUrl : `https://app.apollo.io${personUrl}`;
            }
            if (fullName) { const parts = fullName.split(/\s+/); firstName = parts[0] || ''; lastName = parts.slice(1).join(' '); }
            const compA = root.querySelector('a[data-to^="/organizations/"] span, a[data-to^="/organizations/"]');
            if (compA) companyName = norm(compA.textContent || '');
            const titleCell = root.querySelector('[aria-colindex="2"] .zp_FEm_X, [data-id="contact.job_title"], [class*="job title" i]');
            if (titleCell) jobTitle = norm(titleCell.textContent || '');
            const locCell = root.querySelector('[aria-colindex="9"] .zp_FEm_X, [data-id="contact.location"], [aria-label="Location"]');
            location = locCell ? norm(locCell.textContent || '') : '';
            if (fullName || linkedinUrl || personUrl) out.push({ firstName, lastName, fullName, jobTitle, companyName, linkedinUrl, personUrl, apolloContactUrl, location });
          } catch {}
        }
        return out;
      });
      for (const pr of Array.isArray(more) ? more : []) {
        println({ type: 'person', source: 'apollo-contacts', orgId, ...pr });
        try { if (typeof appendContactsCsvRow === 'function') appendContactsCsvRow({
          orgId: orgId,
          companyName: pr.companyName || '',
          companyWebsite: '',
          orgUrl: `https://app.apollo.io/#/organizations/${orgId}`,
          contactName: pr.fullName || `${pr.firstName || ''} ${pr.lastName || ''}`.trim(),
          title: pr.jobTitle || '',
          linkedin: pr.linkedinUrl || '',
          location: pr.location || '',
          apolloContactUrl: pr.apolloContactUrl || '',
          source: 'Apollo',
        }); contactsRowsWritten += 1; println({ type: 'status', source: 'apollo-contacts', message: 'contacts_csv_appended', total: contactsRowsWritten }); } catch {}
      }
      try { println({ type: 'debug', source: 'apollo-contacts', info: 'people_rows_found', orgId, page: (p + uiPage), count: Array.isArray(more) ? more.length : 0 }); } catch {}
      uiPage += 1;
    }
    
    // If no contacts found across all pages, still add the company info with NA values
    if (total === 0) {
      try { if (typeof appendContactsCsvRow === 'function') appendContactsCsvRow({
        orgId: orgId,
        companyName: '',
        companyWebsite: '',
        orgUrl: `https://app.apollo.io/#/organizations/${orgId}`,
        contactName: 'NA',
        title: 'NA',
        linkedin: 'NA',
        location: 'NA',
        apolloContactUrl: 'NA',
        source: 'Apollo',
      }); contactsRowsWritten += 1; println({ type: 'status', source: 'apollo-contacts', message: 'contacts_csv_appended_no_contacts_total', total: contactsRowsWritten }); } catch {}
    }
  }
  println({ type: 'status', source: 'apollo-contacts', message: 'org_done', orgId, rows: total });
}

(async () => {
  const argv = minimist(process.argv.slice(2));
  const headless = String(argv.headless || 'true') !== 'false';
  const timeoutMs = Math.max(8000, Number(argv.pageTimeoutMs || 15000));
  const postLoginDelayMs = Math.max(0, Number(argv.postLoginDelayMs || 2000));
  const pages = Math.max(1, Number(argv.pages || 1));
  let seniorities = undefined;
  try { if (argv.seniorities) { const s = JSON.parse(String(argv.seniorities)); if (Array.isArray(s)) seniorities = s; } } catch {}
  const sortByField = String(argv.sortByField || 'recommendations_score');
  const sortAscending = String(argv.sortAscending || 'false') === 'true';
  let orgIds = [];
  try {
    if (argv.orgIds) {
      const parsed = JSON.parse(String(argv.orgIds));
      if (Array.isArray(parsed)) orgIds = parsed.map((s) => String(s).trim()).filter(Boolean);
    }
  } catch {}
  // Fallback: allow token to load orgIds from prepared file
  let originalRows = {};
  let originalHeaders = [];
  try {
    const token = String(argv.token || '').trim();
    if (!orgIds.length && token) {
      const path = require('path');
      const fs = require('fs');
      const file = path.join(process.cwd(), 'backend', 'data', 'people_tokens', `${token}.json`);
      const txt = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(txt);
      if (json && Array.isArray(json.orgIds)) orgIds = json.orgIds.map((s) => String(s).trim()).filter(Boolean);
      if (json && json.originalRows) originalRows = json.originalRows;
      if (json && Array.isArray(json.headers)) originalHeaders = json.headers;
    }
  } catch {}
  const apolloEmail = String(argv.apolloEmail || '').trim();
  const apolloPassword = String(argv.apolloPassword || '').trim();

  if (!orgIds.length) {
    println({ type: 'error', source: 'apollo-contacts', message: 'no_org_ids' });
    process.exit(0);
    return;
  }

  println({ type: 'status', source: 'apollo-contacts', message: 'start', count: orgIds.length });

  // Prepare server-side CSV export (backend/exports)
  // Use the top-level appendContactsCsvRow (do NOT redeclare here)
  appendContactsCsvRow = null;
  try {
    const path = require('path');
    const fs = require('fs');
    const repoRoot = process.cwd();
    const isVercel = Boolean(process.env.VERCEL);
    const exportsDir = isVercel ? '/tmp/exports' : path.join(repoRoot, 'backend', 'exports');
    try { fs.mkdirSync(exportsDir, { recursive: true }); } catch {}
    const day = new Date().toISOString().slice(0, 10);
    // Lightweight jobs tracking (mirror orchestrator format)
    const jobsFile = path.join(exportsDir, 'jobs.json');
    const jobId = (() => {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const rnd = Math.random().toString(36).slice(2, 8);
      return `${ts}-${rnd}`;
    })();
    const readJobsSafe = () => { try { const txt = fs.readFileSync(jobsFile, 'utf8'); const arr = JSON.parse(txt); return Array.isArray(arr) ? arr : []; } catch { return []; } };
    const writeJobsSafe = (arr) => { try { fs.writeFileSync(jobsFile, JSON.stringify(arr, null, 2)); } catch {} };
    const upsertJob = (patch) => {
      const arr = readJobsSafe();
      const idx = arr.findIndex(j => j && j.id === jobId);
      const now = new Date().toISOString();
      if (idx === -1) arr.unshift({ id: jobId, createdAt: now, updatedAt: now, status: 'running', source: 'people', rowsAdded: 0, ...patch });
      else arr[idx] = { ...arr[idx], ...patch, updatedAt: now };
      writeJobsSafe(arr);
    };
    // Per-job CSV path (same pattern as orchestrator)
    const jobCsvPath = path.join(exportsDir, `${day}_people_job-${jobId}.csv`);
    upsertJob({ csvPath: jobCsvPath });
    const ensureHeader = () => {
      try {
        if (!fs.existsSync(jobCsvPath)) {
          // Start with original headers
          let headers = [...originalHeaders];
          
          // Add contact-specific columns only if they don't already exist
          const contactMappings = [
            { key: 'contactName', column: 'Contact Name' },
            { key: 'title', column: 'Title' },
            { key: 'linkedin', column: 'LinkedIn' },
            { key: 'location', column: 'Location' },
            { key: 'apolloContactUrl', column: 'Apollo Contact URL' },
            { key: 'source', column: 'Source' }
          ];
          
          for (const mapping of contactMappings) {
            if (!headers.includes(mapping.column)) {
              headers.push(mapping.column);
            }
          }
          
          const header = headers.join(',') + '\n';
          fs.appendFileSync(jobCsvPath, header);
          if (!contactsCsvEmittedPath) { println({ type: 'status', source: 'apollo-contacts', message: 'contacts_csv_path', path: jobCsvPath }); contactsCsvEmittedPath = true; }
        }
      } catch {}
    };
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    // Create the CSV immediately so it shows up in Exports even before first row
    try { ensureHeader(); println({ type: 'status', source: 'apollo-contacts', message: 'contacts_csv_path', path: jobCsvPath }); contactsCsvEmittedPath = true; } catch {}
    appendContactsCsvRow = (row) => {
      try {
        ensureHeader();
        
        // Get original row data for this org ID
        const originalRow = originalRows[row.orgId] || {};
        
        // Build the final header dynamically (same logic as ensureHeader)
        let headers = [...originalHeaders];
        const contactMappings = [
          { key: 'contactName', column: 'Contact Name' },
          { key: 'title', column: 'Title' },
          { key: 'linkedin', column: 'LinkedIn' },
          { key: 'location', column: 'Location' },
          { key: 'apolloContactUrl', column: 'Apollo Contact URL' },
          { key: 'source', column: 'Source' }
        ];
        
        for (const mapping of contactMappings) {
          if (!headers.includes(mapping.column)) {
            headers.push(mapping.column);
          }
        }
        
        // Create row data in the same order as headers
        const line = headers.map(header => {
          // First check if it's an original column
          if (originalHeaders.includes(header)) {
            return esc(originalRow[header] || '');
          }
          // Then check if it's a contact column
          const mapping = contactMappings.find(m => m.column === header);
          if (mapping) {
            return esc(row[mapping.key] || '');
          }
          return esc('');
        }).join(',') + '\n';
        
        fs.appendFileSync(jobCsvPath, line);
        if (!contactsCsvEmittedPath) { println({ type: 'status', source: 'apollo-contacts', message: 'contacts_csv_path', path: jobCsvPath }); contactsCsvEmittedPath = true; }
        // rowsAdded++
        const arr = readJobsSafe();
        const idx = arr.findIndex(j => j && j.id === jobId);
        if (idx !== -1) { arr[idx].rowsAdded = (arr[idx].rowsAdded || 0) + 1; arr[idx].updatedAt = new Date().toISOString(); writeJobsSafe(arr); }
      } catch {}
    };
    // Finalizer
    process.on('beforeExit', () => { try { upsertJob({ status: 'done' }); } catch {} });
  } catch {}

  // Align session creation with companies flow
  const wantAutoLogin = Boolean(apolloEmail && apolloPassword);
  const wantManualLogin = !wantAutoLogin;
  const sess = await createApolloSession({
    apolloLogin: wantAutoLogin,
    apolloEmail,
    apolloPassword,
    apolloManualLogin: wantManualLogin,
    headless,
    pageTimeoutMs: timeoutMs,
    slowMoMs: headless ? 0 : 250,
  });

  const page = sess && sess.page ? sess.page : null;
  if (!page) {
    println({ type: 'error', source: 'apollo-contacts', message: 'session_page_null' });
    try { await closeApolloSession(sess); } catch {}
    process.exit(1);
    return;
  }

  try {
    // If in manual-login mode, wait until user completes login in the spawned browser
    if (wantManualLogin) {
      println({ type: 'status', source: 'apollo-contacts', message: 'awaiting_manual_login' });
      // Ensure a clean login state: remove any preloaded Apollo cookies to avoid instant auth
      try {
        const all = await page.cookies();
        const apolloCookies = all.filter(c => (c && (c.domain || '').includes('apollo.io')));
        if (apolloCookies.length) {
          try { await page.deleteCookie(...apolloCookies.map(c => ({ name: c.name, domain: c.domain, path: c.path || '/', url: 'https://app.apollo.io' }))); } catch {}
        }
      } catch {}
      // Navigate to Apollo's login page (avoid idling at about:blank)
      try { await page.goto('https://app.apollo.io/#/login', { waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch {}
      try { await waitForCloudflare(page, timeoutMs); } catch {}
      // Wait generously for manual login OR an explicit signal file (shared with companies flow)
      const deadline = Date.now() + Math.max(900000, Number(timeoutMs || 60000) * 10); // ~15 min min
      const fs = require('fs');
      const path = require('path');
      const repoRoot = process.cwd();
      const signalCandidates = [
        path.join(repoRoot, 'apollo_login_signal.tmp'),
        path.join(__dirname, '..', 'apollo_login_signal.tmp'),
        path.join(repoRoot, 'frontend', 'apollo_login_signal.tmp'),
      ];
      let confirmed = false;
      while (Date.now() < deadline) {
        // External confirmation via signal file (matches companies flow)
        try {
          for (const sig of signalCandidates) {
            if (fs.existsSync(sig)) {
              try { fs.unlinkSync(sig); } catch {}
              println({ type: 'status', source: 'apollo-contacts', message: 'manual_login_confirmed_signal' });
              confirmed = true;
              break;
            }
          }
        } catch {}
        if (confirmed) break;
        // If Cloudflare challenge is active, keep waiting and surface status
        try {
          const cfActive = await page.evaluate(() => {
            const txt = (document.body && document.body.innerText) || '';
            const iframe = document.querySelector('iframe[src*="challenge"], iframe[src*="cloudflare"], iframe[src*="turnstile"]');
            const btn = Array.from(document.querySelectorAll('button, input, div[role="button"]')).find(e => /verify|human|continue|check|i am human/i.test((e.textContent || e.getAttribute('aria-label') || e.getAttribute('value') || '').trim()));
            return Boolean(iframe || /verify you are human|checking your browser|just a moment/i.test(txt) || btn);
          });
          if (cfActive) {
            println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_active' });
            await sleep(1000);
            continue;
          }
        } catch {}
        // If the app shell is present or session cookie exists, proceed automatically
        let loggedIn = false;
        try {
          loggedIn = await page.evaluate(() => {
            return Boolean(document.querySelector('a[href*="#/companies"], a[href*="#/organizations/"]'));
          });
        } catch {}
        if (loggedIn) {
          println({ type: 'status', source: 'apollo-contacts', message: 'manual_login_detected' });
          break;
        }
        try {
          const hasCookie = await waitForSessionCookie(page, timeoutMs);
          if (hasCookie) { println({ type: 'status', source: 'apollo-contacts', message: 'session_cookie_detected' }); try { await sleep(postLoginDelayMs); } catch {} break; }
        } catch {}
        await sleep(1000);
      }
      // Optional small pause after login confirmation to allow SPA to settle
      if (confirmed) { try { await sleep(postLoginDelayMs); } catch {} }
      // Do NOT navigate to companies; we proceed directly to people URLs
    }

    // Use the shared page to process all orgs
    // Monitor network responses for CF 401s to toggle isCfActive()
    try {
      page.on('response', (resp) => {
        try {
          const url = resp.url();
          const status = resp.status();
          if (/challenges\.cloudflare\.com/i.test(url) && status === 401) {
            isCfActive = () => true;
            println({ type: 'status', source: 'apollo-contacts', message: 'cf_401_seen' });
          } else {
            // Light reset when responses succeed for app.apollo.io
            if (/app\.apollo\.io/i.test(url) && status < 400) {
              isCfActive = () => false;
            }
          }
        } catch {}
      });
    } catch {}
    for (const orgId of orgIds) {
      try { await scrapeOrg(page, orgId, timeoutMs, pages, seniorities, sortByField, sortAscending); } catch (e) { println({ type: 'stderr', source: 'apollo-contacts', message: String(e && (e.message || e)) }); }
    }
    println({ type: 'done', source: 'apollo-contacts' });
  } finally {
    try { await closeApolloSession(sess); } catch {}
  }
  process.exit(0);
})();


