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
      last_seen TEXT,
      phone TEXT,
      address TEXT,
      address_street TEXT,
      address_city TEXT,
      address_state TEXT,
      address_postal_code TEXT,
      rating REAL,
      reviews_count INTEGER,
      categories TEXT,
      yp_listing_url TEXT,
      hours_text TEXT,
      email TEXT,
      description TEXT,
      social_profiles TEXT,
      keywords TEXT,
      employee_count TEXT,
      revenue TEXT,
      linkedin_url TEXT,
      facebook_url TEXT,
      twitter_url TEXT,
      apollo_profile_url TEXT
    );
  `);
  // Backfill columns for existing databases (best-effort)
  const addCol = (name, type) => {
    try { db.exec(`ALTER TABLE companies ADD COLUMN ${name} ${type};`); } catch (_) {}
  };
  addCol('phone', 'TEXT');
  addCol('address', 'TEXT');
  addCol('address_street', 'TEXT');
  addCol('address_city', 'TEXT');
  addCol('address_state', 'TEXT');
  addCol('address_postal_code', 'TEXT');
  addCol('rating', 'REAL');
  addCol('reviews_count', 'INTEGER');
  addCol('categories', 'TEXT');
  addCol('yp_listing_url', 'TEXT');
  addCol('hours_text', 'TEXT');
  addCol('email', 'TEXT');
  addCol('description', 'TEXT');
  addCol('social_profiles', 'TEXT');
  addCol('keywords', 'TEXT');
  addCol('employee_count', 'TEXT');
  addCol('revenue', 'TEXT');
  addCol('linkedin_url', 'TEXT');
  addCol('facebook_url', 'TEXT');
  addCol('twitter_url', 'TEXT');
  addCol('apollo_profile_url', 'TEXT');
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
  // Allow saving rows that have a name even if website/domain is missing (e.g., Apollo list view)
  if (!record.name) return 0;
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
              last_seen=@last_seen,
              phone=COALESCE(@phone, phone),
              address=COALESCE(@address, address),
              address_street=COALESCE(@address_street, address_street),
              address_city=COALESCE(@address_city, address_city),
              address_state=COALESCE(@address_state, address_state),
              address_postal_code=COALESCE(@address_postal_code, address_postal_code),
              rating=COALESCE(@rating, rating),
              reviews_count=COALESCE(@reviews_count, reviews_count),
              categories=COALESCE(@categories, categories),
              yp_listing_url=COALESCE(@yp_listing_url, yp_listing_url),
              hours_text=COALESCE(@hours_text, hours_text),
              email=COALESCE(@email, email),
              description=COALESCE(@description, description),
              social_profiles=COALESCE(@social_profiles, social_profiles),
              keywords=COALESCE(@keywords, keywords),
              employee_count=COALESCE(@employee_count, employee_count),
              revenue=COALESCE(@revenue, revenue),
              linkedin_url=COALESCE(@linkedin_url, linkedin_url),
              facebook_url=COALESCE(@facebook_url, facebook_url),
              twitter_url=COALESCE(@twitter_url, twitter_url),
              apollo_profile_url=COALESCE(@apollo_profile_url, apollo_profile_url)
          WHERE id=@id;
        `);
        const info = update.run({
          id: existing.id,
          name: rec.name,
          website: rec.website || null,
          size_category: rec.size_category || null,
          source_list: JSON.stringify(merged),
          last_seen: nowIso,
          phone: rec.phone || null,
          address: rec.address || null,
          address_street: rec.address_street || null,
          address_city: rec.address_city || null,
          address_state: rec.address_state || null,
          address_postal_code: rec.address_postal_code || null,
          rating: (typeof rec.rating === 'number' ? rec.rating : null),
          reviews_count: (Number.isFinite(rec.reviews_count) ? rec.reviews_count : null),
          categories: rec.categories ? JSON.stringify(rec.categories) : null,
          yp_listing_url: rec.yp_listing_url || null,
          hours_text: rec.hours_text || null,
          email: rec.email || null,
          description: rec.description || null,
          social_profiles: rec.social_profiles || null,
          keywords: rec.keywords || null,
          employee_count: rec.employee_count || null,
          revenue: rec.revenue || null,
          linkedin_url: rec.linkedin_url || null,
          facebook_url: rec.facebook_url || null,
          twitter_url: rec.twitter_url || null,
          apollo_profile_url: rec.apollo_profile_url || null,
        });
        return info.changes;
      } else {
        const insert = db.prepare(`
        INSERT INTO companies (name, website, normalized_domain, industry, location, size_category, source_list, first_seen, last_seen, phone, address, address_street, address_city, address_state, address_postal_code, rating, reviews_count, categories, yp_listing_url, hours_text, email, description, social_profiles, keywords, employee_count, revenue, linkedin_url, facebook_url, twitter_url, apollo_profile_url)
        VALUES (@name, @website, @normalized_domain, @industry, @location, @size_category, @source_list, @first_seen, @last_seen, @phone, @address, @address_street, @address_city, @address_state, @address_postal_code, @rating, @reviews_count, @categories, @yp_listing_url, @hours_text, @email, @description, @social_profiles, @keywords, @employee_count, @revenue, @linkedin_url, @facebook_url, @twitter_url, @apollo_profile_url);
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
          phone: rec.phone || null,
          address: rec.address || null,
          address_street: rec.address_street || null,
          address_city: rec.address_city || null,
          address_state: rec.address_state || null,
          address_postal_code: rec.address_postal_code || null,
          rating: (typeof rec.rating === 'number' ? rec.rating : null),
          reviews_count: (Number.isFinite(rec.reviews_count) ? rec.reviews_count : null),
          categories: rec.categories ? JSON.stringify(rec.categories) : null,
          yp_listing_url: rec.yp_listing_url || null,
          hours_text: rec.hours_text || null,
          email: rec.email || null,
          description: rec.description || null,
          social_profiles: rec.social_profiles || null,
          keywords: rec.keywords || null,
          employee_count: rec.employee_count || null,
          revenue: rec.revenue || null,
          linkedin_url: rec.linkedin_url || null,
          facebook_url: rec.facebook_url || null,
          twitter_url: rec.twitter_url || null,
          apollo_profile_url: rec.apollo_profile_url || null,
        });
        return info.changes;
      }
    });
    return tx(record);
  }

  // Fallback upsert without domain: merge on (name, industry, location)
  const tx = db.transaction((rec) => {
    const existing = db.prepare(`
      SELECT id, source_list FROM companies 
      WHERE normalized_domain IS NULL AND name=? AND industry IS ? AND location IS ? 
      LIMIT 1
    `).get(rec.name, rec.industry || null, rec.location || null);
    if (existing) {
      let existingSources = [];
      try { existingSources = JSON.parse(existing.source_list || '[]'); } catch(_) {}
      const merged = Array.from(new Set([...(existingSources || []), ...incomingSources]));
      const update = db.prepare(`
        UPDATE companies
        SET website=COALESCE(@website, website),
            size_category=COALESCE(@size_category, size_category),
            source_list=@source_list,
            last_seen=@last_seen,
            phone=COALESCE(@phone, phone),
            address=COALESCE(@address, address),
            address_street=COALESCE(@address_street, address_street),
            address_city=COALESCE(@address_city, address_city),
            address_state=COALESCE(@address_state, address_state),
            address_postal_code=COALESCE(@address_postal_code, address_postal_code),
            rating=COALESCE(@rating, rating),
            reviews_count=COALESCE(@reviews_count, reviews_count),
            categories=COALESCE(@categories, categories),
            yp_listing_url=COALESCE(@yp_listing_url, yp_listing_url),
            hours_text=COALESCE(@hours_text, hours_text),
            email=COALESCE(@email, email),
            description=COALESCE(@description, description),
            social_profiles=COALESCE(@social_profiles, social_profiles)
        WHERE id=@id;
      `);
      const infoU = update.run({
        id: existing.id,
        website: rec.website || null,
        size_category: rec.size_category || null,
        source_list: JSON.stringify(merged),
        last_seen: nowIso,
        phone: rec.phone || null,
        address: rec.address || null,
        address_street: rec.address_street || null,
        address_city: rec.address_city || null,
        address_state: rec.address_state || null,
        address_postal_code: rec.address_postal_code || null,
        rating: (typeof rec.rating === 'number' ? rec.rating : null),
        reviews_count: (Number.isFinite(rec.reviews_count) ? rec.reviews_count : null),
        categories: rec.categories ? JSON.stringify(rec.categories) : null,
        yp_listing_url: rec.yp_listing_url || null,
        hours_text: rec.hours_text || null,
        email: rec.email || null,
        description: rec.description || null,
        social_profiles: rec.social_profiles || null,
      });
      return infoU.changes;
    } else {
      const insert = db.prepare(`
        INSERT INTO companies (name, website, normalized_domain, industry, location, size_category, source_list, first_seen, last_seen, phone, address, address_street, address_city, address_state, address_postal_code, rating, reviews_count, categories, yp_listing_url, hours_text, email, description, social_profiles, keywords, employee_count, revenue, linkedin_url, facebook_url, twitter_url, apollo_profile_url)
        VALUES (@name, @website, NULL, @industry, @location, @size_category, @source_list, @first_seen, @last_seen, @phone, @address, @address_street, @address_city, @address_state, @address_postal_code, @rating, @reviews_count, @categories, @yp_listing_url, @hours_text, @email, @description, @social_profiles, @keywords, @employee_count, @revenue, @linkedin_url, @facebook_url, @twitter_url, @apollo_profile_url);
      `);
      const infoI = insert.run({
        name: rec.name,
        website: rec.website || null,
        industry: rec.industry || null,
        location: rec.location || null,
        size_category: rec.size_category || null,
        source_list: JSON.stringify(incomingSources),
        first_seen: nowIso,
        last_seen: nowIso,
        phone: rec.phone || null,
        address: rec.address || null,
        address_street: rec.address_street || null,
        address_city: rec.address_city || null,
        address_state: rec.address_state || null,
        address_postal_code: rec.address_postal_code || null,
        rating: (typeof rec.rating === 'number' ? rec.rating : null),
        reviews_count: (Number.isFinite(rec.reviews_count) ? rec.reviews_count : null),
        categories: rec.categories ? JSON.stringify(rec.categories) : null,
        yp_listing_url: rec.yp_listing_url || null,
        hours_text: rec.hours_text || null,
        email: rec.email || null,
        description: rec.description || null,
        social_profiles: rec.social_profiles || null,
        keywords: rec.keywords || null,
        employee_count: rec.employee_count || null,
        revenue: rec.revenue || null,
        linkedin_url: rec.linkedin_url || null,
        facebook_url: rec.facebook_url || null,
        twitter_url: rec.twitter_url || null,
        apollo_profile_url: rec.apollo_profile_url || null,
      });
      return infoI.changes;
    }
  });
  return tx(record);
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
    phone: r.phone,
    address: r.address,
    address_street: r.address_street,
    address_city: r.address_city,
    address_state: r.address_state,
    address_postal_code: r.address_postal_code,
    rating: r.rating,
    reviews_count: r.reviews_count,
    categories: (() => { try { return JSON.parse(r.categories || 'null'); } catch(_) { return null; } })(),
    yp_listing_url: r.yp_listing_url,
    hours_text: r.hours_text,
    email: r.email,
    description: r.description,
    social_profiles: (() => { try { return JSON.parse(r.social_profiles || 'null'); } catch(_) { return null; } })(),
    keywords: r.keywords,
    employee_count: r.employee_count,
    revenue: r.revenue,
    linkedin_url: r.linkedin_url,
    facebook_url: r.facebook_url,
    twitter_url: r.twitter_url,
    apollo_profile_url: r.apollo_profile_url,
  }));
}

module.exports = {
  initDb,
  upsertCompany,
  listCompanies,
  normalizeDomain,
  dbPath,
};


