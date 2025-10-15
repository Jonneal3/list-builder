const tryRequire = (mod) => { try { return require(mod); } catch { return null; } };
const puppeteerExtra = tryRequire('puppeteer-extra');
const StealthPlugin = tryRequire('puppeteer-extra-plugin-stealth');
const puppeteerCore = tryRequire('puppeteer');

function getPuppeteer() {
  if (puppeteerExtra) return puppeteerExtra;
  if (puppeteerCore) return puppeteerCore;
  throw new Error('Puppeteer not installed');
}

async function launchBrowser(opts) {
  const puppeteer = getPuppeteer();
  if (puppeteer === puppeteerExtra && StealthPlugin) {
    try { puppeteerExtra.use(StealthPlugin()); } catch {}
  }
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US,en',
    '--window-size=1280,900',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (opts && opts.puppeteerProxy) args.push(`--proxy-server=${opts.puppeteerProxy}`);
  const launchOpts = {
    headless: Boolean(opts && opts.headless),
    args,
    defaultViewport: null,
    slowMo: Math.max(0, Number((opts && opts.slowMoMs) || 0)),
  };
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '';
  if (executablePath) launchOpts.executablePath = executablePath;
  const userDataDir = (opts && opts.userDataDir) ? String(opts.userDataDir) : (process.env.PUPPETEER_USER_DATA_DIR || '');
  if (userDataDir) launchOpts.userDataDir = userDataDir;
  const browser = await puppeteer.launch(launchOpts);
  const pages = (await browser.pages?.()) || [];
  const page = pages.length ? pages[0] : await browser.newPage();
  if (opts && opts.puppeteerProxyUser && opts.puppeteerProxyPass) {
    try { await page.authenticate({ username: String(opts.puppeteerProxyUser), password: String(opts.puppeteerProxyPass) }); } catch {}
  }
  if (opts && opts.rotateViewport) {
    try { await page.setViewport({ width: 1200 + Math.floor(Math.random()*200), height: 850 + Math.floor(Math.random()*150) }); } catch {}
  }
  try {
    const ua = String((opts && opts.userAgent) || process.env.PUPPETEER_UA || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setUserAgent(ua);
  } catch {}
  try { await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }); } catch {}
  try { await page.emulateTimezone('America/Los_Angeles'); } catch {}
  return { browser, page };
}

async function performEmailLogin(page, { email, password, pageTimeoutMs }) {
  const navTimeout = Math.max(8000, Math.min(60000, Number(pageTimeoutMs || 20000)));
  await page.goto('https://app.apollo.io/#/login', { waitUntil: 'domcontentloaded', timeout: navTimeout });
  try { await page.waitForSelector('input[name="email"]', { timeout: navTimeout }); } catch {}
  try { await page.waitForSelector('input[name="password"]', { timeout: navTimeout }); } catch {}
  try { await page.type('input[name="email"]', String(email || ''), { delay: 60 }); } catch {}
  try { await page.type('input[name="password"]', String(password || ''), { delay: 70 }); } catch {}
  try { await page.click('button[type="submit"]'); } catch {}
  // Wait for SPA to stabilize after submit (either navigation or app shell ready)
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: navTimeout }).catch(() => {}),
      page.waitForSelector('a[href*="#/companies"], a[href*="#/organizations/"]', { timeout: navTimeout }).catch(() => {}),
    ]);
  } catch {}
  // Extra small delay to allow app JS to mount
  try { await page.waitForTimeout(1200); } catch {}
  // Mirror legacy script: fixed wait after login submit
  try { await page.waitForTimeout(3000); } catch {}
}

async function waitForSessionCookie(page, pageTimeoutMs) {
  const navTimeout = Math.max(8000, Math.min(60000, Number(pageTimeoutMs || 20000)));
  const deadline = Date.now() + Math.max(120000, navTimeout);
  while (Date.now() < deadline) {
    try {
      const cookies = await page.cookies();
      const hasSession = cookies.some(c => (c.domain || '').includes('apollo.io') && c.name === '_leadgenie_session');
      if (hasSession) return true;
    } catch {}
    try { await page.waitForTimeout(1000); } catch {}
  }
  return false;
}

async function createApolloSession(opts = { apolloLogin: false, apolloEmail: null, apolloPassword: null, headless: true, pageTimeoutMs: 20000, rotateViewport: false, puppeteerProxy: null, puppeteerProxyUser: null, puppeteerProxyPass: null, cookieHeader: null, apolloManualLogin: false, slowMoMs: 0 }) {
  const { browser, page } = await launchBrowser(opts);
  const navTimeout = Math.max(8000, Math.min(60000, Number(opts.pageTimeoutMs || 20000)));
  const emitStatus = (obj) => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {} };

  async function waitForCloudflare(page, timeoutMs) {
    const deadline = Date.now() + Math.max(30000, Number(timeoutMs || 120000));
    let announced = false;
    while (Date.now() < deadline) {
      try {
        const hasChallenge = await page.evaluate(() => {
          const txt = (document.body && document.body.innerText) || '';
          const iframe = !!document.querySelector('iframe[src*="challenge"], iframe[src*="cloudflare"]');
          const btn = !!Array.from(document.querySelectorAll('button, input')).find(e => /verify|human|continue/i.test(e.textContent || e.value || ''));
          return iframe || /verify you are human|checking your browser/i.test(txt) || btn;
        });
        if (hasChallenge) {
          if (!announced) { emitStatus({ type: 'status', source: 'apollo', message: 'cf_challenge_detected' }); announced = true; }
          await page.waitForTimeout(1000);
          continue;
        }
        if (announced) emitStatus({ type: 'status', source: 'apollo', message: 'cf_challenge_cleared' });
        return true;
      } catch {}
      await page.waitForTimeout(1000);
    }
    emitStatus({ type: 'status', source: 'apollo', message: 'cf_challenge_timeout' });
    return false;
  }

  // Preload cookie header if provided and not using login
  let cookieHeader = String(opts.cookieHeader || '');
  if (cookieHeader && !opts.apolloLogin) {
    try {
      const parts = cookieHeader.split(';').map(s => s.trim()).filter(Boolean);
      const cookies = parts.map(p => {
        const eq = p.indexOf('=');
        if (eq === -1) return null;
        return { name: p.slice(0, eq).trim(), value: p.slice(eq+1).trim(), domain: 'app.apollo.io', path: '/' };
      }).filter(Boolean);
      if (cookies.length) await page.setCookie(...cookies);
    } catch {}
    try { await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: navTimeout }); } catch {}
    await waitForCloudflare(page, navTimeout);
  }

  // Manual login: open login page and let orchestrator coordinate confirmation
  if (opts.apolloLogin && opts.apolloManualLogin) {
    try { await page.goto('https://app.apollo.io/#/login', { waitUntil: 'domcontentloaded', timeout: navTimeout }); } catch {}
    await waitForCloudflare(page, navTimeout);
    return { browser, page, cookieHeader };
  }

  // Auto login: perform email/password if provided
  if (opts.apolloLogin && opts.apolloEmail && opts.apolloPassword) {
    await performEmailLogin(page, { email: opts.apolloEmail, password: opts.apolloPassword, pageTimeoutMs: navTimeout });
    await waitForSessionCookie(page, navTimeout);
    try { await page.goto('https://app.apollo.io/', { waitUntil: 'networkidle2', timeout: navTimeout }); } catch {}
    await waitForCloudflare(page, navTimeout);
    // Ensure we are on Companies list and wait for content markers
    try { await page.goto('https://app.apollo.io/#/companies', { waitUntil: 'networkidle2', timeout: navTimeout }); } catch {}
    try {
      await Promise.race([
        page.waitForSelector('tbody tr', { timeout: 6000 }).catch(() => {}),
        page.waitForSelector('a[href*="#/organizations/"]', { timeout: 6000 }).catch(() => {}),
      ]);
    } catch {}
    // Mirror legacy script: fixed wait after landing on companies
    try { await page.waitForTimeout(3000); } catch {}
  }

  return { browser, page, cookieHeader };
}

function buildBaseUrl(industry, apolloListUrl) {
  if (apolloListUrl) return apolloListUrl;
  const u = new URL('https://app.apollo.io/#/companies');
  if (industry) {
    u.searchParams.append('qOrganizationKeywordTags[]', industry);
    u.searchParams.append('includedOrganizationKeywordFields[]', 'tags');
    u.searchParams.append('includedOrganizationKeywordFields[]', 'name');
  }
  u.searchParams.append('page', '1');
  return u.toString();
}

async function simpleReadTotal(page) {
  return page.evaluate(() => {
    const parseNum = (s) => {
      const m = String(s || '').replace(/[,.]/g, '').match(/(\d{1,7})/);
      return m ? parseInt(m[1], 10) : null;
    };
    const a = Array.from(document.querySelectorAll('a')).find(e => (e.textContent || '').trim().toLowerCase().startsWith('total'));
    if (a) return parseNum(a.textContent || '');
    const any = Array.from(document.querySelectorAll('*')).find(e => /\btotal\b/i.test(e.textContent || ''));
    if (any) {
      const m = (any.textContent || '').match(/total[^\d]*([\d,.]+)/i) || (any.textContent || '').match(/([\d,.]+)\s*total/i);
      if (m) return parseNum(m[1]);
    }
    return null;
  });
}

async function scrapeApolloWithSession(page, industry, city, opts = { pageTimeoutMs: 20000, uiPages: 5, apolloListUrl: null, onDebug: null }) {
  const debug = (e) => { try { if (opts && typeof opts.onDebug === 'function') opts.onDebug(e); } catch {} };
  const navTimeout = Math.max(8000, Math.min(60000, Number(opts.pageTimeoutMs || 20000)));
  const baseUrl = buildBaseUrl(industry, opts.apolloListUrl);

  debug({ info: 'filtered_nav_start', url: baseUrl });
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: navTimeout });
  debug({ info: 'filtered_nav_done', url: baseUrl });
  try { await page.waitForTimeout(1000); } catch {}
  // Additional grace period to mimic working script
  try { await page.waitForTimeout(3000); } catch {}

  const totalCount = await simpleReadTotal(page);
  debug({ info: 'total_count_simple', totalCount });

  const itemsPerPage = 25;
  // Scrape ALL pages like the reference script (no 5-page cap)
  const totalPages = totalCount ? Math.ceil(totalCount / itemsPerPage) : Math.max(1, Number(opts.uiPages || 5));

  const rows = [];
  const unique = new Set();

  for (let i = 1; i <= totalPages; i += 1) {
    const pageUrl = baseUrl.includes('page=') ? baseUrl.replace(/([?&])page=\d+/, `$1page=${i}`) : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${i}`;
    debug({ info: 'simple_page_nav', page: i, url: pageUrl });
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: navTimeout });
    let hadTbody = false;
    try { await page.waitForSelector('tbody', { timeout: 6000 }); hadTbody = true; } catch {}
    if (!hadTbody) {
      try { await page.waitForSelector('a[href*="#/organizations/"]', { timeout: 6000 }); } catch {}
    }
    // Small fixed wait to allow rows to render
    try { await page.waitForTimeout(1200); } catch {}

    const pageItems = await page.evaluate(() => {
      const out = [];
      const tableRows = Array.from(document.querySelectorAll('tbody tr'));
      const extractFromRow = (tr) => {
        const td = (n) => tr.querySelector(`td:nth-child(${n})`);
        const nameCell = td(3) || tr;
        const locCell = td(5);
        const empCell = td(6);
        const phoneCell = td(7);
        const indCell = td(8);
        const companyName = String(nameCell?.textContent || '').trim();
        let companyUrl = '';
        const linksName = nameCell ? nameCell.querySelectorAll('a[href]') : [];
        for (const a of linksName) {
          const href = String(a.getAttribute('href') || '').trim();
          if (/^https?:\/\//i.test(href) && !/apollo\.io|linkedin\.com\/in/i.test(href)) { companyUrl = href; break; }
        }
        const location = String(locCell?.textContent || '').trim();
        const employeeCount = String(empCell?.textContent || '').trim();
        const phone = String((phoneCell?.textContent || '').replace(/\D/g, ''));
        const industry = String(indCell?.textContent || '').trim();
        const firstAnchor = tr.querySelector('a[href*="#/organizations/"]') || tr.querySelector('a[href]');
        const profileUrl = firstAnchor ? String(firstAnchor.href) : '';
        if (companyName || companyUrl || profileUrl) {
          out.push({ companyName, companyUrl, location, employeeCount, phone, industry, profileUrl });
        }
      };
      if (tableRows.length > 0) {
        for (const tr of tableRows) extractFromRow(tr);
      } else {
        // Fallback: derive from organization profile anchors on the page
        const anchors = Array.from(document.querySelectorAll('a[href*="#/organizations/"]'));
        for (const a of anchors) {
          const tr = a.closest('tr');
          if (tr) { extractFromRow(tr); continue; }
          const companyName = String(a.textContent || '').trim();
          const profileUrl = String(a.href || '');
          // Attempt to find an external website link nearby
          let companyUrl = '';
          const rowLinks = Array.from(a.parentElement?.querySelectorAll('a[href]') || []);
          for (const ln of rowLinks) {
            const href = String(ln.getAttribute('href') || '').trim();
            if (/^https?:\/\//i.test(href) && !/apollo\.io|linkedin\.com\/in/i.test(href)) { companyUrl = href; break; }
          }
          out.push({ companyName, companyUrl, location: '', employeeCount: '', phone: '', industry: '', profileUrl });
        }
      }
      return out;
    });
    debug({ info: 'simple_page_items', page: i, count: pageItems.length });

    for (const it of pageItems) {
      const key = `${(it.companyName || '').toLowerCase()}-${(it.companyUrl || '').toLowerCase()}-${(it.profileUrl || '').toLowerCase()}`;
      if (unique.has(key)) continue;
      unique.add(key);
      rows.push({
        name: it.companyName || null,
        website: it.companyUrl || null,
        phone: it.phone || null,
        address: null,
        categories: industry ? [industry] : null,
        method: 'apollo-simple',
        fallback_used: false,
        _profileUrl: it.profileUrl || null,
      });
    }
    debug({ info: 'simple_page_added', page: i, total: rows.length });
  }

  // Email enrichment: visit profile URLs in batches and extract emails (like reference script)
  const candidates = rows.filter(r => r && r._profileUrl);
  const batchSize = 5;
  debug({ info: 'enrich_start', count: candidates.length, batchSize });
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    await Promise.all(batch.map(async (rec) => {
      let p = null;
      try {
        p = await page.browser().newPage();
        const cleaned = String(rec._profileUrl || '').replace(/"/g, '');
        await p.goto(cleaned, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        // Try best-effort: wait for general info card, but don't fail hard
        try { await p.waitForSelector('#general_information_card', { timeout: 10000 }); } catch {}
        const text = await p.evaluate(() => {
          const sel = document.querySelector('#general_information_card');
          return sel ? sel.innerText : document.body?.innerText || '';
        });
        const emails = Array.from(String(text).match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) || []);
        if (emails.length > 0) {
          rec.email = emails[0];
          rec._emails = emails; // keep all, first used for DB
        }
      } catch (e) {
        // ignore enrichment errors per spec
      } finally {
        try { if (p) await p.close(); } catch {}
      }
    }));
    debug({ info: 'enrich_batch_done', start: i, end: Math.min(i + batchSize - 1, candidates.length - 1) });
  }

  debug({ info: 'return_rows', rows: rows.length });
  return rows;
}

async function crawlApollo(industry, city, opts = { limit: 50, perPage: 25, cookieHeader: null, onDebug: null, apolloLogin: false, apolloEmail: null, apolloPassword: null, headless: true, pageTimeoutMs: 20000, rotateViewport: false, puppeteerProxy: null, puppeteerProxyUser: null, puppeteerProxyPass: null, apolloListUrl: null, uiPages: 5, slowMoMs: 0, apolloManualLogin: false }) {
  const debug = (e) => { try { if (opts && typeof opts.onDebug === 'function') opts.onDebug(e); } catch {} };
  const { browser, page } = await launchBrowser(opts);
  try {
    if (opts.apolloLogin && opts.apolloEmail && opts.apolloPassword) {
      await performEmailLogin(page, { email: opts.apolloEmail, password: opts.apolloPassword, pageTimeoutMs: opts.pageTimeoutMs });
      await waitForSessionCookie(page, opts.pageTimeoutMs);
    }
    const rows = await scrapeApolloWithSession(page, industry, city, opts);
    debug({ info: 'return_rows', rows: rows.length });
    return { rows, total: rows.length };
  } finally {
    try { await page.close(); } catch {}
    try { await (await page.browser()).close(); } catch {}
  }
}

async function closeApolloSession(sess) {
  if (!sess) return;
  try { await sess.page.close(); } catch {}
  try { await sess.browser.close(); } catch {}
}

module.exports = { crawlApollo, createApolloSession, scrapeApolloWithSession, closeApolloSession };