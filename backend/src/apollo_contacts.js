// Minimal Apollo Contacts scraper
// Usage (args via URLSearchParams from frontend SSE route):
//   --orgIds=["56d...","..."]
//   --headless=true|false
//   --apolloEmail=... --apolloPassword=... (optional)
//   --pageTimeoutMs=15000
// Emits JSON lines to stdout to be consumed by SSE wrapper in Next.js route.

const minimist = require('minimist');
let puppeteer = null;
try { puppeteer = require('puppeteer-extra'); try { puppeteer.use(require('puppeteer-extra-plugin-stealth')()); } catch {} } catch { puppeteer = require('puppeteer'); }

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
  while (Date.now() < deadline) {
    try {
      const hasChallenge = await page.evaluate(() => {
        const txt = (document.body && document.body.innerText) || '';
        return /verify you are human|checking your browser|just a moment/i.test(txt) || document.querySelector('iframe[src*="challenge"], iframe[src*="cloudflare"], iframe[src*="turnstile"]');
      });
      if (hasChallenge) {
        if (!announced) { println({ type: 'status', source: 'apollo-contacts', message: 'cf_challenge_detected' }); announced = true; }
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

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

    // SPA load stabilization and retries
    let hasRows = false;
    for (let attempt = 0; attempt < 6 && !hasRows; attempt++) {
      try {
        await page.waitForSelector('table tbody tr', { visible: true, timeout: 6000 });
        hasRows = true;
      } catch {
        // Try to nudge rendering
        try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
        await sleep(1500);
      }
    }
    if (!hasRows) {
      println({ type: 'debug', source: 'apollo-contacts', info: 'no_rows', orgId, page: p });
      continue;
    }
    const rows = await page.$$eval('table tbody tr', (trs) => {
    const out = [];
    for (const tr of trs) {
      const tdAll = tr.querySelectorAll('td');
      if (!tdAll || tdAll.length === 0) continue;
      const firstTd = tdAll[0] || null;
      const nameTextRaw = firstTd ? firstTd.innerText || '' : '';
      const nameText = nameTextRaw.replace(/\s+\n\s+/g, ' ').trim();
      const parts = nameText.split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ');
      const titleTd = tdAll[1] || null;
      const jobTitle = titleTd ? (titleTd.innerText || '').trim() : '';
      const companyTd = tdAll[2] || null;
      const companyName = companyTd ? (companyTd.innerText || '').trim() : '';
      const linkedinA = firstTd ? firstTd.querySelector('a[href*="linkedin.com/in"]') : null;
      const linkedinUrl = linkedinA ? linkedinA.href : '';
      // Try to capture the Apollo person profile URL if present
      let personUrl = '';
      if (firstTd) {
        const as = firstTd.querySelectorAll('a[href]');
        for (const a of as) {
          const href = a.getAttribute('href') || '';
          if (href.includes('app.apollo.io') && !href.includes('linkedin.com')) { personUrl = a.href || href; break; }
        }
      }
      const locationTd = tdAll[4] || null;
      const location = locationTd ? (locationTd.innerText || '').trim() : '';
      out.push({
        firstName,
        lastName,
        fullName: nameText,
        jobTitle,
        companyName,
        linkedinUrl,
        personUrl,
        location,
      });
    }
    return out;
    });
    for (const pr of rows) {
      println({ type: 'person', source: 'apollo-contacts', orgId, ...pr });
    }
    total += rows.length;
    println({ type: 'status', source: 'apollo-contacts', message: 'org_page_done', orgId, page: p, rows: rows.length });
  }
  println({ type: 'status', source: 'apollo-contacts', message: 'org_done', orgId, rows: total });
}

(async () => {
  const argv = minimist(process.argv.slice(2));
  const headless = String(argv.headless || 'true') !== 'false';
  const timeoutMs = Math.max(8000, Number(argv.pageTimeoutMs || 15000));
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
  try {
    const token = String(argv.token || '').trim();
    if (!orgIds.length && token) {
      const path = require('path');
      const fs = require('fs');
      const file = path.join(process.cwd(), 'backend', 'data', 'people_tokens', `${token}.json`);
      const txt = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(txt);
      if (json && Array.isArray(json.orgIds)) orgIds = json.orgIds.map((s) => String(s).trim()).filter(Boolean);
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
  const launchArgs = [
    '--no-sandbox','--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US,en',
    '--window-size=1280,900',
    '--no-first-run','--no-default-browser-check'
  ];
  const userDataDir = process.env.PUPPETEER_USER_DATA_DIR || '';
  const browser = await puppeteer.launch({ headless, defaultViewport: null, args: launchArgs, ...(userDataDir ? { userDataDir } : {}) });
  const page = await browser.newPage();
  try { await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'); } catch {}
  try { page.setDefaultTimeout(Math.max(15000, timeoutMs)); page.setDefaultNavigationTimeout(Math.max(20000, timeoutMs + 5000)); } catch {}
  try {
    // Preload cookies if present
    const cookieFile = process.env.APOLLO_COOKIES_JSON || '';
    if (cookieFile) {
      try { const fs = require('fs'); if (fs.existsSync(cookieFile)) { const arr = JSON.parse(fs.readFileSync(cookieFile,'utf8')); if (Array.isArray(arr) && arr.length) { await page.setCookie(...arr); } } } catch {}
    }
    // Ensure base app and Cloudflare are cleared
    try { await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch {}
    await waitForCloudflare(page, timeoutMs);
    await loginIfNeeded(page, apolloEmail, apolloPassword, timeoutMs);
    try { await waitForSessionCookie(page, timeoutMs); } catch {}
    // Save cookies for future runs
    if (cookieFile) {
      try { const fs = require('fs'); const cookies = await page.cookies(); fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2)); } catch {}
    }
    for (const orgId of orgIds) {
      try { await scrapeOrg(page, orgId, timeoutMs, pages, seniorities, sortByField, sortAscending); } catch (e) { println({ type: 'stderr', source: 'apollo-contacts', message: String(e && (e.message || e)) }); }
    }
    println({ type: 'done', source: 'apollo-contacts' });
  } finally {
    try { await browser.close(); } catch {}
  }
  process.exit(0);
})();


