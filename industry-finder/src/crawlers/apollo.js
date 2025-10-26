const tryRequire = (mod) => { try { return require(mod); } catch { return null; } };
const puppeteerExtra = tryRequire('puppeteer-extra');
const StealthPlugin = tryRequire('puppeteer-extra-plugin-stealth');
const puppeteerCore = tryRequire('puppeteer');

function getPuppeteer() {
  if (puppeteerExtra) return puppeteerExtra;
  if (puppeteerCore) return puppeteerCore;
  throw new Error('Puppeteer not installed');
}

function rand(min, max) {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

async function humanPause(page, minMs = 300, maxMs = 900) {
  try { await new Promise(resolve => setTimeout(resolve, rand(minMs, maxMs))); } catch {}
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
    // Loosen cookie restrictions (helps SPA auth flows)
    '--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,PartitionedCookies,BlockInsecurePrivateNetworkRequests',
    '--allow-third-party-cookies',
  ];
  if (opts && opts.puppeteerProxy) args.push(`--proxy-server=${opts.puppeteerProxy}`);
  const launchOpts = {
    headless: Boolean(opts && opts.headless),
    args,
    defaultViewport: null,
    slowMo: Math.max(0, Number((opts && opts.slowMoMs != null) ? opts.slowMoMs : (!opts || opts.headless ? 0 : 120))),
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
  
  try {
  await page.goto('https://app.apollo.io/#/login', { waitUntil: 'domcontentloaded', timeout: navTimeout });
    await humanPause(page, 600, 1200);
    
    // Wait for login form elements to be available
    try { 
      await page.waitForSelector('input[name="email"]', { timeout: navTimeout }); 
    } catch (e) {
      console.log('Email input not found, trying alternative selectors');
      try { await page.waitForSelector('input[type="email"]', { timeout: 5000 }); } catch {}
    }
    
    try { 
      await page.waitForSelector('input[name="password"]', { timeout: navTimeout }); 
    } catch (e) {
      console.log('Password input not found, trying alternative selectors');
      try { await page.waitForSelector('input[type="password"]', { timeout: 5000 }); } catch {}
    }
    
    // If Google SSO is present and email looks like Gmail, try Google auth first
    let usedGoogle = false;
    try {
      const isGmail = /@gmail\.com$/i.test(String(email || ''));
      const [googleBtn] = await page.$x("//button[contains(., 'Google')] | //a[contains(., 'Google')] | //div[contains(., 'Sign in with Google')]");
      if (isGmail && googleBtn) {
        console.log('Attempting Google OAuth login');
        try { await googleBtn.click(); } catch {}
        await humanPause(page, 800, 1500);
        // Google auth flow
        try { await page.waitForSelector('input[type="email"]', { timeout: navTimeout }); } catch {}
        try { await page.type('input[type="email"]', String(email || ''), { delay: 120 }); } catch {}
        await humanPause(page, 400, 900);
        try {
          const next1 = await page.$('#identifierNext, button:has-text("Next")');
          if (next1) { await next1.click(); }
        } catch {}
        await humanPause(page, 800, 1500);
        try { await page.waitForSelector('input[type="password"]', { timeout: navTimeout }); } catch {}
        try { await page.type('input[type="password"]', String(password || ''), { delay: 140 }); } catch {}
        await humanPause(page, 500, 1000);
        try {
          const next2 = await page.$('#passwordNext, button:has-text("Next")');
          if (next2) { await next2.click(); }
        } catch {}
        usedGoogle = true;
        console.log('Google OAuth login completed');
      }
    } catch (e) {
      console.log('Google OAuth failed, falling back to regular login:', e.message);
    }

    if (!usedGoogle) {
      console.log('Attempting regular email/password login');
      try { await page.type('input[name="email"]', String(email || ''), { delay: 120 }); } catch {}
      await humanPause(page, 250, 600);
      try { await page.type('input[name="password"]', String(password || ''), { delay: 140 }); } catch {}
      await humanPause(page, 300, 700);
  try { await page.click('button[type="submit"]'); } catch {}
      console.log('Login form submitted');
    }
    
    // Wait for SPA to stabilize after submit (either navigation or app shell ready)
    console.log('Waiting for login to complete...');
    try {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: navTimeout }).catch(() => {}),
        page.waitForSelector('a[href*="#/companies"], a[href*="#/organizations/"]', { timeout: navTimeout }).catch(() => {}),
      ]);
    } catch (e) {
      console.log('Navigation wait failed, continuing anyway:', e.message);
    }
    
    // Extra small delay to allow app JS to mount
    try { await new Promise(resolve => setTimeout(resolve, 1200)); } catch {}
    // Mirror legacy script: fixed wait after login submit
    try { await new Promise(resolve => setTimeout(resolve, 3000)); } catch {}
    
    console.log('Login process completed');
    
  } catch (error) {
    console.log('Login error:', error.message);
    throw error;
  }
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
    try { await new Promise(resolve => setTimeout(resolve, 1000)); } catch {}
  }
  return false;
}

// Apply Employee Range via URL hash params (no full reload, avoids Cloudflare)
async function applyEmployeeRangeUI(page, rangeStr, timeoutMs, debug) {
  const navTimeout = Math.max(5000, Math.min(30000, Number(timeoutMs || 10000)));
  const parseRange = (s) => {
    const parts = String(s || '').split(',');
    let min = parts[0] ? parseInt(parts[0], 10) : null;
    let max = parts[1] ? parseInt(parts[1], 10) : null;
    if (!Number.isFinite(min)) min = null;
    if (!Number.isFinite(max)) max = null;
    return { min, max };
  };
  const { min, max } = parseRange(rangeStr);
  try { if (typeof debug === 'function') debug({ info: 'ui_set_emp_start', min, max, range: rangeStr }); } catch {}
  try {
    await page.evaluate(({ min, max }) => {
      const ensureCompaniesPath = (path) => (path && path.startsWith('/companies')) ? path : '/companies';
      const current = new URL(window.location.href);
      // Parse params from hash segment (Apollo SPA uses hash routing)
      const hash = current.hash.replace(/^#/, '');
      const idx = hash.indexOf('?');
      const path = ensureCompaniesPath(idx === -1 ? hash : hash.slice(0, idx));
      const qs = idx === -1 ? '' : hash.slice(idx + 1);
      const sp = new URLSearchParams(qs);
      // Remove existing employee range filters
      const toDelete = [];
      sp.forEach((v, k) => { if (k === 'organizationNumEmployeesRanges[]') toDelete.push(k); });
      for (const k of toDelete) sp.delete(k);
      // Set new range and reset to page 1
      const rangeVal = `${min == null ? '' : String(min)},${max == null ? '' : String(max)}`;
      sp.append('organizationNumEmployeesRanges[]', rangeVal);
      sp.set('page', '1');
      // Write back into hash without full reload
      const nextHash = `${path}?${sp.toString()}`;
      if (('#' + nextHash) !== window.location.hash) {
        history.pushState({}, '', '#' + nextHash);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    }, { min, max });
  } catch {}
  // Wait for SPA to update list (pager text or table rows)
  try {
    const deadline = Date.now() + navTimeout;
    let lastText = '';
    while (Date.now() < deadline) {
      const txt = await page.evaluate(() => {
        const el = document.querySelector('[data-interaction-boundary="Table Pagination"] [class*="zp_tMpqI"]');
        return el ? (el.textContent || '').trim() : '';
      });
      if (txt && txt !== lastText) break;
      lastText = txt;
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {}
  try { if (typeof debug === 'function') debug({ info: 'ui_set_emp_done', min, max }); } catch {}
}

async function createApolloSession(opts = { apolloLogin: false, apolloEmail: null, apolloPassword: null, headless: true, pageTimeoutMs: 20000, rotateViewport: false, puppeteerProxy: null, puppeteerProxyUser: null, puppeteerProxyPass: null, cookieHeader: null, apolloManualLogin: false, slowMoMs: 0 }) {
  const { browser, page } = await launchBrowser(opts);
  const navTimeout = Math.max(8000, Math.min(60000, Number(opts.pageTimeoutMs || 20000)));
  const emitStatus = (obj) => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {} };
  const cookieFile = process.env.APOLLO_COOKIES_JSON || '';

  // Network diagnostics: log 4xx/5xx and failed requests for Apollo/Cloudflare
  try {
    const importantHeaderKeys = ['server','cf-ray','cf-cache-status','vary','set-cookie','content-type','x-frame-options','x-cache','x-amz-cf-id'];
    const pickHeaders = (headersObj) => {
      const out = {};
      try { for (const k of importantHeaderKeys) if (headersObj[k] != null) out[k] = headersObj[k]; } catch {}
      return out;
    };
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (!/apollo\.io|cloudflare|googleapis|gstatic/i.test(url)) return;
        const status = resp.status();
        if (status >= 400) {
          let bodySnippet = '';
          try {
            const ct = resp.headers()['content-type'] || '';
            if (/text|json|html/i.test(ct)) {
              const text = await resp.text();
              bodySnippet = String(text || '').slice(0, 500);
            }
          } catch {}
          emitStatus({ type: 'debug', source: 'apollo', info: 'http_response', status, url, headers: pickHeaders(resp.headers()), bodySnippet });
        }
      } catch {}
    });
    page.on('requestfailed', (req) => {
      try { 
        const url = req.url();
        const error = (req.failure() && req.failure().errorText) || 'unknown';
        
        // Filter out common harmless errors that clutter the logs
        const shouldIgnore = 
          url.includes('chrome-extension://invalid/') ||
          url.includes('chrome-extension://') ||
          url.includes('px.ads.linkedin.com') ||
          url.includes('sentry.io/api/') ||
          url.includes('wowscale.com') ||
          url.includes('intercom.io') ||
          url.includes('fullview.io') ||
          error === 'net::ERR_ABORTED' ||
          error === 'net::ERR_FAILED';
        
        if (!shouldIgnore) {
          emitStatus({ type: 'debug', source: 'apollo', info: 'request_failed', url, error });
        }
      } catch {}
    });
  } catch {}

  // Load persisted cookies before hitting the site
  if (cookieFile) {
    try {
      const fs = require('fs');
      const path = require('path');
      const abs = path.isAbsolute(cookieFile) ? cookieFile : path.join(process.cwd(), cookieFile);
      if (fs.existsSync(abs)) {
        const arr = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (Array.isArray(arr) && arr.length) {
          try { await page.setCookie(...arr); } catch {}
        }
      }
    } catch {}
  }

  async function waitForCloudflare(page, timeoutMs) {
    const deadline = Date.now() + Math.max(30000, Number(timeoutMs || 120000));
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
      if (clicked) { emitStatus({ type: 'status', source: 'apollo', message: 'cf_challenge_click' }); lastClickTs = Date.now(); }
      return clicked;
    };
    while (Date.now() < deadline) {
      try {
        // Detect challenge and try to interact if present
        const result = await page.evaluate(() => {
          const txt = (document.body && document.body.innerText) || '';
          const iframe = document.querySelector('iframe[src*="challenge"], iframe[src*="cloudflare"], iframe[src*="turnstile"]');
          const btn = Array.from(document.querySelectorAll('button, input, div[role="button"]')).find(e => /verify|human|continue|check|i am human/i.test((e.textContent || e.getAttribute('aria-label') || e.getAttribute('value') || '').trim()));
          const has = Boolean(iframe || /verify you are human|checking your browser|just a moment/i.test(txt) || btn);
          return { has, hasIframe: Boolean(iframe), hasBtn: Boolean(btn) };
        });
        if (result && result.has) {
          if (!announced) { emitStatus({ type: 'status', source: 'apollo', message: 'cf_challenge_detected' }); announced = true; }
          // Retry click every ~1.5s while challenge persists
          if (Date.now() - lastClickTs > 1500) { await tryClickChallenge(); }
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        if (announced) emitStatus({ type: 'status', source: 'apollo', message: 'cf_challenge_cleared' });
        return true;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    emitStatus({ type: 'status', source: 'apollo', message: 'cf_challenge_timeout' });
    return false;
  }

  // Preload cookie header if provided and not using login
  let cookieHeader = String(opts.cookieHeader || '');

  // Optional: try Unflare service to solve Cloudflare and return cookies/headers
  // Enable with ENABLE_UNFLARE=true and provide UNFLARE_URL
  if (!cookieHeader && process.env.UNFLARE_URL && String(process.env.ENABLE_UNFLARE || 'false').toLowerCase() === 'true') {
    try {
      const { requestUnflare } = require('../utils/unflare');
      const json = await requestUnflare({
        url: 'https://app.apollo.io/#/companies',
        timeout: Math.max(30000, navTimeout),
        proxy: opts && opts.puppeteerProxy ? {
          host: String(opts.puppeteerProxy),
          port: Number((opts.puppeteerProxy || '').split(':')[1] || 0) || undefined,
          username: opts.puppeteerProxyUser,
          password: opts.puppeteerProxyPass,
        } : undefined,
        apiUrl: process.env.UNFLARE_URL,
        apiKey: process.env.UNFLARE_API_KEY,
      });
      
      // Check for error response
      if (json.code === 'error') {
        emitStatus({ type: 'debug', source: 'apollo', info: 'unflare_error', message: json.message });
      } else if (json && Array.isArray(json.cookies) && json.cookies.length) {
        // Set cookies from Unflare response
        try { 
          await page.setCookie(...json.cookies); 
          emitStatus({ type: 'debug', source: 'apollo', info: 'unflare_cookies_set', count: json.cookies.length }); 
        } catch (cookieError) {
          emitStatus({ type: 'debug', source: 'apollo', info: 'unflare_cookie_error', error: String(cookieError.message || cookieError) });
        }
        
        // Also set headers if provided
        if (json.headers && typeof json.headers === 'object') {
          try {
            await page.setExtraHTTPHeaders(json.headers);
            emitStatus({ type: 'debug', source: 'apollo', info: 'unflare_headers_set' });
          } catch (headerError) {
            emitStatus({ type: 'debug', source: 'apollo', info: 'unflare_header_error', error: String(headerError.message || headerError) });
          }
        }
      } else {
        emitStatus({ type: 'debug', source: 'apollo', info: 'unflare_no_cookies', response: JSON.stringify(json).substring(0, 200) });
      }
    } catch (e) {
      emitStatus({ type: 'debug', source: 'apollo', info: 'unflare_failed', error: String(e && (e.message || e)) });
    }
  }
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
    try {
    await performEmailLogin(page, { email: opts.apolloEmail, password: opts.apolloPassword, pageTimeoutMs: navTimeout });
    await waitForSessionCookie(page, navTimeout);
      
      // Navigate to main app
      try { 
        await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: navTimeout }); 
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        console.log('Failed to navigate to main app, retrying...');
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeout }); } catch {}
      }
      
      await waitForCloudflare(page, navTimeout);
      
      // Ensure we are on Companies list and wait for content markers
      try { 
        await page.goto('https://app.apollo.io/#/companies', { waitUntil: 'domcontentloaded', timeout: navTimeout }); 
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        console.log('Failed to navigate to companies page, retrying...');
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeout }); } catch {}
      }
      
      try {
        await Promise.race([
          page.waitForSelector('tbody tr', { timeout: 8000 }).catch(() => {}),
          page.waitForSelector('a[href*="#/organizations/"]', { timeout: 8000 }).catch(() => {}),
        ]);
      } catch {}
      
      // Mirror legacy script: fixed wait after landing on companies
      try { await new Promise(resolve => setTimeout(resolve, 3000)); } catch {}

      // Persist cookies for future runs
      if (cookieFile) {
        try {
          const fs = require('fs');
          const cookies = await page.cookies();
          fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
          console.log('Cookies saved to:', cookieFile);
        } catch (e) {
          console.log('Failed to save cookies:', e.message);
        }
      }
      
      console.log('Apollo session created successfully');
      
    } catch (error) {
      console.log('Apollo session creation failed:', error.message);
      throw error;
    }
  }

  return { browser, page, cookieHeader };
}

function buildBaseUrl(industry, apolloListUrl) {
  if (apolloListUrl) {
    try {
      // Ensure we always start at page=1 even if incoming URL specifies another page
      const raw = String(apolloListUrl).trim();
      const url = new URL(raw.startsWith('http') ? raw : `https://app.apollo.io/${raw.replace(/^#\/?/, '')}`);
      // If hash contains companies path and query, reconstruct search params from it
      if (url.hash && url.hash.includes('/companies')) {
        // Parse the hash portion as its own URL to normalize page
        const hashStr = url.hash.replace(/^#/, '');
        const hashUrl = new URL(hashStr.startsWith('http') ? hashStr : `https://app.apollo.io/${hashStr.replace(/^\/?/, '')}`);
        hashUrl.searchParams.set('page', '1');
        return `https://app.apollo.io/#${hashUrl.pathname}${hashUrl.search}`;
      }
      // Fallback: operate on normal search params
      url.searchParams.set('page', '1');
      return url.toString();
    } catch {
      // If anything fails, fall back to the provided string
      return apolloListUrl;
    }
  }
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
  try {
    const result = await page.evaluate(() => {
      console.log('Looking for total count...');
    const parseNum = (s) => {
      const m = String(s || '').replace(/[,.]/g, '').match(/(\d{1,7})/);
      return m ? parseInt(m[1], 10) : null;
    };
    const a = Array.from(document.querySelectorAll('a')).find(e => (e.textContent || '').trim().toLowerCase().startsWith('total'));
      if (a) {
        console.log('Found total in link:', a.textContent);
        return parseNum(a.textContent || '');
      }
    const any = Array.from(document.querySelectorAll('*')).find(e => /\btotal\b/i.test(e.textContent || ''));
    if (any) {
        console.log('Found total in element:', any.textContent);
      const m = (any.textContent || '').match(/total[^\d]*([\d,.]+)/i) || (any.textContent || '').match(/([\d,.]+)\s*total/i);
      if (m) return parseNum(m[1]);
    }
      console.log('No total found');
      return null;
    });
    console.log('Total count result:', result);
    return result;
  } catch (error) {
    console.log('Error reading total count:', error.message);
    return null;
  }
}

// Read the total count and wait until it stabilizes (does not change between reads)
async function waitForStableTotalCount(page, timeoutMs) {
  const deadline = Date.now() + Math.max(5000, Math.min(30000, Number(timeoutMs || 8000)));
  let last = 0;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const curr = await simpleReadTotal(page);
    if (curr && curr === last) {
      stableReads += 1;
      if (stableReads >= 2) return curr; // same value twice in a row
    } else {
      stableReads = 0;
    }
    last = curr || last;
    try { await new Promise(r => setTimeout(r, 500)); } catch {}
  }
  return last || 0;
}

async function simpleReadTotal(page) {
  try {
    const text = await page.evaluate(() => {
      // 1) Prefer the header "Total" chip counter (e.g., 2.3K)
      // Locate any element that includes the word "Total" and has a nearby [data-count-size] number
      const containers = Array.from(document.querySelectorAll('label, div, span'));
      for (const el of containers) {
        const txt = (el.textContent || '').trim();
        if (/\bTotal\b/i.test(txt)) {
          const countEl = el.querySelector('[data-count-size]');
          const val = countEl && (countEl.textContent || '').trim();
          if (val && /\d/.test(val)) return `of ${val}`; // normalize to "of X" form for downstream parsing
        }
      }

      // 2) Footer counter like: "1 - 25 of 2,237"
      const footer = document.querySelector('[data-interaction-boundary="Table Pagination"] [class*="zp_tMpqI"]');
      if (footer && footer.textContent) return footer.textContent.trim();

      // 3) Generic fallback: any element containing " of " and a number
      const all = Array.from(document.querySelectorAll('div, span'));
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (/\bof\b/.test(t) && /\d/.test(t)) return t;
      }

      // 4) Last resort: any standalone chip-looking number with optional K/M
      const chips = Array.from(document.querySelectorAll('[data-count-size], span'));
      for (const s of chips) {
        const t = (s.textContent || '').trim();
        if (/^\d{1,3}(?:[.,]\d+)?[KM]?$/.test(t)) return `of ${t}`;
      }
      return '';
    });
    if (!text) return 0;
    // Extract trailing count: handles "1 - 25 of 2,237", "of 2.3K", or plain numbers
    const m1 = text.match(/\bof\s+([0-9][0-9,\.]*\s*[KM]?)/i);
    let raw = m1 ? m1[1] : text;
    raw = String(raw).replace(/,/g, '').trim();
    let mult = 1;
    if (/K$/i.test(raw)) { mult = 1000; raw = raw.replace(/K$/i, ''); }
    if (/M$/i.test(raw)) { mult = 1_000_000; raw = raw.replace(/M$/i, ''); }
    const num = parseFloat(raw);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.round(num * mult));
  } catch {
    return 0;
  }
}

async function scrapeApolloWithSession(page, industry, city, opts = { pageTimeoutMs: 20000, uiPages: 5, apolloListUrl: null, onDebug: null }) {
  const debug = (e) => { try { if (opts && typeof opts.onDebug === 'function') opts.onDebug(e); } catch {} };
  const navTimeout = Math.max(8000, Math.min(60000, Number(opts.pageTimeoutMs || 20000)));
  const baseUrl = buildBaseUrl(industry, opts.apolloListUrl);

  // Optional: skip navigation to reuse current page when UI already positioned
  if (!(opts && opts.skipNavigate)) {
    debug({ info: 'filtered_nav_start', url: baseUrl });
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      try { await waitForCloudflare(page, navTimeout); } catch {}
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        await page.waitForFunction(() => {
          const loading = document.querySelector('[data-testid="loading"], .loading, .spinner');
          return !loading || loading.style.display === 'none';
        }, { timeout: 5000 });
      } catch {}
    } catch (error) {
      debug({ info: 'navigation_error', error: error.message, url: baseUrl });
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeout });
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (retryError) {
        debug({ info: 'navigation_retry_failed', error: retryError.message });
      }
    }
    debug({ info: 'filtered_nav_done', url: baseUrl });
  } else {
    debug({ info: 'skip_nav', url: baseUrl });
  }
  // Ensure paginator starts at page 1 before any extraction
  try {
    const resetToFirstPage = async () => {
      try {
        const used = await page.evaluate(() => {
          const root = document.querySelector('[data-interaction-boundary="Table Pagination"]') || document;
          const firstBtn = root.querySelector('button[aria-label="First"]');
          if (firstBtn) {
            const htmlBtn = firstBtn;
            if (!(htmlBtn).hasAttribute('disabled')) {
              (htmlBtn).dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return 'first';
            }
          }
          const prevBtn = root.querySelector('button[aria-label="Previous"]');
          if (prevBtn && !(prevBtn).hasAttribute('disabled')) {
            (prevBtn).dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return 'prev';
          }
          return '';
        });
        if (used) {
          const before = await (async () => {
            try {
              const el = await page.evaluate(() => {
                const e = document.querySelector('[data-interaction-boundary="Table Pagination"] [class*="zp_tMpqI"]');
                return e ? (e.textContent || '').trim() : '';
              });
              return el;
            } catch { return ''; }
          })();
          try {
            await page.waitForFunction((prev) => {
              const el = document.querySelector('[data-interaction-boundary="Table Pagination"] [class*="zp_tMpqI"]');
              const t = el ? (el.textContent || '').trim() : '';
              return t && t !== prev && /^1\s*-\s*\d+\s*of\s*/i.test(t);
            }, { timeout: 8000 }, before);
          } catch {}
          await new Promise(r => setTimeout(r, 400));
        }
      } catch {}
    };
    await resetToFirstPage();
  } catch {}

  try {
    const urlNow = page.url();
    if (opts && opts.apolloListUrl && typeof opts.onDebug === 'function') {
      const totalCount = await waitForStableTotalCount(page, navTimeout);
      debug({ info: 'planned_base_total', total: totalCount });
      try { opts.onDebug({ info: 'us_goal_total', total: totalCount }); } catch {}
    }
  } catch {}

  // If provided, apply employee range via UI
  if (opts && opts.setEmployeeRange != null) {
    await applyEmployeeRangeUI(page, opts.setEmployeeRange, navTimeout, debug);
    // After applying a bucket filter, reset to page 1 so the UI page never carries over
    try {
      const resetToFirstPage = async () => {
        try {
          const prevUsed = await page.evaluate(() => {
            const root = document.querySelector('[data-interaction-boundary="Table Pagination"]') || document;
            const firstBtn = root.querySelector('button[aria-label="First"]');
            if (firstBtn) {
              const htmlBtn = firstBtn;
              if (!(htmlBtn).hasAttribute('disabled')) {
                (htmlBtn).dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return 'first';
              }
            }
            const prevBtn = root.querySelector('button[aria-label="Previous"]');
            if (prevBtn && !(prevBtn).hasAttribute('disabled')) {
              (prevBtn).dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return 'prev';
            }
            return '';
          });
          if (prevUsed) {
            try {
              await page.waitForFunction(() => {
                const el = document.querySelector('[data-interaction-boundary="Table Pagination"] [class*="zp_tMpqI"]');
                const t = el ? (el.textContent || '').trim() : '';
                return /^1\s*-\s*\d+\s*of\s*/i.test(t);
              }, { timeout: 8000 });
            } catch {}
            await new Promise(r => setTimeout(r, 300));
          }
        } catch {}
      };
      await resetToFirstPage();
    } catch {}
  }

  try {
    const pageTitle = await page.title();
    const pageUrl = page.url();
    debug({ info: 'page_state', title: pageTitle, url: pageUrl });
  } catch (e) {
    debug({ info: 'page_state_error', error: e.message });
  }

  const totalCount = await waitForStableTotalCount(page, navTimeout);
  debug({ info: 'total_count_simple', totalCount });

  if (opts && opts.countOnly) {
    return [];
  }

  const rows = [];
  const unique = new Set();

  // In-page pagination using Next button to avoid SPA ignoring URL params
  const getFooterText = async () => {
    try {
      return await page.evaluate(() => {
        const el = document.querySelector('[class*="zp_l0qux"] [class*="zp_tMpqI"]');
        return el ? (el.textContent || '').trim() : '';
      });
    } catch { return ''; }
  };
  const getCurrentUiPage = async () => {
    try {
      return await page.evaluate(() => {
        const footer = document.querySelector('[data-interaction-boundary="Table Pagination"] [class*="zp_tMpqI"]');
        const t = footer ? (footer.textContent || '').trim() : '';
        // Common formats:
        //  "1 - 25 of 1,234"   → page = 1
        //  "26 - 50 of 1,234"  → page = 2
        //  "51 - 75 of 1,234"  → page = 3
        const m = t.match(/^(\d+)\s*-\s*(\d+)\s*of\s*(\d+)/i);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = parseInt(m[2], 10);
          const perPage = Math.max(1, (end - start + 1));
          const page = Math.max(1, Math.floor((start - 1) / perPage) + 1);
          return page;
        }
        // Fallback: if it only starts with a number, assume page 1
        return 1;
      });
    } catch { return 1; }
  };
  const gotoNextPage = async () => {
    const before = await getFooterText();
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('[data-interaction-boundary="Table Pagination"] button[aria-label="Next"]');
      const htmlBtn = btn;
      if (htmlBtn && !(htmlBtn).hasAttribute('disabled')) {
        (htmlBtn).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }
      return false;
    });
    if (!clicked) return false;
    try {
      await page.waitForFunction((prev) => {
        const el = document.querySelector('[class*="zp_l0qux"] [class*="zp_tMpqI"]');
        const t = el ? (el.textContent || '').trim() : '';
        return t && t !== prev;
      }, { timeout: 15000 }, before);
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
    return true;
  };

  let i = 1;
  let safetyPages = 200;
  const maxPages = Math.max(1, Number((opts && opts.uiPages) || 5));
  while (safetyPages-- > 0) {
    debug({ info: 'starting_page_evaluation', page: i, label: opts && opts.label ? opts.label : undefined });
    // Runtime guard: never exceed page 5 in UI
    try {
      const uiPos = await getCurrentUiPage();
      if (uiPos > 5) {
        debug({ info: 'ui_page_cap_hit', page: uiPos });
        break;
      }
    } catch {}
    
    let pageItems = [];
    try {
      pageItems = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const pushUnique = (rec) => {
        const key = String((rec && (rec.profileUrl || rec.companyUrl || rec.companyName)) || '').toLowerCase();
        if (!key) return;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(rec);
      };
      
      console.log('Starting Apollo data extraction...');
      console.log('Page title:', document.title);
      console.log('Page URL:', window.location.href);
      
      // Debug: Check what elements are actually present
      console.log('=== PAGE STRUCTURE DEBUG ===');
      console.log('All tbody elements:', document.querySelectorAll('tbody').length);
      console.log('All table elements:', document.querySelectorAll('table').length);
      console.log('All tr elements:', document.querySelectorAll('tr').length);
      console.log('All a[href*="#/organizations/"] elements:', document.querySelectorAll('a[href*="#/organizations/"]').length);
      console.log('All a[href*="apollo.io"] elements:', document.querySelectorAll('a[href*="apollo.io"]').length);
      console.log('All [data-testid*="company"] elements:', document.querySelectorAll('[data-testid*="company"]').length);
      console.log('All [class*="company"] elements:', document.querySelectorAll('[class*="company"]').length);
      console.log('All [class*="organization"] elements:', document.querySelectorAll('[class*="organization"]').length);
      console.log('All [class*="zp_"] elements:', document.querySelectorAll('[class*="zp_"]').length);
      
      // Check for any divs that might contain company data
      const allDivs = document.querySelectorAll('div');
      const companyDivs = Array.from(allDivs).filter(div => {
        const text = div.textContent || '';
        return text.length > 10 && text.length < 200 && 
               (text.toLowerCase().includes('company') || 
                text.toLowerCase().includes('organization') ||
                text.toLowerCase().includes('business'));
      });
      console.log('Potential company divs:', companyDivs.length);
      
      // Check for any spans that might contain company data
      const allSpans = document.querySelectorAll('span');
      const companySpans = Array.from(allSpans).filter(span => {
        const text = span.textContent || '';
        return text.length > 5 && text.length < 100 && 
               (text.toLowerCase().includes('company') || 
                text.toLowerCase().includes('organization') ||
                text.toLowerCase().includes('business') ||
                text.toLowerCase().includes('corp') ||
                text.toLowerCase().includes('inc') ||
                text.toLowerCase().includes('llc'));
      });
      console.log('Potential company spans:', companySpans.length);
      
      console.log('=== END PAGE STRUCTURE DEBUG ===');
      
      // Enhanced data extraction using Apollo's actual company list structure (role-based)
      const isBadName = (name) => {
        const n = String(name || '').trim();
        if (!n) return true;
        const bannedExact = new Set([
          'Twitter','LinkedIn','Linkedin','Facebook','Company','Company Locations:','# Employees','Company Keywords Contain ANY Of:','Technologies','Funding','Owner','Stage','Market Segments','AI Filters','Website Visitors','Buying Intent','SIC and NAICS','SIC and NAICS','Scores'
        ]);
        if (bannedExact.has(n)) return true;
        // Skip obvious controls/labels
        if (/^\d+\s*-\s*\d+\s*of\s*\d/i.test(n)) return true; // pager text
        if (/^Save$/i.test(n)) return true;
        if (/^N\/A$/i.test(n)) return true;
        if (n.length < 2) return true;
        return false;
      };

      const isSocial = (href) => /twitter\.com|facebook\.com|linkedin\.com\/in/i.test(href || '');

      const extractFromRow = (row) => {
        // Get all cells in this row
        const cells = row.querySelectorAll('[role="cell"]');
        if (cells.length < 5) return; // Need at least basic data
        
        // Extract company name from text content (usually in first few cells)
        let companyName = '';
        let companyUrl = '';
        let location = '';
        let addressCity = '';
        let addressState = '';
        let employeeCount = '';
        let industry = '';
        let keywords = '';
        let profileUrl = '';
        let socialProfiles = {};
        
        // Prefer the anchor text from the profile link (matches table name cell)
        const nameAnchor = row.querySelector('a[href*="#/organizations/"] span, a[href*="#/accounts/"] span');
        if (nameAnchor && nameAnchor.textContent) {
          companyName = nameAnchor.textContent.trim();
        }
        // Fallback: heuristic search
        if (!companyName) {
          for (const cell of cells) {
            const text = cell.textContent?.trim() || '';
            if (text && /^[A-Z][\w\s&.,\-()]+$/.test(text) && text.length < 120 &&
                !/Save|employees|N\/A/i.test(text)) {
              companyName = text;
              break;
            }
          }
        }
        
        // Extract all links from the row
        const links = row.querySelectorAll('a[href]');
        // Prefer explicit website link button if present
        const websiteBtn = row.querySelector('a[aria-label="website link"][href^="http"]');
        if (websiteBtn && websiteBtn.getAttribute('href')) {
          companyUrl = websiteBtn.getAttribute('href');
        }
        for (const link of links) {
          const href = (link && link.href) ? link.href : (link.getAttribute('href') || '');
          const h = String(href || '').trim();
          // Apollo profile URL (support both organizations and accounts)
          if (/#\/(organizations|accounts)\//.test(h)) {
            profileUrl = h;
            continue;
          }
          // Company website (fallback if website button not found)
          if (!companyUrl && /^https?:\/\//i.test(h) && !/apollo\.io|linkedin\.com|facebook\.com|twitter\.com/i.test(h)) {
            companyUrl = h;
            continue;
          }
          // Socials
          if (/linkedin\.com\/company\//i.test(h)) socialProfiles.linkedin = h;
          else if (/facebook\.com\//i.test(h)) socialProfiles.facebook = h;
          else if (/twitter\.com\//i.test(h)) socialProfiles.twitter = h;
        }
        
        // Extract location (usually contains city, state pattern)
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          if (text && /[A-Z][a-z]+, [A-Z][a-z]+/.test(text) && text.length < 50) {
            location = text;
            const parts = text.split(',');
            if (parts.length >= 2) {
              addressCity = parts[0].trim();
              addressState = parts.slice(1).join(',').trim();
            }
            break;
          }
        }
        
        // Extract employee count (look for numbers)
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          const numMatch = text.match(/^(\d+)$/);
          if (numMatch && parseInt(numMatch[1]) > 0 && parseInt(numMatch[1]) < 100000) {
            employeeCount = numMatch[1];
            break;
          }
        }
        
        // Extract industry (usually single capitalized word)
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          if (text && /^[A-Z][a-z]+$/.test(text) && text.length < 30 && 
              !text.includes('Save') && !text.includes('employees')) {
            industry = text;
            break;
          }
        }
        
        // Extract keywords (lowercase phrases)
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          if (text && /^[a-z]/.test(text) && text.length > 5 && text.length < 50) {
            keywords = text;
            break;
          }
        }
        
        // Revenue: look for cells that have an M/K suffix and are in money column (best-effort)
        let revenue = '';
        for (const cell of cells) {
          const t = (cell.textContent || '').trim();
          if (/^\d+(?:\.\d+)?[MK]$/i.test(t)) { revenue = t; break; }
        }

        if (!isBadName(companyName) && (companyName || companyUrl || profileUrl)) {
          pushUnique({ 
            companyName, 
            companyUrl, 
            location, 
            address_city: addressCity,
            address_state: addressState,
            employeeCount, 
            phone: '', // Not available in list view
            industry, 
            keywords,
            profileUrl,
            socialProfiles: JSON.stringify(socialProfiles),
            linkedin_url: socialProfiles.linkedin || '',
            facebook_url: socialProfiles.facebook || '',
            twitter_url: socialProfiles.twitter || '',
            revenue,
          });
        }
      };
      
      // Strategy 1: Look for role="row" elements (Apollo's actual company list structure)
      const apolloRows = Array.from(document.querySelectorAll('[role="row"]'));
      console.log('Found Apollo table rows:', apolloRows.length);
      if (apolloRows.length > 0) {
        for (const row of apolloRows) {
          extractFromRow(row);
        }
      }
      
      // Strategy 2: Fallback to tbody elements (if they exist)
      if (out.length === 0) {
        const tbodies = Array.from(document.querySelectorAll('tbody'));
        console.log('Found tbody elements:', tbodies.length);
        if (tbodies.length > 0) {
          for (const tbody of tbodies) {
            const rows = tbody.querySelectorAll('tr, [role="row"]');
            for (const row of rows) {
              extractFromRow(row);
            }
          }
        }
      }
      
      // Strategy 3: Anchor fallback only if we failed to extract rows
      if (out.length === 0) {
        const anchors = Array.from(document.querySelectorAll('a[href*="#/organizations/"], a[href*="apollo.io"]'));
        console.log('Fallback anchors:', anchors.length);
        for (const a of anchors) {
          const tr = a.closest('tr');
          if (tr) { 
            extractFromRow(tr); 
            continue; 
          }
          const companyName = String(a.textContent || '').trim();
          const profileUrl = String(a.href || '');
          if (isBadName(companyName)) continue;
          // Attempt to find an external website link nearby
          let companyUrl = '';
          const rowLinks = Array.from(a.parentElement?.querySelectorAll('a[href]') || []);
          for (const ln of rowLinks) {
            const href = String((ln && ln.href) ? ln.href : (ln.getAttribute('href') || '')).trim();
            if (/^https?:\/\//i.test(href) && !/apollo\.io/i.test(href) && !isSocial(href)) { companyUrl = href; break; }
          }
          if (!isBadName(companyName) && (profileUrl || companyUrl)) {
            pushUnique({ companyName, companyUrl, location: '', employeeCount: '', phone: '', industry: '', profileUrl });
          }
        }
      }
      
      // Strategy 3 and 4 disabled to reduce noise
      
      console.log('Extracted items:', out.length);
      console.log('Sample items:', out.slice(0, 3));
      return out;
    });
    } catch (evalError) {
      debug({ info: 'page_evaluation_error', page: i, error: evalError.message });
      pageItems = [];
    }
    
    debug({ info: 'simple_page_items', page: i, count: pageItems.length, label: opts && opts.label ? opts.label : undefined });

    for (const it of pageItems) {
      const normProfile = String(it.profileUrl || '').toLowerCase();
      const normWebsite = String(it.companyUrl || '').toLowerCase();
      const normName = String(it.companyName || '').toLowerCase();
      const key = normProfile ? `profile:${normProfile}` : (normWebsite ? `site:${normWebsite}` : `name:${normName}`);
      if (unique.has(key)) continue;
      unique.add(key);
      // Guard: require at least a website or profile URL
      if (!it.companyUrl && !it.profileUrl) continue;
      rows.push({
        name: it.companyName || null,
        website: it.companyUrl || null,
        phone: it.phone || null,
        address: null,
        address_city: it.address_city || null,
        address_state: it.address_state || null,
        employeeCount: it.employeeCount || null,
        industry: it.industry || null,
        keywords: it.keywords || null,
        linkedin_url: it.linkedin_url || null,
        facebook_url: it.facebook_url || null,
        twitter_url: it.twitter_url || null,
        revenue: it.revenue || null,
        apollo_profile_url: it.profileUrl || null,
        categories: industry ? [industry] : null,
        method: 'apollo-simple',
        fallback_used: false,
        _profileUrl: it.profileUrl || null,
      });
      // Emit a debug line for visibility per user request
      debug({ info: 'row', name: it.companyName || '', website: it.companyUrl || '', apollo_profile_url: it.profileUrl || '' });
    }
    debug({ info: 'simple_page_added', page: i, total: rows.length });

    // Stop if we think we've fetched all pages
    if (totalCount && rows.length >= totalCount) break;
    // Enforce UI pages cap (Apollo reliably exposes ~5 pages in UI)
    if (i >= maxPages) break;
    const moved = await gotoNextPage();
    if (!moved) break;
    i += 1;
  }

  // Enhanced email enrichment: visit profile URLs in batches and extract comprehensive data
  // NOTE: Disabled by default. We only scrape list rows unless explicitly enabled via opts.enrichProfiles.
  if (!opts || !opts.enrichProfiles) {
    debug({ info: 'enrich_skipped' });
    debug({ info: 'return_rows', rows: rows.length });
    return rows;
  }
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
        
        // Navigate to the company profile page
        await p.goto(cleaned, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        
        // Wait longer for the page to fully load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Try multiple selectors to find company information
        try { 
          await p.waitForSelector('#general_information_card', { timeout: 15000 }); 
        } catch {}
        
        // Try alternative selectors if the main one fails
        try {
          await p.waitForSelector('[data-testid*="company"], [class*="company-info"], [class*="organization"]', { timeout: 10000 });
        } catch {}
        
        // Extract comprehensive data from the page
        const enrichedData = await p.evaluate(() => {
          const result = {
            emails: [],
            phone: '',
            address: '',
            website: '',
            socialProfiles: {},
            employeeCount: '',
            industry: '',
            description: ''
          };
          
          // Extract emails from multiple sources
          const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
          const allText = document.body?.innerText || '';
          const emails = allText.match(emailRegex) || [];
          result.emails = [...new Set(emails)]; // Remove duplicates
          
          // Extract phone numbers
          const phoneRegex = /(\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/g;
          const phones = allText.match(phoneRegex) || [];
          if (phones.length > 0) {
            result.phone = phones[0];
          }
          
          // Extract website URL
          const websiteLinks = Array.from(document.querySelectorAll('a[href^="http"]'));
          for (const link of websiteLinks) {
            const href = link.href;
            if (!href.includes('apollo.io') && !href.includes('linkedin.com')) {
              result.website = href;
              break;
            }
          }
          
          // Extract social media profiles
          const socialLinks = Array.from(document.querySelectorAll('a[href*="facebook.com"], a[href*="twitter.com"], a[href*="linkedin.com"], a[href*="instagram.com"]'));
          for (const link of socialLinks) {
            const href = link.href;
            if (href.includes('facebook.com')) result.socialProfiles.facebook = href;
            else if (href.includes('twitter.com')) result.socialProfiles.twitter = href;
            else if (href.includes('linkedin.com')) result.socialProfiles.linkedin = href;
            else if (href.includes('instagram.com')) result.socialProfiles.instagram = href;
          }
          
          // Extract employee count
          const empMatch = allText.match(/(\d+)\s*(?:employees?|staff|people)/i);
          if (empMatch) {
            result.employeeCount = empMatch[1];
          }
          
          // Extract industry
          const industryMatch = allText.match(/industry[:\s]+([^\n\r]+)/i);
          if (industryMatch) {
            result.industry = industryMatch[1].trim();
          }
          
          // Extract description
          const descElement = document.querySelector('[data-testid*="description"], .description, [class*="about"]');
          if (descElement) {
            result.description = descElement.textContent?.trim() || '';
          }
          
          return result;
        });
        
        // Update the record with enriched data
        if (enrichedData.emails.length > 0) {
          rec.email = enrichedData.emails[0];
          rec._emails = enrichedData.emails;
        }
        if (enrichedData.phone) rec.phone = enrichedData.phone;
        if (enrichedData.website) rec.website = enrichedData.website;
        if (enrichedData.employeeCount) rec.employeeCount = enrichedData.employeeCount;
        if (enrichedData.industry) rec.industry = enrichedData.industry;
        if (enrichedData.description) rec.description = enrichedData.description;
        if (Object.keys(enrichedData.socialProfiles).length > 0) {
          rec.socialProfiles = enrichedData.socialProfiles;
        }
        
        // Save the Apollo company page URL
        rec.apolloProfileUrl = cleaned;
        
      } catch (e) {
        debug({ info: 'enrichment_error', company: rec.name, error: e.message });
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