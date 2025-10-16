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
  // DISABLED: Unflare is timing out, using direct browser approach instead
  if (false && !cookieHeader && process.env.UNFLARE_URL) {
    try {
      const unflareUrl = String(process.env.UNFLARE_URL).replace(/\/$/, '') + '/scrape';
      const payload = { 
        url: 'https://app.apollo.io/#/companies', 
        timeout: 60000,
        method: 'GET'
      };
      const fetchImpl = (typeof fetch === 'function') ? fetch : require('node-fetch');
      const res = await fetchImpl(unflareUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env.UNFLARE_API_KEY ? { authorization: `Bearer ${String(process.env.UNFLARE_API_KEY)}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      
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

async function scrapeApolloWithSession(page, industry, city, opts = { pageTimeoutMs: 20000, uiPages: 5, apolloListUrl: null, onDebug: null }) {
  const debug = (e) => { try { if (opts && typeof opts.onDebug === 'function') opts.onDebug(e); } catch {} };
  const navTimeout = Math.max(8000, Math.min(60000, Number(opts.pageTimeoutMs || 20000)));
  const baseUrl = buildBaseUrl(industry, opts.apolloListUrl);

  debug({ info: 'filtered_nav_start', url: baseUrl });
  
  // Enhanced navigation with better error handling
  try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    // Wait for the page to stabilize
    await new Promise(resolve => setTimeout(resolve, 2000));
    // Try to wait for any loading indicators to disappear
    try {
      await page.waitForFunction(() => {
        const loading = document.querySelector('[data-testid="loading"], .loading, .spinner');
        return !loading || loading.style.display === 'none';
      }, { timeout: 5000 });
    } catch {}
  } catch (error) {
    debug({ info: 'navigation_error', error: error.message, url: baseUrl });
    // Try to recover by refreshing
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeout });
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (retryError) {
      debug({ info: 'navigation_retry_failed', error: retryError.message });
    }
  }
  
  debug({ info: 'filtered_nav_done', url: baseUrl });

  // Add debugging for page state
  try {
    const pageTitle = await page.title();
    const pageUrl = page.url();
    debug({ info: 'page_state', title: pageTitle, url: pageUrl });
  } catch (e) {
    debug({ info: 'page_state_error', error: e.message });
  }

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
    
    try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      // Wait for content to load
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Try multiple selectors to find the data
      let hadTbody = false;
      try { 
        await page.waitForSelector('tbody', { timeout: 8000 }); 
        hadTbody = true; 
      } catch {}
      
      if (!hadTbody) {
        try { 
          await page.waitForSelector('a[href*="#/organizations/"]', { timeout: 8000 }); 
        } catch {}
      }
      
      // Additional wait for dynamic content
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      debug({ info: 'page_navigation_error', page: i, error: error.message });
      continue; // Skip this page and continue with the next
    }

    debug({ info: 'starting_page_evaluation', page: i, label: opts && opts.label ? opts.label : undefined });
    
    let pageItems = [];
    try {
      pageItems = await page.evaluate(() => {
      const out = [];
      
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
        
        // Look for company name pattern (capitalized words) in cells
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          if (text && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(text) && text.length < 100 && 
              !text.includes('Save') && !text.includes('employees')) {
            companyName = text;
            break;
          }
        }
        
        // Extract all links from the row
        const links = row.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          
          // Apollo profile URL
          if (href.includes('#/organizations/')) {
            profileUrl = href;
          }
          // Company website
          else if (href.startsWith('http') && !href.includes('apollo.io') && !href.includes('linkedin.com') && !href.includes('facebook.com') && !href.includes('twitter.com')) {
            companyUrl = href;
          }
          // LinkedIn
          else if (href.includes('linkedin.com/company/')) {
            socialProfiles.linkedin = href;
          }
          // Facebook
          else if (href.includes('facebook.com/')) {
            socialProfiles.facebook = href;
          }
          // Twitter
          else if (href.includes('twitter.com/')) {
            socialProfiles.twitter = href;
          }
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

        if (companyName || companyUrl || profileUrl) {
          out.push({ 
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
      
      // Strategy 2: Look for organization profile anchors
      const anchors = Array.from(document.querySelectorAll('a[href*="#/organizations/"], a[href*="apollo.io"]'));
      console.log('Found Apollo anchors:', anchors.length);
      for (const a of anchors) {
        const tr = a.closest('tr');
        if (tr) { 
          extractFromRow(tr); 
          continue; 
        }
        const companyName = String(a.textContent || '').trim();
        const profileUrl = String(a.href || '');
        // Attempt to find an external website link nearby
        let companyUrl = '';
        const rowLinks = Array.from(a.parentElement?.querySelectorAll('a[href]') || []);
        for (const ln of rowLinks) {
          const href = String(ln.getAttribute('href') || '').trim();
          if (/^https?:\/\//i.test(href) && !/apollo\.io|linkedin\.com\/in/i.test(href)) { companyUrl = href; break; }
        }
        if (companyName) {
          out.push({ companyName, companyUrl, location: '', employeeCount: '', phone: '', industry: '', profileUrl });
        }
      }
      
      // Strategy 3: Look for any company-related elements
      const companyElements = Array.from(document.querySelectorAll('[data-testid*="company"], [class*="company"], [class*="organization"], [class*="zp_"]'));
      console.log('Found company elements:', companyElements.length);
      for (const el of companyElements) {
        const text = el.textContent || '';
        if (text.length > 3 && text.length < 100) {
          const links = Array.from(el.querySelectorAll('a[href]'));
          let profileUrl = '';
          let companyUrl = '';
          for (const link of links) {
            const href = link.href;
            if (href.includes('#/organizations/')) {
              profileUrl = href;
            } else if (/^https?:\/\//i.test(href) && !/apollo\.io|linkedin\.com\/in/i.test(href)) {
              companyUrl = href;
            }
          }
          if (profileUrl || companyUrl) {
            out.push({ 
              companyName: text.trim(), 
              companyUrl, 
              location: '', 
              employeeCount: '', 
              phone: '', 
              industry: '', 
              profileUrl 
            });
          }
        }
      }
      
      // Strategy 4: Look for any text that might be company names
      if (out.length === 0) {
        console.log('No data found with previous strategies, trying text extraction...');
        const allText = document.body.innerText || '';
        const lines = allText.split('\n').map(line => line.trim()).filter(line => line.length > 2 && line.length < 100);
        const companyPattern = /company|organization|business|corp|inc|llc|ltd|group|solutions|services|systems|technologies|tech|software|digital|marketing|consulting|advertising|media|communications|financial|healthcare|medical|legal|real estate|construction|manufacturing|retail|restaurant|food|hospitality|travel|transportation|logistics|energy|utilities|government|education|nonprofit|charity|foundation|association|federation|society|club|union|guild|alliance|partnership|enterprise|ventures|holdings|investments|capital|equity|fund|trust|estate|properties|development|management|advisors|consultants|specialists|experts|professionals|associates|partners|group|team|staff|crew|squad|unit|division|department|section|branch|office|headquarters|hq|main|central|regional|local|national|international|global|worldwide|universal|general|standard|premium|elite|executive|senior|junior|assistant|coordinator|director|manager|supervisor|lead|head|chief|president|ceo|coo|cfo|cto|cmo|cpo|vp|svp|evp|founder|co-founder|owner|proprietor|operator|administrator|coordinator|facilitator|mediator|negotiator|representative|agent|broker|dealer|distributor|supplier|vendor|contractor|subcontractor|freelancer|consultant|advisor|specialist|expert|professional|associate|partner|colleague|teammate|staff member|employee|worker|laborer|technician|engineer|developer|designer|architect|analyst|researcher|scientist|doctor|nurse|teacher|instructor|trainer|coach|mentor|tutor|guide|leader|manager|supervisor|director|executive|officer|official|representative|delegate|ambassador|spokesperson|advocate|champion|supporter|ally|friend/i;
        
        for (const line of lines) {
          if (companyPattern.test(line) && !out.some(o => o.companyName === line)) {
            out.push({ companyName: line, companyUrl: '', location: '', employeeCount: '', phone: '', industry: '', profileUrl: '' });
          }
        }
      }
      
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
      const key = `${(it.companyName || '').toLowerCase()}-${(it.companyUrl || '').toLowerCase()}-${(it.profileUrl || '').toLowerCase()}`;
      if (unique.has(key)) continue;
      unique.add(key);
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