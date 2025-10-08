const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '../../data');
const envDbPath = process.env.IF_DB_PATH ? String(process.env.IF_DB_PATH) : null;
const dbPath = envDbPath || path.join(dataDir, 'industry-finder.sqlite');

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  const exportsDir = path.join(__dirname, '../../exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  // Also ensure parent dir for custom DB path (IF_DB_PATH)
  try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (_) {}
}

function initDb() {
  ensureDirs();
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
  } catch (_) {
    try { db.pragma('journal_mode = DELETE'); } catch (_) {}
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      website TEXT,
      normalized_domain TEXT,
      industry TEXT,
      location TEXT,
      size_category TEXT,
      source_list TEXT,
      first_seen TEXT,
      last_seen TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(normalized_domain);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_companies_industry_location ON companies(industry, location);
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_domain_industry_location ON companies(normalized_domain, industry, location);
  `);
  return db;
}

function normalizeDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch (_) {
    return null;
  }
}

function upsertCompany(db, record) {
  const nowIso = new Date().toISOString();
  const normalizedDomain = record.normalized_domain || normalizeDomain(record.website);
  if (!record.name || (!normalizedDomain && !record.website)) return 0;
  const incomingSources = Array.isArray(record.source_list) ? record.source_list : [];

  // Upsert by (normalized_domain, industry, location) when domain present.
  if (normalizedDomain) {
    const tx = db.transaction((rec) => {
      const existing = db.prepare(`SELECT id, source_list FROM companies WHERE normalized_domain=? AND industry IS ? AND location IS ? LIMIT 1`)
        .get(normalizedDomain, rec.industry || null, rec.location || null);
      if (existing) {
        let existingSources = [];
        try { existingSources = JSON.parse(existing.source_list || '[]'); } catch(_) {}
        const merged = Array.from(new Set([...(existingSources || []), ...incomingSources]));
        const update = db.prepare(`
          UPDATE companies
          SET name=@name,
              website=COALESCE(@website, website),
              size_category=COALESCE(@size_category, size_category),
              source_list=@source_list,
              last_seen=@last_seen
          WHERE id=@id;
        `);
        const info = update.run({
          id: existing.id,
          name: rec.name,
          website: rec.website || null,
          size_category: rec.size_category || null,
          source_list: JSON.stringify(merged),
          last_seen: nowIso,
        });
        return info.changes;
      } else {
        const insert = db.prepare(`
          INSERT INTO companies (name, website, normalized_domain, industry, location, size_category, source_list, first_seen, last_seen)
          VALUES (@name, @website, @normalized_domain, @industry, @location, @size_category, @source_list, @first_seen, @last_seen);
        `);
        const info = insert.run({
          name: rec.name,
          website: rec.website || null,
          normalized_domain: normalizedDomain,
          industry: rec.industry || null,
          location: rec.location || null,
          size_category: rec.size_category || null,
          source_list: JSON.stringify(incomingSources),
          first_seen: nowIso,
          last_seen: nowIso,
        });
        return info.changes;
      }
    });
    return tx(record);
  }

  // Fallback insert without domain
  const stmt = db.prepare(`
    INSERT INTO companies (name, website, normalized_domain, industry, location, size_category, source_list, first_seen, last_seen)
    VALUES (@name, @website, NULL, @industry, @location, @size_category, @source_list, @first_seen, @last_seen);
  `);
  const info = stmt.run({
    name: record.name,
    website: record.website || null,
    industry: record.industry || null,
    location: record.location || null,
    size_category: record.size_category || null,
    source_list: JSON.stringify(incomingSources),
    first_seen: nowIso,
    last_seen: nowIso,
  });
  return info.changes;
}

function listCompanies(db) {
  const rows = db.prepare(`SELECT * FROM companies`).all();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    website: r.website,
    normalized_domain: r.normalized_domain,
    industry: r.industry,
    location: r.location,
    size_category: r.size_category,
    source_list: (() => { try { return JSON.parse(r.source_list || '[]'); } catch(_) { return []; } })(),
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  }));
}

module.exports = {
  initDb,
  upsertCompany,
  listCompanies,
  normalizeDomain,
  dbPath,
};


