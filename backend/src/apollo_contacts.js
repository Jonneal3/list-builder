// Minimal Apollo Contacts scraper
// Usage (args via URLSearchParams from frontend SSE route):
//   --orgIds=["56d...","..."]
//   --headless=true|false
//   --apolloEmail=... --apolloPassword=... (optional)
//   --pageTimeoutMs=15000
// Emits JSON lines to stdout to be consumed by SSE wrapper in Next.js route.

const minimist = require('minimist');
const puppeteer = require('puppeteer');

function println(obj) {
  try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch {}
}

function buildPeopleUrl(orgId) {
  // Seniorities filtered: owner, founder, c_suite, partner
  // Sorted by recommendations_score desc, page=1 by default
  const base = `https://app.apollo.io/#/organizations/${orgId}/people`;
  const params = [
    'page=1',
    'sortAscending=false',
    'sortByField=recommendations_score',
    'personSeniorities[]=owner',
    'personSeniorities[]=founder',
    'personSeniorities[]=c_suite',
    'personSeniorities[]=partner',
  ].join('&');
  return `${base}?${params}`;
}

async function loginIfNeeded(page, email, password, timeoutMs) {
  try {
    await page.goto('https://app.apollo.io/#/login', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('input[name="email"]', { visible: true, timeout: 4000 });
  } catch {
    // Already logged in
    return;
  }
  if (!email || !password) return; // rely on existing session
  await page.type('input[name="email"]', email, { delay: 20 });
  await page.type('input[name="password"]', password, { delay: 20 });
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: timeoutMs }).catch(()=>{}),
  ]);
}

async function scrapeOrg(page, orgId, timeoutMs) {
  const url = buildPeopleUrl(orgId);
  println({ type: 'status', source: 'apollo-contacts', message: 'org_start', orgId, url });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  // Wait for table area; Apollo is SPA; allow some delay
  try {
    await page.waitForSelector('table tbody tr', { visible: true, timeout: 12000 });
  } catch {
    println({ type: 'debug', source: 'apollo-contacts', info: 'no_rows', orgId });
    return;
  }
  const rows = await page.$$eval('table tbody tr', (trs) => {
    const out = [];
    for (const tr of trs) {
      const tdAll = tr.querySelectorAll('td');
      if (!tdAll || tdAll.length === 0) continue;
      const firstTd = tdAll[0] || null;
      const nameTextRaw = firstTd ? firstTd.innerText || '' : '';
      const nameText = nameTextRaw.replace(/\s+\n\s+/g, ' ').trim();
      const parts = nameText.split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ');
      const titleTd = tdAll[1] || null;
      const jobTitle = titleTd ? (titleTd.innerText || '').trim() : '';
      const companyTd = tdAll[2] || null;
      const companyName = companyTd ? (companyTd.innerText || '').trim() : '';
      const linkedinA = firstTd ? firstTd.querySelector('a[href*="linkedin.com/in"]') : null;
      const linkedinUrl = linkedinA ? linkedinA.href : '';
      const locationTd = tdAll[4] || null;
      const location = locationTd ? (locationTd.innerText || '').trim() : '';
      out.push({
        firstName,
        lastName,
        fullName: nameText,
        jobTitle,
        companyName,
        linkedinUrl,
        location,
      });
    }
    return out;
  });
  for (const p of rows) {
    println({ type: 'person', source: 'apollo-contacts', orgId, ...p });
  }
  println({ type: 'status', source: 'apollo-contacts', message: 'org_done', orgId, rows: rows.length });
}

(async () => {
  const argv = minimist(process.argv.slice(2));
  const headless = String(argv.headless || 'true') !== 'false';
  const timeoutMs = Math.max(8000, Number(argv.pageTimeoutMs || 15000));
  let orgIds = [];
  try {
    if (argv.orgIds) {
      const parsed = JSON.parse(String(argv.orgIds));
      if (Array.isArray(parsed)) orgIds = parsed.map((s) => String(s).trim()).filter(Boolean);
    }
  } catch {}
  const apolloEmail = String(argv.apolloEmail || '').trim();
  const apolloPassword = String(argv.apolloPassword || '').trim();

  if (!orgIds.length) {
    println({ type: 'error', source: 'apollo-contacts', message: 'no_org_ids' });
    process.exit(0);
    return;
  }

  println({ type: 'status', source: 'apollo-contacts', message: 'start', count: orgIds.length });
  const browser = await puppeteer.launch({ headless, defaultViewport: null, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    await loginIfNeeded(page, apolloEmail, apolloPassword, timeoutMs);
    for (const orgId of orgIds) {
      try { await scrapeOrg(page, orgId, timeoutMs); } catch (e) { println({ type: 'stderr', source: 'apollo-contacts', message: String(e && (e.message || e)) }); }
    }
    println({ type: 'done', source: 'apollo-contacts' });
  } finally {
    try { await browser.close(); } catch {}
  }
  process.exit(0);
})();


