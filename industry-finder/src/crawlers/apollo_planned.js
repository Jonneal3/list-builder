const { buildCompaniesUrl } = require('../apollo/url');
const { US_STATES, EMPLOYEE_BUCKETS } = require('../apollo/filters');
const { crawlApollo, createApolloSession, scrapeApolloWithSession, closeApolloSession } = require('./apollo');

/**
 * Planned Apollo scraper implementing:
 * - Base keyword scrape (first 5 pages/125 records)
 * - Iterate by state; if >125, iterate by employee buckets within that state
 * - Stream results via provided emit function
 * - Deduplicate across the run using seen keys
 */
async function plannedApolloScrape({
  page,
  keywords,
  apolloListUrl,
  uiPages = 5,
  maxPagesPerBucket,
  industryTagIds,
  onDebug,
  emit,
  onRow,
}) {
  const debug = (e) => { try { if (typeof onDebug === 'function') onDebug(e); } catch {} };
  const outRows = [];
  const seen = new Set();

  function extractApolloOrgId(u) {
    try {
      if (!u) return '';
      const abs = String(u).startsWith('http') ? String(u) : `https://app.apollo.io/${String(u).replace(/^#\/?/, '')}`;
      const url = new URL(abs);
      const idx = url.pathname.indexOf('/organizations/');
      if (idx !== -1) {
        const rest = url.pathname.slice(idx + '/organizations/'.length);
        const id = rest.split(/[\/?#]/)[0];
        return id || '';
      }
      const hash = url.hash || '';
      const m = hash.match(/organizations\/([^\/?#]+)/);
      return m ? m[1] : '';
    } catch { return ''; }
  }
  function normalizeHost(url) {
    try { const u = new URL(url); return (u.hostname || '').replace(/^www\./,'').toLowerCase(); } catch { return ''; }
  }
  function isGenericHost(host) {
    if (!host) return false;
    const h = String(host).toLowerCase();
    const GENERIC = [
      'facebook.com','linkedin.com','twitter.com','x.com','instagram.com','youtube.com',
      'yelp.com','homeadvisor.com','angi.com','angiesteam.com','bbb.org','google.com',
      'sites.google.com','wix.com','wixsite.com','wordpress.com','blogspot.com','godaddysites.com',
      'square.site','squarespace.com','weebly.com','webs.com','hubspotpagebuilder.com',
    ];
    return GENERIC.some(g => h === g || h.endsWith('.' + g));
  }
  function keyOf(r) {
    const orgId = extractApolloOrgId(r.profileUrl || r._profileUrl || r.apollo_profile_url || '');
    if (orgId) return `apollo:${orgId}`;
    const host = normalizeHost(r.companyUrl || r.website || '');
    if (host && !isGenericHost(host)) return `host:${host}`;
    const nameLc = String(r.companyName || r.name || '').toLowerCase();
    const stateLc = String(r.address_state || r.state || '').toLowerCase();
    const cityLc = String(r.address_city || r.city || '').toLowerCase();
    if (nameLc && (stateLc || cityLc)) return `name:${nameLc}|loc:${stateLc || cityLc}`;
    return `name:${nameLc}`;
  }

  const readTotalForUrl = async (listUrl, label) => {
    try {
      debug({ source: 'apollo', info: 'planned_count_start', url: listUrl, label });
      const WATCHDOG_MS = 6500;
      let lastTotal = null;
      let blocked = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        blocked = false;
        lastTotal = null;
        let timedOut = true;
        await Promise.race([
          (async () => {
            await scrapeApolloWithSession(page, null, null, {
              apolloListUrl: listUrl,
              uiPages: 1,
              label,
              onDebug: (e) => {
                try {
                  // Suppress per-row debug during count-only pass
                  if (e && e.info === 'row') return;
                  if (e && e.info === 'http_response' && Number(e.status) === 401) blocked = true;
                  if (e && e.info === 'total_count_simple' && typeof e.totalCount === 'number') {
                    lastTotal = e.totalCount;
                  }
                } catch {}
                try { if (typeof onDebug === 'function') onDebug(e); } catch {}
              },
            });
            timedOut = false;
          })(),
          new Promise((resolve) => setTimeout(resolve, attempt === 1 ? WATCHDOG_MS : 15000)),
        ]);

        if (typeof lastTotal === 'number' && lastTotal >= 0 && !blocked) {
          break;
        }

        // Abort any lingering navigation/evaluations from the raced task to avoid overlaps
        try { await page.evaluate(() => { try { window.stop && window.stop(); } catch {} }); } catch {}
        try { await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }); } catch {}

        // Backoff before retrying if blocked or timed out
        if (blocked) {
          debug({ source: 'apollo', info: 'cloudflare_blocked_retry', attempt });
        } else if (timedOut) {
          debug({ source: 'apollo', info: 'count_watchdog_retry', attempt });
        }
        try { await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random()*600))); } catch {}
      }

      if (typeof lastTotal !== 'number') lastTotal = 0;
      debug({ source: 'apollo', info: 'planned_count_done', url: listUrl, label, total: lastTotal });
      return lastTotal;
    } catch (e) {
      debug({ source: 'apollo', info: 'planned_count_error', error: String(e && (e.message || e)), url: listUrl, label });
      return null;
    }
  };

  async function scrapeAndDeliver(listUrl, label, pagesOverride) {
    try {
      debug({ source: 'apollo', info: 'planned_nav', url: listUrl, label });
      let lastTotal = null;
      const rows = await scrapeApolloWithSession(page, null, null, { apolloListUrl: listUrl, uiPages: (pagesOverride || uiPages), label, onDebug: (e) => {
        try {
          if (e && e.info === 'total_count_simple' && typeof e.totalCount === 'number') {
            lastTotal = e.totalCount;
          }
        } catch {}
        try { if (typeof onDebug === 'function') onDebug(e); } catch {}
      } });
      for (const r of rows) {
        const k = keyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
        outRows.push(r);
        const payload = { type: 'row', source: 'apollo', ...r, apollo_profile_url: r.profileUrl || r._profileUrl || null, method: r.method || 'apollo-planned', query: (keywords || []).join(', ') };
        if (emit) emit(payload);
        if (typeof onRow === 'function') { try { await onRow(payload); } catch {} }
      }
      return { count: rows.length, total: lastTotal };
    } catch (e) {
      debug({ source: 'apollo', info: 'planned_error', error: String(e && (e.message || e)), url: listUrl, label });
      return { count: 0, total: null };
    }
  }

  async function readBucketTotalUI(range, label) {
    let lastTotal = null;
    await scrapeApolloWithSession(page, null, null, {
      skipNavigate: true,
      setEmployeeRange: range,
      uiPages: 1,
      countOnly: true,
      label,
      onDebug: (e) => {
        try {
          if (e && e.info === 'total_count_simple' && typeof e.totalCount === 'number') {
            lastTotal = e.totalCount;
          }
        } catch {}
        try { if (typeof onDebug === 'function') onDebug(e); } catch {}
      },
    });
    return typeof lastTotal === 'number' ? lastTotal : 0;
  }

  async function scrapeBucketUI(range, label, pagesOverride) {
    let lastTotal = null;
    const rows = await scrapeApolloWithSession(page, null, null, {
      skipNavigate: true,
      setEmployeeRange: range,
      uiPages: (pagesOverride || uiPages),
      label,
      onDebug: (e) => {
        try {
          if (e && e.info === 'total_count_simple' && typeof e.totalCount === 'number') {
            lastTotal = e.totalCount;
          }
        } catch {}
        try { if (typeof onDebug === 'function') onDebug(e); } catch {}
      },
    });
    let count = 0;
    for (const r of rows) {
      const k = keyOf(r);
      if (seen.has(k)) continue;
      seen.add(k);
      outRows.push(r);
      count += 1;
      const payload = { type: 'row', source: 'apollo', ...r, apollo_profile_url: r.profileUrl || r._profileUrl || null, method: r.method || 'apollo-planned', query: (keywords || []).join(', ') };
      if (emit) emit(payload);
      if (typeof onRow === 'function') { try { await onRow(payload); } catch {} }
    }
    return { count, total: lastTotal };
  }

  // Step 0: Base scrape scoped to United States so initial 125 are US-only
  // If Apollo expects a country token, "United States" works in the UI
  const baseUrl = buildCompaniesUrl({ keywords, page: 1, locations: ['United States'], industryTagIds: Array.isArray(industryTagIds) ? industryTagIds : [] });
  const baseTotal = await readTotalForUrl(baseUrl, 'base');
  debug({ source: 'apollo', info: 'planned_base_total', total: baseTotal });
  if (typeof baseTotal === 'number') {
    if (emit) emit({ type: 'debug', source: 'apollo', info: 'us_goal_total', total: baseTotal });
  }
  const base = await scrapeAndDeliver(baseUrl, 'base');
  debug({ source: 'apollo', info: 'planned_base_done', rows: base.count, total: base.total });

  // Step 1: Iterate states
  for (const state of US_STATES) {
    const beforeStateSeen = seen.size;
    if (emit) emit({ type: 'status', source: 'apollo', message: 'state_start', state });
    const stateUrl = buildCompaniesUrl({ keywords, page: 1, locations: [state], industryTagIds: Array.isArray(industryTagIds) ? industryTagIds : [] });
    const stateTotal = await readTotalForUrl(stateUrl, `state:${state}`);
    debug({ source: 'apollo', info: 'planned_state_total', state, total: stateTotal });
    const stateRes = (stateTotal != null && stateTotal <= 125 && stateTotal > 0)
      ? await scrapeAndDeliver(stateUrl, `state:${state}`)
      : { count: 0, total: stateTotal };
    // If the state's estimated total fits within the first 5 pages, we already captured it
    if (stateTotal != null && stateTotal <= 125 && stateTotal > 0) {
      continue; // state fit into 5 pages; we already scraped its first 5 pages
    }
    if (stateRes.count === 0 && (stateTotal == null || stateTotal === 0)) {
      continue; // nothing here
    }

    // Navigate once to the state page to establish context for UI-based bucket filtering
    await scrapeApolloWithSession(page, null, null, {
      apolloListUrl: stateUrl,
      uiPages: 1,
      label: `state:${state}`,
      onDebug: (e) => { try { if (typeof onDebug === 'function') onDebug(e); } catch {} },
      countOnly: true,
    });

    // Step 1b: Iterate employee buckets within the state using UI, without reloads
    for (const rng of EMPLOYEE_BUCKETS) {
      const bucketTotal = await readBucketTotalUI(rng, `state:${state}|emp:${rng}`);
      debug({ source: 'apollo', info: 'planned_bucket_total', state, range: rng, total: bucketTotal });
      // If zero, skip scraping this bucket entirely
      if (bucketTotal === 0) {
        if (emit) emit({ type: 'status', source: 'apollo', message: 'bucket_skip_zero', state, range: rng });
        continue;
      }
      // If manageable (<=125), scrape fully within cap; otherwise still scrape up to bucket cap
      const pagesCap = Math.max(1, Number(maxPagesPerBucket || uiPages || 5));
      await scrapeBucketUI(rng, `state:${state}|emp:${rng}`, pagesCap);
    }
    const addedInState = seen.size - beforeStateSeen;
    if (emit) emit({ type: 'status', source: 'apollo', message: 'state_done', state, added: addedInState });
  }

  return outRows;
}

module.exports = { plannedApolloScrape };


