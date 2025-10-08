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
const { initDb, upsertCompany, listCompanies, normalizeDomain } = require('./db/sqlite');
const { crawlYellowPages } = require('./crawlers/yellowpages');
const { exportToCsv } = require('./exporter/csv');
const { exportToJson } = require('./exporter/json');
const { createLogger } = require('./utils/logger');

async function main() {
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
  const exhaustCity = String(argv.exhaustCity || 'false').toLowerCase() === 'true';
  if (exhaustCity && typeof argv.ypConcurrency === 'undefined') {
    ypConcurrency = 1; // strictly sequential per-city to fully exhaust YP pages
  }
  const maxPasses = Math.max(1, Number(argv.maxPasses || 1));
  const stalePasses = Math.max(1, Number(argv.stalePasses || 1));
  const autoMaxPagesYp = Math.max(1, Number(argv.autoMaxPagesYp || argv.autoMaxPages || 50));
  const outDir = argv.output ? path.resolve(String(argv.output)) : path.join(__dirname, '../exports');
  const format = (argv.format || 'csv').toLowerCase(); // csv|json|both
  const verbose = Boolean(argv.verbose);
  const stream = Boolean(argv.stream);
  const citiesFile = argv.citiesFile ? path.resolve(String(argv.citiesFile)) : null;
  const allCities = Boolean(argv.allCities);

  const log = createLogger(verbose);
  log.info(`Run start industry="${industry}" city="${city}" ypPages=${ypPages} format=${format} outDir=${outDir}`);

  function emit(event) {
    if (!stream) return;
    try { process.stdout.write(JSON.stringify(event) + '\n'); } catch {}
  }

  const doFresh = String(argv.fresh || 'false').toLowerCase() === 'true';
  if (doFresh) {
    try {
      const dbFile = require('path').join(__dirname, '../data/industry-finder.sqlite');
      try { fs.unlinkSync(dbFile); } catch {}
      if (stream) { try { process.stdout.write(JSON.stringify({ type: 'status', message: 'db_reset' }) + '\n'); } catch {} }
    } catch {}
  }
  const db = initDb();

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

  for (const cityName of cityList) {
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

      try {
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
                });
                emit({ type: 'row', name: row.name, website: row.website || null, industry, location: cityName, source: 'yellowpages', method: row.method || 'yp-cheerio', page: pageNum, query: industry, fallback_used: Boolean(row.fallback_used) });
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


