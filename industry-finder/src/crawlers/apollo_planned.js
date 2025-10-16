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
  onDebug,
  emit,
  onRow,
}) {
  const debug = (e) => { try { if (typeof onDebug === 'function') onDebug(e); } catch {} };
  const outRows = [];
  const seen = new Set();

  function keyOf(r) {
    return `${String(r.name || '').toLowerCase()}|${String(r.website || '').toLowerCase()}`;
  }

  async function scrapeAndDeliver(listUrl, label) {
    try {
      debug({ source: 'apollo', info: 'planned_nav', url: listUrl, label });
      const rows = await scrapeApolloWithSession(page, null, null, { apolloListUrl: listUrl, uiPages, onDebug, label });
      for (const r of rows) {
        const k = keyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
        outRows.push(r);
        const payload = { type: 'row', source: 'apollo', ...r, apollo_profile_url: r._profileUrl || null, method: r.method || 'apollo-planned', query: (keywords || []).join(', ') };
        if (emit) emit(payload);
        if (typeof onRow === 'function') { try { await onRow(payload); } catch {} }
      }
      return rows.length;
    } catch (e) {
      debug({ source: 'apollo', info: 'planned_error', error: String(e && (e.message || e)), url: listUrl, label });
      return 0;
    }
  }

  // Step 0: Base scrape scoped to United States so initial 125 are US-only
  // If Apollo expects a country token, "United States" works in the UI
  const baseUrl = buildCompaniesUrl({ keywords, page: 1, locations: ['United States'] });
  const baseCount = await scrapeAndDeliver(baseUrl, 'base');
  debug({ source: 'apollo', info: 'planned_base_done', rows: baseCount });

  // Step 1: Iterate states
  for (const state of US_STATES) {
    const beforeStateSeen = seen.size;
    if (emit) emit({ type: 'status', source: 'apollo', message: 'state_start', state });
    const stateUrl = buildCompaniesUrl({ keywords, page: 1, locations: [state] });
    const stateCount = await scrapeAndDeliver(stateUrl, `state:${state}`);
    if (stateCount <= 125 && stateCount > 0) {
      continue; // state fit into 5 pages; we already scraped its first 5 pages
    }
    if (stateCount === 0) {
      continue; // nothing here
    }
    // Step 1b: Iterate employee buckets within the state
    for (const rng of EMPLOYEE_BUCKETS) {
      const url = buildCompaniesUrl({ keywords, page: 1, locations: [state], employeeRanges: [rng] });
      await scrapeAndDeliver(url, `state:${state}|emp:${rng}`);
    }
    const addedInState = seen.size - beforeStateSeen;
    if (emit) emit({ type: 'status', source: 'apollo', message: 'state_done', state, added: addedInState });
  }

  return outRows;
}

module.exports = { plannedApolloScrape };


