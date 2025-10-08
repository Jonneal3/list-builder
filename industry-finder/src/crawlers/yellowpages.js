const { load } = require('cheerio');
const axios = require('axios');

function tryRequire(mod) {
  try { return require(mod); } catch { return null; }
}
const { politeGet, sleep, randomBetween } = require('../utils/http');
// Optional Puppeteer Extra stealth support
const puppeteerExtra = tryRequire('puppeteer-extra');
const StealthPlugin = tryRequire('puppeteer-extra-plugin-stealth');

// Block generic and directory hosts from being emitted as company websites
const GENERIC_BLOCK = new Set([
  'facebook.com','instagram.com','x.com','twitter.com','youtube.com','wikipedia.org',
  'google.com','maps.google.com','bing.com','amazon.com','ebay.com','blogspot.com',
  'linkedin.com','zocdoc.com','careergroupcompanies.com'
]);
const DIRECTORY_BLOCK = new Set([
  'yellowpages.com','manta.com','bbb.org','superpages.com','merchantcircle.com','cylex.us.com',
  'cityfos.com','find-us-here.com','tuugo.us','brownbook.net','iglobal.co','company-list.org',
  'yalwa.com','hotfrog.com','citysquares.com','localstack.com','us-info.com','hub.biz','bizapedia.com',
  'opencorporates.com','yelp.com','angi.com','angi.es','homeadvisor.com','thumbtack.com'
]);

function buildCategoryUrl(industry, city, page = 1) {
  // YellowPages expects 'search_terms' for the category term
  const params = new URLSearchParams({ search_terms: industry, geo_location_terms: city, page: String(page) });
  return `https://www.yellowpages.com/search?${params.toString()}`;
}

function buildSnippetUrl(industry, city, page = 1) {
  const params = new URLSearchParams({ search_terms: industry, geo_location_terms: city, page: String(page) });
  return `https://www.yellowpages.com/search/snippet?${params.toString()}`;
}

function termsFromIndustry(industry) {
  const s = String(industry || '').toLowerCase();
  const terms = new Set(s.split(/[^a-z0-9]+/).filter(Boolean));
  // minimal expansions for common verticals
  if (s.includes('nail')) { terms.add('nail'); terms.add('salon'); terms.add('manicure'); terms.add('pedicure'); terms.add('spa'); }
  if (s.includes('floor')) { terms.add('floor'); terms.add('flooring'); terms.add('tile'); terms.add('carpet'); terms.add('hardwood'); }
  if (s.includes('roof')) { terms.add('roof'); terms.add('roofing'); }
  if (s.includes('plumb')) { terms.add('plumb'); terms.add('plumber'); terms.add('plumbing'); }
  return Array.from(terms);
}

function hostOrPathContains(url, terms) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const blob = (u.hostname + ' ' + u.pathname + ' ' + u.search).toLowerCase();
    return terms.some(t => t && blob.includes(t));
  } catch { return false; }
}

function parseListingHtml(html, industryTerms, opts = {}) {
  const $ = load(html);
  const results = [];
  const cards = $('div.result, div.srp-listing, article.srp-listing, div.business-card, div.info');
  function extractWebsiteUrl(raw) {
    if (!raw) return null;
    try {
      const u = new URL(raw, 'https://www.yellowpages.com');
      if (u.hostname.endsWith('yellowpages.com') && (u.pathname === '/redirect' || u.pathname === '/redir' || u.pathname === '/link')) {
        const target = u.searchParams.get('url');
        if (target) return decodeURIComponent(target);
      }
      return raw;
    } catch { return raw; }
  }
  cards.each((_, el) => {
    const node = $(el);
    // Do not aggressively drop on generic "ad"/"sponsored" text to avoid false positives
    const name = (node.find('a.business-name span').text().trim() || node.find('a.business-name').first().text().trim() || node.find('h2 a, h3 a').first().text().trim());
    if (!name) return;
    // Try multiple selectors for website links
    let websiteCandidate = node.find('a.track-visit-website').attr('href')
      || node.find('a.website, a.website-link').attr('href')
      || node.find('a[href*="/redirect?url="], a[href*="/redir?url="], a[href*="/link?url="]').attr('href')
      || null;
    if (!websiteCandidate) {
      const anchors = node.find('a[href]');
      anchors.each((__, a) => {
        if (websiteCandidate) return;
        const href = String($(a).attr('href') || '').trim();
        if (!href) return;
        const abs = extractWebsiteUrl(href);
        // Exclude YP internal links and map/directions
        if (/yellowpages\.com|\/directions|\/map\b|tel:|mailto:/i.test(abs)) return;
        // Only accept external anchor if it looks related to industry
        if (/^https?:\/\//i.test(abs) && hostOrPathContains(abs, industryTerms)) {
          websiteCandidate = abs;
        }
      });
    }
    const website = extractWebsiteUrl(websiteCandidate);
    // Optional: mild name relevance; don't over-filter
    const lname = name.toLowerCase();
    const nameMatches = industryTerms.some(t => t && lname.includes(t));
    // Enforce name relevance when requested
    if (opts.requireIndustryInName !== false && industryTerms.length > 0 && !nameMatches) return;
    // Drop rows with no website when required
    if (opts.requireWebsite && !website) return;
    // Drop known generic/directory destinations
    try {
      if (website) {
        const u = new URL(website.startsWith('http') ? website : `https://${website}`);
        const host = u.host.replace(/^www\./, '').toLowerCase();
        if (GENERIC_BLOCK.has(host) || DIRECTORY_BLOCK.has(host)) return;
      }
    } catch {}
    results.push({ name, website: website || null });
  });
  return results;
}

function countListingCards(html) {
  try {
    const $ = load(html);
    return $('div.result, div.srp-listing, article.srp-listing, div.business-card, div.info').length;
  } catch {
    return 0;
  }
}

function normalizeHost(url) {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.host.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const name = String(r && r.name ? r.name : '').trim().toLowerCase();
    const host = normalizeHost(r && r.website ? r.website : '');
    const key = `${name}|${host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function parseTotalCount(html) {
  try {
    const m = String(html).match(/Showing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)/i);
    if (m && m[1]) {
      return parseInt(m[1].replace(/,/g, ''), 10);
    }
  } catch {}
  return null;
}

async function crawlYellowPages(industry, city, pages = 1, opts = { concurrency: 2, minDelayMs: 200, maxDelayMs: 500, autoMaxPages: 50, onDebug: null, proxyList: [], rotateProxies: false, initialBackoffMs: 500, useBrowserFallback: true, pageTimeoutMs: 20000, headless: true, puppeteerProxy: null, puppeteerProxyUser: null, puppeteerProxyPass: null, maxRetriesPerPage: 2, forceBrowserFirst: false, pageJitterMinMs: 800, pageJitterMaxMs: 2000, rotateViewport: false }) {
  const terms = termsFromIndustry(industry);
  const totalPages = Number(pages) === -1 ? -1 : Math.max(1, Number(pages || 1));
  const limit = Math.max(1, Math.min(8, Number(opts.concurrency || 2)));
  const onDebug = typeof opts.onDebug === 'function' ? opts.onDebug : null;

  function debug(event) {
    try { if (onDebug) onDebug(event); } catch {}
  }

  // Rotate realistic desktop Chrome UA strings
  const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  ];
  const pickUa = (p) => UA_POOL[(Math.max(1, p) - 1) % UA_POOL.length];

  // Warm-up request to establish cookies used by YP anti-bot
  let ypCookie = null;
  async function ensureYellowPagesCookie() {
    if (ypCookie) return ypCookie;
    try {
      const res = await axios.get('https://www.yellowpages.com/', {
        headers: {
          'User-Agent': pickUa(1),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
          'DNT': '1',
        },
        timeout: 12000,
        maxRedirects: 5,
        validateStatus: s => s >= 200 && s < 400,
      });
      const setCookie = res.headers && (res.headers['set-cookie'] || res.headers['Set-Cookie']);
      if (Array.isArray(setCookie) && setCookie.length) {
        ypCookie = setCookie.map(String).map(s => s.split(';')[0]).filter(Boolean).join('; ');
        debug({ info: 'yp_cookie_set', len: ypCookie.length });
      }
    } catch (e) {
      debug({ info: 'yp_cookie_fail', error: String(e && (e.message || e)) });
    }
    // Fallback: acquire cookies via Puppeteer and reuse for axios requests
    if (!ypCookie && opts.useBrowserFallback) {
      try {
        const browser = await ensurePuppeteerBrowser();
        if (browser) {
          const page = await browser.newPage();
          try {
            await page.setUserAgent(pickUa(1));
            await page.goto('https://www.yellowpages.com/', { waitUntil: 'domcontentloaded', timeout: Math.max(8000, Number(opts.pageTimeoutMs || 20000)) });
            try {
              await page.evaluate(() => {
                const clickText = (rx) => {
                  const btns = Array.from(document.querySelectorAll('button, a'));
                  for (const b of btns) { const t = (b.textContent || '').toLowerCase(); if (rx.test(t)) { b.click(); break; } }
                };
                try { clickText(/accept|agree|consent|got it/i); } catch {}
              });
            } catch {}
            const cookies = await page.cookies();
            const filtered = cookies.filter(c => (c.domain || '').includes('yellowpages.com'));
            if (filtered.length) {
              ypCookie = filtered.map(c => `${c.name}=${c.value}`).join('; ');
              debug({ info: 'yp_cookie_set_puppeteer', count: filtered.length, len: ypCookie.length });
            }
          } finally {
            try { await page.close(); } catch {}
          }
        }
      } catch (e) {
        debug({ info: 'yp_cookie_puppeteer_fail', error: String(e && (e.message || e)) });
      }
    }
    return ypCookie;
  }

  // Shared Puppeteer browser to reduce startup overhead
  let sharedPuppeteer = null;
  async function ensurePuppeteerBrowser() {
    try {
      if (!puppeteerExtra) return null;
      if (StealthPlugin) {
        try { puppeteerExtra.use(StealthPlugin()); } catch {}
      }
      if (!sharedPuppeteer) {
        const args = ['--no-sandbox','--disable-setuid-sandbox'];
        if (opts.puppeteerProxy) args.push(`--proxy-server=${opts.puppeteerProxy}`);
        sharedPuppeteer = await puppeteerExtra.launch({ headless: Boolean(opts.headless), args });
      }
      return sharedPuppeteer;
    } catch {
      return null;
    }
  }

  async function puppeteerFetchHtml(url, methodTag = 'puppeteer') {
    const browser = await ensurePuppeteerBrowser();
    if (!browser) return null;
    const pageObj = await browser.newPage();
    try {
      // Authenticate to proxy if provided
      if (opts.puppeteerProxyUser && opts.puppeteerProxyPass) {
        try { await pageObj.authenticate({ username: String(opts.puppeteerProxyUser), password: String(opts.puppeteerProxyPass) }); } catch {}
      }
      // Randomize UA per request
      await pageObj.setUserAgent(pickUa(Math.floor(Math.random() * 3) + 1));
      await pageObj.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.yellowpages.com/',
      });
      if (opts.rotateViewport) {
        try {
          const w = 1200 + Math.floor(Math.random() * 200);
          const h = 800 + Math.floor(Math.random() * 200);
          await pageObj.setViewport({ width: w, height: h });
        } catch {}
      }
      const navTimeout = Math.max(5000, Math.min(60000, Number(opts.pageTimeoutMs || 20000)));
      await pageObj.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      // Best-effort consent dismissal and small scroll to trigger lazy content
      try {
        await pageObj.evaluate(() => {
          const clickText = (rx) => {
            const btns = Array.from(document.querySelectorAll('button, a'));
            for (const b of btns) {
              const t = (b.textContent || '').toLowerCase();
              if (rx.test(t)) { b.click(); break; }
            }
          };
          try { clickText(/accept|agree|consent|got it/i); } catch {}
          try { window.scrollBy(0, window.innerHeight * 2); } catch {}
        });
      } catch {}
      // Human-like jitter
      try { await pageObj.waitForTimeout(300 + Math.floor(Math.random() * 500)); } catch {}
      try { await pageObj.waitForSelector('div.result, div.srp-listing, article.srp-listing, div.business-card, div.info', { timeout: 8000 }); } catch {}
      // Detect obvious CAPTCHA blocks
      try {
        const blocked = await pageObj.evaluate(() => {
          const lc = document.body.innerText.toLowerCase();
          if (lc.includes('captcha') || lc.includes('verify you are a human')) return true;
          if (document.querySelector('iframe[src*="recaptcha"]')) return true;
          return false;
        });
        if (blocked) {
          return { html: '', method: methodTag + '-blocked' };
        }
      } catch {}
      const html = await pageObj.content();
      await pageObj.close();
      return { html, method: methodTag };
    } catch (e) {
      try { await pageObj.close(); } catch {}
      throw e;
    }
  }

  async function fetchPage(p) {
    const url = buildCategoryUrl(industry, city, p);
    try {
      // Per-page jitter to reduce bot detection
      try { await sleep(randomBetween(Math.max(0, Number(opts.pageJitterMinMs || 800)), Math.max(Number(opts.pageJitterMinMs || 800), Number(opts.pageJitterMaxMs || 2000)))); } catch {}

      if (opts.forceBrowserFirst) {
        const pup = await puppeteerFetchHtml(url, 'puppeteer-forced');
        if (pup && pup.html) {
          const html2 = String(pup.html);
          const rows2 = parseListingHtml(html2, terms).map(r => ({ ...r, method: 'yp-puppeteer', fallback_used: true }));
          const total2 = parseTotalCount(html2);
          const cards2 = countListingCards(html2);
          const rows2Dedup = dedupeRows(rows2);
          debug({ page: p, url, status: 200, htmlLen: html2.length, rows: rows2Dedup.length, rowsBeforeDedup: rows2.length, cards: cards2, method: 'puppeteer-forced' });
          return { rows: rows2Dedup, total: total2 };
        }
      }

      const cookie = await ensureYellowPagesCookie();
      // If we have no cookie on first page, try Puppeteer first to establish a real session
      if (opts.useBrowserFallback && !cookie && p === 1) {
        try {
          const pupRes = await puppeteerFetchHtml(url, 'puppeteer-forced');
          if (pupRes && pupRes.html) {
            const html2 = String(pupRes.html);
            const rows2 = parseListingHtml(html2, terms).map(r => ({ ...r, method: pupRes.method, fallback_used: true }));
            const total2 = parseTotalCount(html2);
            const cards2 = countListingCards(html2);
            debug({ page: p, url, status: 200, htmlLen: html2.length, rows: rows2.length, cards: cards2, method: pupRes.method });
            if (rows2.length) return { rows: rows2, total: total2 };
          }
        } catch (e) {
          debug({ page: p, url, info: 'puppeteer_forced_failed', error: String(e && (e.message || e)) });
        }
      }
      const res = await politeGet(url, {
        minDelayMs: opts.minDelayMs,
        maxDelayMs: opts.maxDelayMs,
        retries: 2,
        proxyList: opts.proxyList,
        rotateProxies: opts.rotateProxies,
        initialBackoffMs: opts.initialBackoffMs,
        onDebug: (e) => debug({ source: 'proxies', page: p, ...e }),
        headers: {
          'User-Agent': pickUa(p),
          Referer: 'https://www.yellowpages.com/',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(cookie ? { 'Cookie': cookie } : {}),
          'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'DNT': '1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        },
      });
      const html = res && res.data ? String(res.data) : '';
      let rows = parseListingHtml(html, terms).map(r => ({ ...r, method: 'yp-cheerio', fallback_used: false }));
      let total = parseTotalCount(html);
      const cardCandidates = countListingCards(html);
      // If page yields zero rows, attempt YellowPages AJAX snippet endpoints
      if (rows.length === 0) {
        try {
          const ajaxUrl = url + (url.includes('?') ? '&' : '?') + 'ajax=true';
          const resAjax = await politeGet(ajaxUrl, {
            minDelayMs: opts.minDelayMs,
            maxDelayMs: opts.maxDelayMs,
            retries: 2,
            proxyList: opts.proxyList,
            rotateProxies: opts.rotateProxies,
            initialBackoffMs: opts.initialBackoffMs,
            onDebug: (e) => debug({ source: 'proxies', page: p, ...e }),
            headers: {
              'User-Agent': pickUa(p),
              Referer: 'https://www.yellowpages.com/',
              'Accept-Language': 'en-US,en;q=0.9',
              ...(cookie ? { 'Cookie': cookie } : {}),
              'X-Requested-With': 'XMLHttpRequest',
              'DNT': '1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'Sec-Fetch-Site': 'same-origin',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Dest': 'empty',
            },
          });
          const htmlAjax = resAjax && resAjax.data ? String(resAjax.data) : '';
          const rowsAjax = parseListingHtml(htmlAjax, terms).map(r => ({ ...r, method: 'yp-ajax', fallback_used: false }));
          const ajaxCards = countListingCards(htmlAjax);
          debug({ page: p, url: ajaxUrl, status: resAjax.status, htmlLen: htmlAjax.length, ajax_true_rows: rowsAjax.length, ajax_cards: ajaxCards });
          if (rowsAjax.length) {
            rows = rowsAjax;
          }
        } catch (e) {
          debug({ page: p, url, info: 'ajax_true_failed', error: String(e && (e.message || e)) });
        }
      }
      if (rows.length === 0) {
        try {
          const snippetUrl = buildSnippetUrl(industry, city, p);
          const resSnip = await politeGet(snippetUrl, {
            minDelayMs: opts.minDelayMs,
            maxDelayMs: opts.maxDelayMs,
            retries: 2,
            proxyList: opts.proxyList,
            rotateProxies: opts.rotateProxies,
            initialBackoffMs: opts.initialBackoffMs,
            onDebug: (e) => debug({ source: 'proxies', page: p, ...e }),
            headers: {
              'User-Agent': pickUa(p),
              Referer: 'https://www.yellowpages.com/',
              'Accept-Language': 'en-US,en;q=0.9',
              ...(cookie ? { 'Cookie': cookie } : {}),
              'X-Requested-With': 'XMLHttpRequest',
              'DNT': '1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'Sec-Fetch-Site': 'same-origin',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Dest': 'empty',
            },
          });
          const htmlSnip = resSnip && resSnip.data ? String(resSnip.data) : '';
          const rowsSnip = parseListingHtml(htmlSnip, terms).map(r => ({ ...r, method: 'yp-snippet', fallback_used: false }));
          const snipCards = countListingCards(htmlSnip);
          debug({ page: p, url: snippetUrl, status: resSnip.status, htmlLen: htmlSnip.length, snippet_rows: rowsSnip.length, snippet_cards: snipCards });
          if (rowsSnip.length) {
            rows = rowsSnip;
          }
        } catch (e) {
          debug({ page: p, url, info: 'snippet_failed', error: String(e && (e.message || e)) });
        }
      }
      // Per-page deduplication before returning
      const before = rows.length;
      rows = dedupeRows(rows);
      const after = rows.length;
      debug({ page: p, url, status: res.status, htmlLen: html.length, rows: after, rowsBeforeDedup: before, cards: cardCandidates, sample: rows.slice(0, 3).map(r => r.name) });
      if (rows.length > 0) {
        return { rows, total };
      }
      // If we still have zero rows despite 200, treat as likely bot-blocked dynamic page → Puppeteer fallback
      if (opts.useBrowserFallback) try {
        const pupRes = await puppeteerFetchHtml(url, 'puppeteer-zero');
        if (pupRes && pupRes.html) {
          const html2 = String(pupRes.html);
          const rows2 = parseListingHtml(html2, terms).map(r => ({ ...r, method: 'yp-puppeteer-zero', fallback_used: true }));
          const total2 = parseTotalCount(html2);
          const cards2 = countListingCards(html2);
          const rows2Dedup = dedupeRows(rows2);
          debug({ page: p, url, status: 200, htmlLen: html2.length, rows: rows2Dedup.length, rowsBeforeDedup: rows2.length, cards: cards2, method: 'puppeteer-zero' });
          return { rows: rows2Dedup, total: total2 };
        }
      } catch (e) {
        debug({ page: p, url, info: 'puppeteer_zero_fallback_failed', error: String(e && (e.message || e)) });
      }
      return { rows, total };
    } catch (err) {
      const status = err && err.response && err.response.status ? err.response.status : null;
      const data = err && err.response && err.response.data ? String(err.response.data) : '';
      debug({ page: p, url, error: String(err && (err.message || err)), status, htmlLen: data.length });
      // Browser fallback using Puppeteer Extra stealth if installed, only on hard blocks
      if (opts.useBrowserFallback && (status === 403 || status === 429 || status === 503)) {
        let attempt = 0;
        while (attempt < Math.max(1, Number(opts.maxRetriesPerPage || 1))) {
          attempt += 1;
          const br = await ensurePuppeteerBrowser();
          if (!br) { debug({ page: p, url, info: 'puppeteer_not_installed' }); break; }
          try {
            const pupRes = await puppeteerFetchHtml(url, 'puppeteer');
            if (pupRes && pupRes.html) {
              const html2 = String(pupRes.html);
              const rows2 = parseListingHtml(html2, terms).map(r => ({ ...r, method: 'yp-puppeteer', fallback_used: true }));
              const total2 = parseTotalCount(html2);
              const cards2 = countListingCards(html2);
              const rows2Dedup = dedupeRows(rows2);
              debug({ page: p, url, status: 200, htmlLen: html2.length, rows: rows2Dedup.length, rowsBeforeDedup: rows2.length, cards: cards2, method: 'puppeteer', attempt });
              return { rows: rows2Dedup, total: total2 };
            }
          } catch (e) {
            debug({ page: p, url, info: 'puppeteer_fallback_failed', error: String(e && (e.message || e)), attempt });
          }
        }
      }
      return { rows: [], total: null };
    }
  }

  const results = [];
  let totalFromFirst = null;
  let perPageEstimate = null;
  if (totalPages === -1) {
    // Auto: fetch page 1 to get total and per-page size
    const first = await fetchPage(1);
    const rows1 = Array.isArray(first) ? first : first?.rows || [];
    totalFromFirst = (first && !Array.isArray(first) && typeof first.total === 'number') ? first.total : null;
    perPageEstimate = rows1.length || null;
    results.push(...rows1);
    debug({ page: 1, info: 'first_page_parsed', totalFromFirst, perPageEstimate, rows: rows1.length });

    if (totalFromFirst && perPageEstimate) {
      const maxPages = Math.max(1, Number(opts.autoMaxPages || 50));
      const totalPagesCalc = Math.min(maxPages, Math.ceil(totalFromFirst / perPageEstimate));
      const pagesToFetch = Math.max(0, totalPagesCalc - 1);
      if (pagesToFetch > 0) {
        const tasks = Array.from({ length: pagesToFetch }, (_, i) => 2 + i).map(p => async () => fetchPage(p));
        let idx = 0;
        async function runNext() {
          if (idx >= tasks.length) return;
          const my = idx++;
          const out = await tasks[my]();
          const rows = Array.isArray(out) ? out : out?.rows || [];
          results.push(...rows);
          return runNext();
        }
        await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runNext));
        debug({ info: 'auto_pages_done', pagesFetched: pagesToFetch + 1, totalAccumulated: results.length });
      }
    } else {
      // Fallback: incremental until empty or cap
      let p = 2;
      while (p <= Math.max(1, Number(opts.autoMaxPages || 50))) {
        const out = await fetchPage(p);
        const rows = Array.isArray(out) ? out : out?.rows || [];
        if (!rows.length) break;
        results.push(...rows);
        p += 1;
      }
      debug({ info: 'incremental_done', lastPage: p - 1, totalAccumulated: results.length });
    }
  } else {
    const tasks = Array.from({ length: totalPages }, (_, i) => i + 1).map(p => async () => fetchPage(p));
    let idx = 0;
    async function runNext() {
      if (idx >= tasks.length) return;
      const my = idx++;
      const out = await tasks[my]();
      const rows = Array.isArray(out) ? out : out?.rows || [];
      results.push(...rows);
      return runNext();
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runNext));
    debug({ info: 'fixed_pages_done', pagesRequested: totalPages, totalAccumulated: results.length });
  }
  // Cleanup shared browser
  try {
    if (sharedPuppeteer) { await sharedPuppeteer.close(); sharedPuppeteer = null; }
  } catch {}
  // Final de-duplication across all pages before returning
  const resultsDedup = dedupeRows(results);
  return { rows: resultsDedup, total: totalFromFirst || resultsDedup.length, pagesFetched: Math.ceil(resultsDedup.length / Math.max(1, perPageEstimate || resultsDedup.length)) };
}

module.exports = { crawlYellowPages };


