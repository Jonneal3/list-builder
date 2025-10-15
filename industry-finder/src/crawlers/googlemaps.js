const { URLSearchParams } = require('url');

function tryRequire(mod) {
  try { return require(mod); } catch { return null; }
}

const puppeteerExtra = tryRequire('puppeteer-extra');
const StealthPlugin = tryRequire('puppeteer-extra-plugin-stealth');

async function crawlGoogleMaps(industry, city, opts = { limit: 25, detailClicks: 5, detailAll: false, exhaust: false, maxTotal: 300, headless: true, pageTimeoutMs: 25000, rotateViewport: false, puppeteerProxy: null, puppeteerProxyUser: null, puppeteerProxyPass: null, onDebug: null }) {
  const onDebug = typeof opts.onDebug === 'function' ? opts.onDebug : null;
  function debug(event) { try { if (onDebug) onDebug(event); } catch {}
  }
  async function sleepMs(ms) { return new Promise(res => setTimeout(res, Math.max(0, Number(ms || 0)))); }
  if (!puppeteerExtra) {
    debug({ info: 'gmaps_puppeteer_not_installed' });
    return { rows: [], total: null };
  }
  if (StealthPlugin) {
    try { puppeteerExtra.use(StealthPlugin()); } catch {}
  }
  const args = ['--no-sandbox','--disable-setuid-sandbox'];
  if (opts.puppeteerProxy) args.push(`--proxy-server=${opts.puppeteerProxy}`);
  const browser = await puppeteerExtra.launch({ headless: Boolean(opts.headless), args });
  const page = await browser.newPage();
  try {
    if (opts.puppeteerProxyUser && opts.puppeteerProxyPass) {
      try { await page.authenticate({ username: String(opts.puppeteerProxyUser), password: String(opts.puppeteerProxyPass) }); } catch {}
    }
    if (opts.rotateViewport) {
      try { await page.setViewport({ width: 1200 + Math.floor(Math.random()*200), height: 850 + Math.floor(Math.random()*150) }); } catch {}
    }
    const q = `${industry} in ${city}`;
    const params = new URLSearchParams({ q });
    const url = `https://www.google.com/maps/search/?${params.toString()}`;
    const navTimeout = Math.max(8000, Math.min(60000, Number(opts.pageTimeoutMs || 25000)));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    // Consent / cookie dialog best-effort
    try {
      await sleepMs(500);
      await page.evaluate(() => {
        const clickByText = (rx) => {
          const els = Array.from(document.querySelectorAll('button, div[role="button"], span'));
          for (const el of els) {
            const t = (el.textContent || '').toLowerCase();
            if (rx.test(t)) { el.click(); return true; }
          }
          return false;
        };
        try { clickByText(/accept|agree|consent|i agree|allow all|accept all/i); } catch {}
      });
    } catch {}
    // Wait for results list container
    try { await page.waitForSelector('div[role="feed"], div.m6QEr[aria-label]', { timeout: 10000 }); } catch {}

    // Infinite scroll to collect result nodes
    async function collectResults(targetLimit, doExhaust) {
      const seen = new Set();
      let items = [];
      let stuck = 0;
      while ((items.length < targetLimit || doExhaust) && stuck < 10) {
        const batch = await page.evaluate(() => {
          const out = [];
          const cards = document.querySelectorAll('div[role="article"], .Nv2PK');
          for (const card of cards) {
            // Name
            const nameEl = card.querySelector('[role="heading"], .qBF1Pd, .NrDZNb');
            const name = nameEl ? (nameEl.textContent || '').trim() : '';
            if (!name) continue;
            const id = (card.getAttribute('data-result-id') || card.getAttribute('data-id') || name).trim();
            // Rating
            let rating = null;
            const ratingEl = card.querySelector('[aria-label*="stars" i], .MW4etd');
            const aria = ratingEl ? (ratingEl.getAttribute('aria-label') || ratingEl.textContent || '') : '';
            const mR = String(aria).match(/([0-9]+(?:\.[0-9]+)?)\s*star/i);
            if (mR) rating = parseFloat(mR[1]);
            // Reviews
            let reviews_count = null;
            const revEl = card.querySelector('.UY7F9, .HzV7m-pbTTYe-bN97Pc');
            if (revEl) {
              const mC = (revEl.textContent || '').replace(/[,()]/g,'').match(/\b(\d+)\b/);
              if (mC) reviews_count = parseInt(mC[1], 10);
            }
            // Snippet lines often include category and address
            const snippet = Array.from(card.querySelectorAll('.W4Efsd, .rllt__details, .A4bIc')).map(n => (n.textContent || '').trim()).filter(Boolean);
            const category = snippet.length ? snippet[0] : null;
            const address = snippet.length > 1 ? snippet[1] : null;
            out.push({ id, name, rating, reviews_count, category, address });
          }
          return out;
        });
        let added = 0;
        for (const it of batch) {
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          items.push(it);
          added += 1;
          if (!doExhaust && items.length >= targetLimit) break;
        }
        if (added === 0) {
          stuck += 1;
        } else {
          stuck = 0;
        }
        // Scroll list container
        try {
          await page.evaluate(() => {
            const scrollers = Array.from(document.querySelectorAll('div[role="feed"], div.m6QEr[aria-label]'));
            const el = scrollers.find(e => e.scrollHeight > e.clientHeight);
            if (el) { el.scrollBy(0, el.clientHeight * 0.9); }
          });
        } catch {}
        await sleepMs(600);
      }
      return items;
    }

    const target = Math.max(1, Number(opts.limit || 25));
    const maxTotal = Math.max(target, Number(opts.maxTotal || 300));
    const doExhaust = Boolean(opts.exhaust);
    const list = await collectResults(doExhaust ? maxTotal : target, doExhaust);
    debug({ info: 'gmaps_list_collected', count: list.length });

    // Enrich a few with details (website, phone) by clicking
    const detailCap = Boolean(opts.detailAll) ? list.length : Math.max(0, Number(opts.detailClicks || 5));
    const enriched = [];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      let website = null;
      let phone = null;
      let category = item.category || null;
      let address = item.address || null;
      let place_url = null;
      try {
        if (i < detailCap) {
          // Click the card by name text
          await page.evaluate((name) => {
            const cards = Array.from(document.querySelectorAll('div[role="article"], .Nv2PK'));
            for (const c of cards) {
              const h = c.querySelector('[role="heading"], .qBF1Pd, .NrDZNb');
              const t = h ? (h.textContent || '').trim() : '';
              if (t && t.toLowerCase() === String(name || '').toLowerCase()) {
                const clickable = c.querySelector('a[href*="/maps/place/"]') || c.querySelector('a');
                if (clickable) { clickable.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
                else { c.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
                break;
              }
            }
          }, item.name);
          await sleepMs(800);
          // Try to find website and phone buttons/links
          try {
            await page.waitForSelector('a[aria-label*="Website" i], a[data-item-id*="authority"], button[aria-label*="Phone" i], .Io6YTe', { timeout: 4000 });
          } catch {}
          const details = await page.evaluate(() => {
            const out = { website: null, phone: null, category: null, address: null, place_url: null };
            const w = document.querySelector('a[aria-label*="Website" i], a[data-item-id*="authority"]');
            if (w && w.href) out.website = w.href;
            // Phone appears in a button aria-label or in a span with tel text
            const pBtn = document.querySelector('button[aria-label*="Phone" i]');
            if (pBtn) {
              const m = (pBtn.getAttribute('aria-label') || '').match(/\+?[0-9][0-9\-()\s]+/);
              if (m) out.phone = m[0].trim();
            }
            if (!out.phone) {
              const tel = Array.from(document.querySelectorAll('a[href^="tel:"]')).map(a => a.getAttribute('href')).find(Boolean);
              if (tel) out.phone = tel.replace(/^tel:/i, '').trim();
            }
            // Category chip
            const cat = document.querySelector('[jsaction*="pane.rating.category"]') || document.querySelector('button[aria-label*="Category" i]');
            if (cat && cat.textContent) out.category = cat.textContent.trim();
            // Address block
            const addr = Array.from(document.querySelectorAll('.Io6YTe, .QSFF4-text'))
              .map(n => (n.textContent || '').trim())
              .find(t => /\d{2,5}\s+.+/i.test(t));
            if (addr) out.address = addr;
            const place = document.querySelector('a[href*="/maps/place/"]');
            if (place && place.href) out.place_url = place.href;
            return out;
          });
          website = details.website || null;
          phone = details.phone || null;
          category = details.category || category;
          address = details.address || address;
          place_url = details.place_url || null;
          // Navigate back to list (best-effort)
          try { await page.keyboard.press('Escape'); } catch {}
          await sleepMs(400);
        }
      } catch (e) {
        debug({ info: 'gmaps_detail_error', index: i, error: String(e && (e.message || e)) });
      }
      enriched.push({
        name: item.name,
        website: website || null,
        phone: phone || null,
        address: address || null,
        rating: item.rating == null ? null : item.rating,
        reviews_count: item.reviews_count == null ? null : item.reviews_count,
        categories: category ? [category] : null,
        gmaps_place_url: place_url || null,
        method: 'gmaps-puppeteer',
        fallback_used: false,
      });
    }

    return { rows: enriched, total: enriched.length };
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

module.exports = { crawlGoogleMaps };


