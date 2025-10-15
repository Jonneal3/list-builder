const assert = require('assert');
const { crawlApollo } = require('../crawlers/apollo');

(async () => {
  const city = process.env.TEST_CITY || 'New York, NY';
  const industry = process.env.TEST_INDUSTRY || 'house painting';
  const useCookies = Boolean(process.env.APOLLO_COOKIE_HEADER || process.env.APOLLO_COOKIES_JSON);
  const useApiKey = Boolean(process.env.APOLLO_API_KEY || process.env.APOLLO_API_TOKEN);

  if (!useCookies && !useApiKey) {
    console.log('[apollo.smoke] SKIP: no API key or cookies provided');
    process.exit(0);
  }

  const start = Date.now();
  const res = await crawlApollo(industry, city, {
    limit: 30,
    perPage: 25,
    maxPagesPerBucket: 2,
    onDebug: (e) => { if (e && e.info) console.log('[apollo.debug]', e); },
  });

  assert(res && Array.isArray(res.rows), 'Expected rows array');
  assert(res.rows.length >= 0, 'Expected non-negative rows length');
  for (const r of res.rows.slice(0, 5)) {
    assert(typeof r.name === 'string' && r.name.length > 0, 'Row has name');
  }
  const ms = Date.now() - start;
  console.log(`[apollo.smoke] OK rows=${res.rows.length} total=${res.total ?? 'n/a'} timeMs=${ms}`);
  process.exit(0);
})().catch((err) => {
  console.error('[apollo.smoke] FAIL', err && (err.stack || err));
  process.exit(1);
});


