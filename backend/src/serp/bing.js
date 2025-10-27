const { load } = require('cheerio');
const { politeGet } = require('../utils/http');

function buildQueryUrl(q, page = 0, count = 10) {
  const safeCount = Math.max(1, Math.min(50, Number(count || 10)));
  const first = page * safeCount + 1;
  const params = new URLSearchParams({ q, first: String(first), count: String(safeCount), setmkt: 'en-US', cc: 'US' });
  return `https://www.bing.com/search?${params.toString()}`;
}

function extractResults(html) {
  const $ = load(html);
  const results = [];
  // Only iterate organic result items within main results list
  $('ol#b_results > li.b_algo').each((_, el) => {
    const a = $(el).find('h2 a').first();
    const title = a.text().trim();
    const link = a.attr('href');
    const snippet = $(el).find('.b_caption p').first().text().trim();
    if (title && link) {
      results.push({ title, link, snippet });
    }
  });
  return results;
}

function isSponsored($, el) {
  // Heuristics for Bing ad identification
  const root = $(el);
  const classAttr = root.attr('class') || '';
  const hasAdClass = /\b(b_ad|b_adTop|b_adBottom|b_algoAd|b_algoAdvert)\b/i.test(classAttr);
  const hasAdText = root.find('*').filter((_, n) => /\b(ad|sponsored)\b/i.test($(n).text().trim())).length > 0;
  const hasAriaLabel = root.find('[aria-label*="Ad" i],[aria-label*="Sponsored" i]').length > 0;
  return Boolean(hasAdClass || hasAdText || hasAriaLabel);
}

async function fetchSerp(query, pages = 1, opts = { skipAds: false, concurrency: 2, minDelayMs: 200, maxDelayMs: 500, count: 10, autoMaxPages: 50 }) {
  const limit = Math.max(1, Math.min(8, Number(opts.concurrency || 2)));
  // Auto pagination if pages === -1: continue until no results or cap
  if (Number(pages) === -1) {
    const results = [];
    let p = 0;
    while (p < Math.max(1, Number(opts.autoMaxPages || 50))) {
      const url = buildQueryUrl(query, p, opts.count || 10);
      const res = await politeGet(url, { minDelayMs: opts.minDelayMs, maxDelayMs: opts.maxDelayMs });
      let pageResults = extractResults(res.data);
      if (opts.skipAds) {
        const $ = load(res.data);
        pageResults = [];
        $('ol#b_results > li.b_algo').each((_, el) => {
          if (isSponsored($, el)) return; // skip sponsored
          const a = $(el).find('h2 a').first();
          const title = a.text().trim();
          const link = a.attr('href');
          const snippet = $(el).find('.b_caption p').first().text().trim();
          if (title && link) pageResults.push({ title, link, snippet });
        });
      }
      const adUrlPattern = /(bing\.com\/aclick|r\.msn\.com|go\.microsoft\.com\/fwlink)/i;
      pageResults = pageResults.filter(r => r.link && !adUrlPattern.test(r.link));
      if (!pageResults.length) break;
      results.push(...pageResults);
      p += 1;
    }
    return results;
  }

  const tasks = Array.from({ length: Math.max(1, Number(pages || 1)) }, (_, p) => p).map(p => async () => {
    const url = buildQueryUrl(query, p, opts.count || 10);
    const res = await politeGet(url, { minDelayMs: opts.minDelayMs, maxDelayMs: opts.maxDelayMs });
    let pageResults = extractResults(res.data);
    if (opts.skipAds) {
      const $ = load(res.data);
      pageResults = [];
      $('ol#b_results > li.b_algo').each((_, el) => {
        if (isSponsored($, el)) return; // skip sponsored
        const a = $(el).find('h2 a').first();
        const title = a.text().trim();
        const link = a.attr('href');
        const snippet = $(el).find('.b_caption p').first().text().trim();
        if (title && link) pageResults.push({ title, link, snippet });
      });
    }
    // Strip obvious ad redirect URLs regardless of skipAds flag
    const adUrlPattern = /(bing\.com\/aclick|r\.msn\.com|go\.microsoft\.com\/fwlink)/i;
    pageResults = pageResults.filter(r => r.link && !adUrlPattern.test(r.link));
    return pageResults;
  });

  const results = [];
  let i = 0;
  async function runNext() {
    if (i >= tasks.length) return;
    const my = i++;
    const out = await tasks[my]();
    results.push(...out);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runNext));
  return results;
}

module.exports = { fetchSerp };


