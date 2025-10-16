// Minimal File polyfill for environments where global File is missing
if (typeof File === 'undefined' && typeof Blob !== 'undefined') {
  globalThis.File = class File extends Blob {
    constructor(chunks = [], name = 'file', options = {}) {
      super(chunks, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

const minimist = require('minimist');
const path = require('path');
const fs = require('fs');
const { initDb, upsertCompany, listCompanies, normalizeDomain, dbPath } = require('./db/sqlite');
const { crawlYellowPages } = require('./crawlers/yellowpages');
const { crawlApollo, createApolloSession, scrapeApolloWithSession, closeApolloSession } = require('./crawlers/apollo');
const { crawlGoogleMaps } = require('./crawlers/googlemaps');
const { plannedApolloScrape } = require('./crawlers/apollo_planned');
const { exportToCsv } = require('./exporter/csv');
const { exportToJson } = require('./exporter/json');
const { createLogger } = require('./utils/logger');
const { sleep } = require('./utils/http');

async function main() {
  let shuttingDown = false;
  const argv = minimist(process.argv.slice(2));
  const industry = argv.industry || 'flooring';
  const city = argv.city || 'New York';
  const ypPages = Number.isFinite(Number(argv.ypPages)) ? Number(argv.ypPages) : Number(argv.pages || 1);
  let ypConcurrency = Math.max(1, Number(argv.ypConcurrency || 2));
  const minDelayMs = Number.isFinite(Number(argv.minDelayMs)) ? Number(argv.minDelayMs) : 200;
  const maxDelayMs = Number.isFinite(Number(argv.maxDelayMs)) ? Number(argv.maxDelayMs) : 500;
  const useBrowserFallback = String(argv.browserFallback || 'false').toLowerCase() === 'true';
  const pageTimeoutMs = Math.max(5000, Number(argv.pageTimeoutMs || 20000));
  const puppeteerProxy = argv.puppeteerProxy || null;
  const puppeteerProxyUser = argv.puppeteerProxyUser || null;
  const puppeteerProxyPass = argv.puppeteerProxyPass || null;
  const headless = String(argv.headless || 'true').toLowerCase() !== 'false';
  const maxRetriesPerPage = Math.max(1, Number(argv.maxRetriesPerPage || 2));
  const useFreeProxies = String(argv.useFreeProxies || 'false').toLowerCase() === 'true';
  const proxyCountry = (argv.proxyCountry || '').toUpperCase() || null;
  const proxyTypes = String(argv.proxyTypes || 'http,https');
  const proxyLimit = Math.max(1, Math.min(50, Number(argv.proxyLimit || 10)));
  const forceBrowserFirst = String(argv.forceBrowserFirst || 'false').toLowerCase() === 'true';
  const pageJitterMinMs = Math.max(0, Number(argv.pageJitterMinMs || 800));
  const pageJitterMaxMs = Math.max(pageJitterMinMs, Number(argv.pageJitterMaxMs || 2000));
  const rotateViewport = String(argv.rotateViewport || 'false').toLowerCase() === 'true';
  const puppeteerPages = Math.max(1, Number(argv.puppeteerPages || 1));
  const exhaustCity = String(argv.exhaustCity || 'false').toLowerCase() === 'true';
  if (exhaustCity && typeof argv.ypConcurrency === 'undefined') {
    ypConcurrency = 1; // strictly sequential per-city to fully exhaust YP pages
  }
  const maxPasses = Math.max(1, Number(argv.maxPasses || 1));
  const stalePasses = Math.max(1, Number(argv.stalePasses || 1));
  const autoMaxPagesYp = Math.max(1, Number(argv.autoMaxPagesYp || argv.autoMaxPages || 50));
  const isVercel = Boolean(process.env.VERCEL);
  const outDir = argv.output ? path.resolve(String(argv.output)) : (isVercel ? '/tmp/exports' : path.join(__dirname, '../exports'));
  const format = (argv.format || 'csv').toLowerCase(); // csv|json|both
  const verbose = Boolean(argv.verbose);
  const stream = Boolean(argv.stream);
  const citiesFile = argv.citiesFile ? path.resolve(String(argv.citiesFile)) : null;
  const allCities = Boolean(argv.allCities);
  const enableGmaps = String(argv.enableGmaps || 'false').toLowerCase() === 'true';
  const onlyApollo = String(argv.onlyApollo || 'false').toLowerCase() === 'true';
  const gmapsLimit = Math.max(1, Number(argv.gmapsLimit || 25));
  const gmapsDetailClicks = Math.max(0, Number(argv.gmapsDetailClicks || 5));
  const onlyGmaps = String(argv.onlyGmaps || 'false').toLowerCase() === 'true';
  const gmapsExhaust = String(argv.gmapsExhaust || 'false').toLowerCase() === 'true';
  const gmapsMaxTotal = Math.max(gmapsLimit, Number(argv.gmapsMaxTotal || 500));
  const gmapsDetailAll = String(argv.gmapsDetailAll || 'false').toLowerCase() === 'true';
  // Apollo controls
  const enableApollo = String(argv.enableApollo || 'true').toLowerCase() === 'true';
  const apolloLimit = Math.max(1, Number(argv.apolloLimit || 50));
  const apolloPerPage = Math.max(1, Number(argv.apolloPerPage || 25));
  const apolloMaxPagesPerBucket = Math.max(1, Number(argv.apolloMaxPagesPerBucket || 5));
  const apolloCookieHeader = argv.apolloCookieHeader ? String(argv.apolloCookieHeader) : (process.env.APOLLO_COOKIE_HEADER || null);
  const apolloCookiesJson = argv.apolloCookiesJson ? String(argv.apolloCookiesJson) : (process.env.APOLLO_COOKIES_JSON || null);
  const apolloLogin = String(argv.apolloLogin || 'false').toLowerCase() === 'true';
  const apolloManualLogin = String(argv.apolloManualLogin || 'false').toLowerCase() === 'true';
  const apolloEmail = argv.apolloEmail ? String(argv.apolloEmail) : (process.env.APOLLO_EMAIL || null);
  const apolloPassword = argv.apolloPassword ? String(argv.apolloPassword) : (process.env.APOLLO_PASSWORD || null);
  const apolloListUrl = argv.apolloListUrl ? String(argv.apolloListUrl) : null;
  const uiPages = Math.max(1, Number(argv.uiPages || 5));
  // Optional custom buckets via CLI JSON, e.g. --apolloBuckets='[{"min":100,"max":149},{"min":75,"max":99}]'
  let apolloBuckets = [];
  try {
    if (argv.apolloBuckets) {
      const parsed = JSON.parse(String(argv.apolloBuckets));
      if (Array.isArray(parsed)) {
        apolloBuckets = parsed
          .map(b => ({ min: (b && b.min != null) ? Number(b.min) : null, max: (b && b.max != null) ? Number(b.max) : null }))
          .filter(b => (b.min != null || b.max != null));
      }
    }
  } catch {}

  const log = createLogger(verbose);
  log.info(`Run start industry="${industry}" city="${city}" ypPages=${ypPages} format=${format} outDir=${outDir}`);

  // Graceful shutdown: close shared sessions/browsers on stop
  let apolloSession = null;
  async function cleanup(reason = 'signal') {
    if (shuttingDown) return;
    shuttingDown = true;
    try { if (apolloSession) await closeApolloSession(apolloSession); } catch {}
    try { emit({ type: 'status', message: 'stopped', reason }); } catch {}
  }
  process.on('SIGINT', () => cleanup('SIGINT').then(() => process.exit(0)));
  process.on('SIGTERM', () => cleanup('SIGTERM').then(() => process.exit(0)));

  function emit(event) {
    if (!stream) return;
    try { process.stdout.write(JSON.stringify(event) + '\n'); } catch {}
  }

  const doFresh = String(argv.fresh || 'false').toLowerCase() === 'true';
  if (doFresh) {
    try {
      // Delete the exact DB file used by sqlite (respects IF_DB_PATH)
      const dbFile = dbPath;
      // Remove main DB and WAL/SHM sidecars to avoid corruption/IOERR
      try { fs.unlinkSync(dbFile); } catch {}
      try { fs.unlinkSync(dbFile + '-wal'); } catch {}
      try { fs.unlinkSync(dbFile + '-shm'); } catch {}
      console.log(`DB reset at: ${dbFile}`);
      if (stream) { try { process.stdout.write(JSON.stringify({ type: 'status', message: 'db_reset', path: dbFile }) + '\n'); } catch {} }
    } catch {}
  }
  const db = initDb();

  // Check database state before starting
  const initialRows = listCompanies(db);
  console.log(`Database has ${initialRows.length} rows before starting`);
  if (initialRows.length > 0) {
    console.log('⚠️  Database already has data - this might be from previous runs');
  }

  const cityList = (() => {
    if (citiesFile && fs.existsSync(citiesFile)) {
      try {
        const text = fs.readFileSync(citiesFile, 'utf8');
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {}
    }
    if (allCities) {
      // Built-in fallback list (population ~35k+). Keep small and fast.
      const DEFAULT_US_CITIES_35K = [
        'New York, NY','Los Angeles, CA','Chicago, IL','Houston, TX','Phoenix, AZ',
        'Philadelphia, PA','San Antonio, TX','San Diego, CA','Dallas, TX','San Jose, CA',
        'Austin, TX','Jacksonville, FL','Fort Worth, TX','Columbus, OH','Charlotte, NC',
        'San Francisco, CA','Indianapolis, IN','Seattle, WA','Denver, CO','Washington, DC',
        'Boston, MA','El Paso, TX','Nashville, TN','Detroit, MI','Oklahoma City, OK'
      ];
      return DEFAULT_US_CITIES_35K;
    }
    return [city];
  })();

  // Optional: create a single Apollo session to reuse across cities
  if (enableApollo) {
    try {
        console.log('Creating Apollo session...');
        apolloSession = await createApolloSession({
          apolloLogin: apolloLogin,
          apolloEmail,
          apolloPassword,
          headless,
          pageTimeoutMs,
          rotateViewport,
          puppeteerProxy,
          puppeteerProxyUser,
          puppeteerProxyPass,
          cookieHeader: apolloCookieHeader,
          apolloManualLogin,
        });
      if (!apolloSession) {
        log.warn('Apollo session not created');
      } else {
        console.log('Apollo session created successfully');
      }
      
      // If manual login is requested, emit status and wait for confirmation
      if (apolloManualLogin && apolloSession && apolloSession.page) {
        emit({ type: 'status', source: 'apollo', message: 'awaiting_manual_login' });
        
        // Wait for user to confirm login in the UI
        // We'll use a simple file-based signaling mechanism
        console.log('Waiting for Apollo login confirmation...');
        // Resolve to repo root/industry-finder so it matches the Next API write location
        const signalFile = path.join(__dirname, '..', 'apollo_login_signal.tmp');
        try { fs.unlinkSync(signalFile); } catch {} // Clean up any existing signal
        
        const deadline = Date.now() + 300000; // 5 minutes timeout
        while (Date.now() < deadline) {
          try {
            if (fs.existsSync(signalFile)) {
              fs.unlinkSync(signalFile); // Clean up
              console.log('Apollo login confirmed via signal file');
              emit({ type: 'status', source: 'apollo', message: 'manual_login_detected' });
              
              // After manual login, navigate to companies page and wait a bit
              try {
                console.log('Navigating to companies page after manual login...');
                await apolloSession.page.goto('https://app.apollo.io/#/companies', { waitUntil: 'domcontentloaded', timeout: 10000 });
                await new Promise(resolve => setTimeout(resolve, 2000));
                console.log('Successfully navigated to companies page');
              } catch (e) {
                console.log('Error navigating to companies page:', e.message);
              }
              break;
            }
          } catch (e) {
            console.log('Error checking signal file:', e.message);
          }
          await new Promise(resolve => setTimeout(resolve, 1000)); // Check every second
        }
      }
    } catch (e) {
      log.warn(`Apollo session failed: ${e?.message || e}`);
      apolloSession = null;
    }
  }

  // Apollo.io (run once before city loop since it doesn't use location filtering)
  if (!onlyGmaps && enableApollo) {
    try {
      if (shuttingDown) { emit({ type: 'status', source: 'apollo', message: 'skipped_shutdown' }); throw new Error('shutdown'); }
      emit({ type: 'status', source: 'apollo', message: 'start' });
      let aRows = [];
      console.log(`Apollo session check: ${apolloSession ? 'exists' : 'null'}, page: ${apolloSession?.page ? 'exists' : 'null'}`);
      if (apolloSession && apolloSession.page) {
        try { if (typeof apolloSession.page.isClosed === 'function' && apolloSession.page.isClosed()) { apolloSession.page = await apolloSession.browser.newPage(); await apolloSession.page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: Math.max(8000, Number(pageTimeoutMs || 20000)) }); } } catch {}
        try {
          console.log(`Starting Apollo scraping (planned) for ${industry}...`);
          emit({ type: 'debug', source: 'apollo', message: 'scrape_planned_start', industry });
          const keywords = String(industry || '').split(',').map(s => s.trim()).filter(Boolean);
          const seenKeys = new Set();
          const keyOf = (r) => `${String(r.name || '').toLowerCase()}|${String(r.website || '').toLowerCase()}`;
          aRows = await plannedApolloScrape({
            page: apolloSession.page,
            keywords,
            apolloListUrl: apolloListUrl || null,
            uiPages,
            onDebug: (e) => emit({ type: 'debug', source: 'apollo', ...e }),
            emit: (evt) => {
              if (!evt || evt.type !== 'row') return;
              const k = keyOf(evt);
              if (seenKeys.has(k)) return;
              seenKeys.add(k);
              try {
                upsertCompany(db, {
                  name: evt.name,
                  website: evt.website || null,
                  industry,
                  location: null,
                  source_list: ['apollo'],
                  size_category: evt.employeeCount || null,
                  phone: evt.phone || null,
                  address: evt.address || null,
                  address_street: null,
                  address_city: evt.address_city || null,
                  address_state: evt.address_state || null,
                  address_postal_code: null,
                  rating: typeof evt.rating === 'number' ? evt.rating : null,
                  reviews_count: Number.isFinite(evt.reviews_count) ? evt.reviews_count : null,
                  categories: Array.isArray(evt.categories) ? evt.categories : (evt.categories ? [evt.categories] : null),
                  yp_listing_url: evt.apollo_profile_url || null,
                  hours_text: evt.hours_text || null,
                  email: evt.email || null,
                  description: evt.description || null,
                  social_profiles: evt.socialProfiles ? JSON.stringify(evt.socialProfiles) : null,
                  keywords: evt.keywords || null,
                  employee_count: evt.employeeCount || null,
                  revenue: evt.revenue || null,
                  linkedin_url: evt.linkedin_url || (evt.socialProfiles && evt.socialProfiles.linkedin) || null,
                  facebook_url: evt.facebook_url || (evt.socialProfiles && evt.socialProfiles.facebook) || null,
                  twitter_url: evt.twitter_url || (evt.socialProfiles && evt.socialProfiles.twitter) || null,
                  apollo_profile_url: evt.apollo_profile_url || evt._profileUrl || null,
                });
              } catch {}
              emit(evt);
            },
          });
          emit({ type: 'debug', source: 'apollo', message: 'scrape_planned_done', rows: Array.isArray(aRows) ? aRows.length : 0 });
          console.log(`Apollo planned scraping completed: ${aRows.length} companies found`);
          if (aRows && aRows.length > 0) {
            console.log(`Apollo found ${aRows.length} companies`);
          } else {
            console.log(`Apollo found NO companies - this will trigger fallback`);
          }
        } catch (e) {
          console.log(`Apollo scrape error: ${e?.message || e}`);
          log.warn(`Apollo scrape (session) failed: ${e?.message || e}`);
        }
      } else {
        console.log('Apollo session or page is null, skipping Apollo scraping');
      }
      if (!aRows || aRows.length === 0) {
        // Fallback to one-off crawl (will login internally) if session scraping found nothing
        try {
          if (apolloManualLogin) throw new Error('manual_login_mode_no_fallback');
          if (shuttingDown) throw new Error('shutdown');
          const apollo = await crawlApollo(industry, null, {
            limit: apolloLimit,
            perPage: apolloPerPage,
            cookieHeader: apolloCookieHeader,
            apolloLogin,
            apolloEmail,
            apolloPassword,
            headless,
            pageTimeoutMs,
            rotateViewport,
            puppeteerProxy,
            puppeteerProxyUser,
            puppeteerProxyPass,
            apolloListUrl,
            uiPages,
            onDebug: (e) => emit({ type: 'debug', source: 'apollo', ...e }),
          });
          aRows = Array.isArray(apollo) ? apollo : apollo?.rows || [];
        } catch (e) {
          log.warn(`Apollo crawl fallback failed: ${e?.message || e}`);
        }
      }
      console.log(`Processing ${aRows.length} Apollo rows...`);
      if (aRows.length === 0) {
        console.log('⚠️  Apollo returned 0 results - this means no companies were scraped!');
        emit({ type: 'status', source: 'apollo', message: 'no_results', error: 'Apollo returned 0 companies' });
      }
      for (const row of aRows) {
        if (shuttingDown) break;
        try {
          console.log(`Adding Apollo company: ${row.name}`);
          upsertCompany(db, {
            name: row.name,
            website: row.website || null,
            industry,
            location: null, // Apollo doesn't use location filtering
            source_list: ['apollo'],
            size_category: row.employeeCount || row.size_category || null,
            phone: row.phone || null,
            address: row.address || null,
            address_street: row.address_street || null,
            address_city: row.address_city || null,
            address_state: row.address_state || null,
            address_postal_code: row.address_postal_code || null,
            rating: typeof row.rating === 'number' ? row.rating : null,
            reviews_count: Number.isFinite(row.reviews_count) ? row.reviews_count : null,
            categories: Array.isArray(row.categories) ? row.categories : (row.categories ? [row.categories] : null),
            yp_listing_url: row.apolloProfileUrl || row._profileUrl || null,
            hours_text: null,
            email: row.email || null,
            description: row.description || null,
            social_profiles: row.socialProfiles ? JSON.stringify(row.socialProfiles) : null,
          });
          emit({ type: 'row', name: row.name, website: row.website || null, phone: row.phone || null, address: row.address || null, rating: row.rating ?? null, reviews_count: row.reviews_count ?? null, categories: row.categories || null, industry, location: null, source: 'apollo', method: row.method || 'apollo-api', page: null, query: industry, fallback_used: Boolean(row.fallback_used) });
        } catch (e) {
          console.log(`Error adding Apollo company ${row.name}:`, e.message);
        }
      }
      emit({ type: 'status', source: 'apollo', message: 'done', rows: aRows.length });
      log.info(`Apollo rows (summary): ${aRows.length}`);
      
      // Check database state after Apollo
      const afterApolloRows = listCompanies(db);
      console.log(`Database has ${afterApolloRows.length} rows after Apollo (was ${initialRows.length})`);
      const apolloAdded = afterApolloRows.length - initialRows.length;
      console.log(`Apollo added ${apolloAdded} new rows to database`);
    } catch (e) {
      emit({ type: 'status', source: 'apollo', message: 'skipped', error: String(e?.message || e) });
      log.warn(`Apollo fetch skipped: ${e?.message || e}`);
    }
  }

  // If onlyApollo is requested, skip the entire city loop since Apollo doesn't use cities
  if (onlyApollo) {
    emit({ type: 'status', message: 'apollo_only_mode', message: 'Apollo completed - no city processing needed' });
  } else {
    // Run city loop for YellowPages and Google Maps only
    for (const cityName of cityList) {
      if (shuttingDown) break;
      emit({ type: 'status', message: `city_start`, city: cityName });

      const ypPagesUse = exhaustCity ? -1 : ypPages;

    let passes = 0;
    let stale = 0;
    while (passes < maxPasses && stale < stalePasses) {
      passes += 1;
      emit({ type: 'status', message: 'city_pass_start', city: cityName, pass: passes });

      const beforeDomains = new Set();
      try {
        for (const row of listCompanies(db)) {
          if (row.location !== cityName) continue;
          if (!row.website) continue;
          const nd = normalizeDomain(row.website);
          if (nd) beforeDomains.add(nd);
        }
      } catch {}

    if (!onlyGmaps) try {
        // Optionally fetch a small pool of free proxies (Proxifly JSON) and pass to YP
        let proxyList = [];
        if (useFreeProxies) {
          try {
            const axios = require('axios');
            const types = proxyTypes.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            // Proxifly JSON endpoint
            const url = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.json';
            const res = await axios.get(url, { timeout: 10000 });
            const arr = Array.isArray(res.data) ? res.data : [];
            const filtered = arr.filter(p => {
              if (!p || typeof p !== 'object') return false;
              if (proxyCountry && String(p.country || '').toUpperCase() !== proxyCountry) return false;
              const proto = String(p.protocol || p.type || '').toLowerCase();
              if (!types.includes(proto)) return false;
              if (p.anonymity && String(p.anonymity).toLowerCase().includes('transparent')) return false;
              return Boolean(p.ip && p.port);
            }).slice(0, proxyLimit);
            proxyList = filtered.map(p => `${String(p.protocol || 'http')}://${p.ip}:${p.port}`);
            emit({ type: 'debug', source: 'proxies', message: 'free_proxies_loaded', count: proxyList.length, country: proxyCountry || 'ANY', types });
          } catch (e) {
            emit({ type: 'debug', source: 'proxies', message: 'free_proxies_failed', error: String(e && (e.message || e)) });
          }
        }
      const yp = await crawlYellowPages(industry, cityName, ypPagesUse, {
          concurrency: ypConcurrency,
          minDelayMs,
          maxDelayMs,
          autoMaxPages: autoMaxPagesYp,
          onDebug: (e) => emit({ type: 'debug', source: 'yellowpages', city: cityName, ...e }),
          onRows: (pageRows, pageNum) => {
            try {
              for (const row of Array.isArray(pageRows) ? pageRows : []) {
                upsertCompany(db, {
                  name: row.name,
                  website: row.website || null,
                  industry,
                  location: cityName,
                  source_list: ['yellowpages'],
                  size_category: null,
                  phone: row.phone || null,
                  address: row.address || null,
                  address_street: row.address_street || null,
                  address_city: row.address_city || null,
                  address_state: row.address_state || null,
                  address_postal_code: row.address_postal_code || null,
                  rating: typeof row.rating === 'number' ? row.rating : null,
                  reviews_count: Number.isFinite(row.reviews_count) ? row.reviews_count : null,
                  categories: Array.isArray(row.categories) ? row.categories : null,
                  yp_listing_url: row.yp_listing_url || null,
                  hours_text: row.hours_text || null,
                  email: row.email || null,
                });
                emit({ type: 'row', name: row.name, website: row.website || null, phone: row.phone || null, address: row.address || null, rating: row.rating ?? null, reviews_count: row.reviews_count ?? null, categories: row.categories || null, yp_listing_url: row.yp_listing_url || null, hours_text: row.hours_text || null, email: row.email || null, industry, location: cityName, source: 'yellowpages', method: row.method || 'yp-cheerio', page: pageNum, query: industry, fallback_used: Boolean(row.fallback_used) });
              }
            } catch {}
          },
          useBrowserFallback,
          pageTimeoutMs,
          puppeteerProxy,
          puppeteerProxyUser,
          puppeteerProxyPass,
          headless,
          maxRetriesPerPage,
          proxyList,
          rotateProxies: proxyList.length > 0,
          forceBrowserFirst,
          pageJitterMinMs,
          pageJitterMaxMs,
          rotateViewport,
          puppeteerPages,
        });
        const ypRows = Array.isArray(yp) ? yp : yp?.rows || [];
        if (yp && !Array.isArray(yp) && typeof yp.pagesFetched === 'number') {
          emit({ type: 'status', source: 'yellowpages', message: 'pages_done', city: cityName, pagesFetched: yp.pagesFetched });
        }
        if (yp && !Array.isArray(yp) && typeof yp.total === 'number') {
          emit({ type: 'status', source: 'yellowpages', message: 'total', city: cityName, total: yp.total });
          log.info(`YellowPages reported total ~${yp.total}`);
        }
        // Rows already streamed via onRows; log summary only
        log.info(`YellowPages rows (summary): ${ypRows.length}`);
      } catch (err) {
        log.warn(`YellowPages fetch skipped for ${cityName}: ${err?.message || err}`);
        emit({ type: 'status', source: 'yellowpages', message: 'skipped', city: cityName, error: String(err?.message || err) });
      }

      const afterDomains = new Set(beforeDomains);
      try {
        for (const row of listCompanies(db)) {
          if (row.location !== cityName) continue;
          if (!row.website) continue;
          const nd = normalizeDomain(row.website);
          if (nd) afterDomains.add(nd);
        }
      } catch {}

      const newCount = afterDomains.size - beforeDomains.size;
      if (newCount === 0) stale += 1; else stale = 0;
      emit({ type: 'status', message: 'city_pass_done', city: cityName, pass: passes, new_domains: newCount, stale: stale });

      if (!exhaustCity) break;
    }

    // Google Maps (optional)
    if (enableGmaps || onlyGmaps) {
      try {
        emit({ type: 'status', source: 'googlemaps', message: 'start', city: cityName });
        const gmaps = await crawlGoogleMaps(industry, cityName, {
          limit: gmapsLimit,
          detailClicks: gmapsDetailClicks,
          detailAll: gmapsDetailAll,
          exhaust: gmapsExhaust,
          maxTotal: gmapsMaxTotal,
          headless,
          pageTimeoutMs,
          rotateViewport,
          puppeteerProxy,
          puppeteerProxyUser,
          puppeteerProxyPass,
          onDebug: (e) => emit({ type: 'debug', source: 'googlemaps', city: cityName, ...e }),
        });
        const gRows = Array.isArray(gmaps) ? gmaps : gmaps?.rows || [];
        for (const row of gRows) {
          try {
            upsertCompany(db, {
              name: row.name,
              website: row.website || null,
              industry,
              location: cityName,
              source_list: ['googlemaps'],
              size_category: null,
              phone: row.phone || null,
              address: row.address || null,
              rating: typeof row.rating === 'number' ? row.rating : null,
              reviews_count: Number.isFinite(row.reviews_count) ? row.reviews_count : null,
              categories: Array.isArray(row.categories) ? row.categories : (row.categories ? [row.categories] : null),
            });
            emit({ type: 'row', name: row.name, website: row.website || null, phone: row.phone || null, address: row.address || null, rating: row.rating ?? null, reviews_count: row.reviews_count ?? null, categories: row.categories || null, industry, location: cityName, source: 'googlemaps', method: row.method || 'gmaps-puppeteer' });
          } catch {}
        }
        emit({ type: 'status', source: 'googlemaps', message: 'done', city: cityName, rows: gRows.length });
        log.info(`Google Maps rows (summary): ${gRows.length}`);
      } catch (e) {
        emit({ type: 'status', source: 'googlemaps', message: 'skipped', city: cityName, error: String(e?.message || e) });
        log.warn(`Google Maps fetch skipped for ${cityName}: ${e?.message || e}`);
      }
    }
    emit({ type: 'status', message: 'city_done', city: cityName });

    // Per-city export before moving to next city
    try {
      const rowsAll = listCompanies(db);
      const rowsCity = rowsAll.filter(r => r.location === cityName);
      const stamp = new Date().toISOString().slice(0, 10);
      const slugCity = String(cityName).replace(/\s+/g, '-').toLowerCase();
      const slugIndustry = String(industry).replace(/\s+/g, '-').toLowerCase();
      fs.mkdirSync(outDir, { recursive: true });
      if (format === 'csv' || format === 'both') {
        const csvPath = path.join(outDir, `${stamp}_${slugIndustry}_${slugCity}.csv`);
        exportToCsv(rowsCity, csvPath);
        log.info(`CSV exported (city): ${csvPath} (${rowsCity.length} rows)`);
        emit({ type: 'export', format: 'csv', path: csvPath, rows: rowsCity.length, city: cityName });
      }
      if (format === 'json' || format === 'both') {
        const jsonPath = path.join(outDir, `${stamp}_${slugIndustry}_${slugCity}.json`);
        exportToJson(rowsCity, jsonPath);
        log.info(`JSON exported (city): ${jsonPath} (${rowsCity.length} rows)`);
        emit({ type: 'export', format: 'json', path: jsonPath, rows: rowsCity.length, city: cityName });
      }
    } catch (e) {
      log.warn(`Per-city export failed for ${cityName}: ${e?.message || e}`);
    }
  }
  }

  // Close shared Apollo session
  if (apolloSession) {
    try { await closeApolloSession(apolloSession); } catch {}
    apolloSession = null;
  }

  const rows = listCompanies(db);
  const stamp = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(outDir, { recursive: true });
  const base = allCities ? `${stamp}_${industry}_all-cities` : `${stamp}_${industry}_${city.replace(/\s+/g,'-').toLowerCase()}`;
  if (format === 'csv' || format === 'both') {
    const csvPath = path.join(outDir, `${base}.csv`);
    exportToCsv(rows, csvPath);
    log.info(`CSV exported: ${csvPath} (${rows.length} rows)`);
    emit({ type: 'export', format: 'csv', path: csvPath, rows: rows.length });
  }
  if (format === 'json' || format === 'both') {
    const jsonPath = path.join(outDir, `${base}.json`);
    exportToJson(rows, jsonPath);
    log.info(`JSON exported: ${jsonPath} (${rows.length} rows)`);
    emit({ type: 'export', format: 'json', path: jsonPath, rows: rows.length });
  }
  emit({ type: 'done' });
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}


