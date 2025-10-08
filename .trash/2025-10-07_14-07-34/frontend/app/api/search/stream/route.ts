import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function sseInit(controller: ReadableStreamDefaultController) {
  controller.enqueue(new TextEncoder().encode("event: ping\n\n"));
}

function sseData(obj: any) {
  return new TextEncoder().encode("data: " + JSON.stringify(obj) + "\n\n");
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Google Custom Search API (CSE)
async function cseFetch(query: string, startIndex: number) {
  const key = process.env.GOOGLE_CSE_KEY || process.env.NEXT_PUBLIC_GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX || process.env.NEXT_PUBLIC_GOOGLE_CSE_CX;
  if (!key || !cx) {
    throw new Error("Missing GOOGLE_CSE_KEY or GOOGLE_CSE_CX env vars");
  }
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("start", String(Math.max(1, startIndex)));
  url.searchParams.set("num", "10");
  // Prefer English results in US
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "us");
  const res = await fetch(url.toString(), { cache: "no-store" } as any);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CSE error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return (data?.items || []) as Array<{ title?: string; link?: string }>;
}

async function fetchHtmlHttp(url: string, hostHint?: string): Promise<{ status: number; text: string | null }> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 9000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        ...(hostHint ? { Referer: `https://${hostHint}/` } : {}),
      },
      redirect: "follow",
      cache: "no-store",
      signal: ac.signal as any,
    } as any);
    clearTimeout(to);
    const status = (res as any)?.status ?? 0;
    if (!res || !res.ok) return { status, text: null };
    return { status, text: await res.text() };
  } catch (e) {
    clearTimeout(to);
    return { status: 0, text: null };
  }
}

async function fetchHtml(url: string, hostHint?: string): Promise<string | null> {
  // Try standard HTTP first
  const first = await fetchHtmlHttp(url, hostHint);
  if (first.text || (first.status && first.status !== 403)) return first.text;
  // Fallback: try Playwright headless browser if available (local dev)
  try {
    // Dynamic import to avoid hard dependency when deploying without playwright
    // @ts-ignore
    const pw = await import("playwright").catch(() => null as any);
    if (!pw || !pw.chromium) return null;
    const browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    await page.route("**/*", (route: any) => {
      const headers = {
        ...route.request().headers(),
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...(hostHint ? { Referer: `https://${hostHint}/` } : {}),
      } as any;
      route.continue({ headers });
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const html = await page.content();
    await context.close();
    await browser.close();
    return html || null;
  } catch (e) {
    console.warn("[stream] playwright fallback failed", String(e));
    return null;
  }
}

async function acceptGoogleConsent(page: any) {
  try {
    // Try common consent overlays/buttons
    await page.evaluate(() => {
      const tryClick = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) el.click();
      };
      const tryText = (rx: RegExp) => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find((b) => rx.test((b.textContent || '').toLowerCase())) as HTMLElement | undefined;
        if (btn) btn.click();
      };
      tryClick('button[aria-label="Accept all"]');
      tryClick('button[aria-label="I agree"]');
      tryText(/accept|agree|i agree|yes/i);
    });
    await page.waitForTimeout(300);
  } catch {}
}

async function scrollResultsList(page: any, maxScrolls = 40) {
  try {
    await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const candidates = [
        document.querySelector('[role="feed"]'),
        document.querySelector('[aria-label*="Results" i]'),
        document.querySelector('[aria-label*="Search results" i]'),
      ].filter(Boolean) as HTMLElement[];
      const list = candidates[0] as HTMLElement | undefined;
      if (!list) return;
      let last = -1;
      for (let i = 0; i < 200; i++) {
        list.scrollTop = list.scrollHeight;
        await sleep(300);
        const cur = list.scrollTop;
        if (cur === last) break;
        last = cur;
      }
    });
  } catch {}
}

async function clickNextPage(page: any): Promise<boolean> {
  try {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"]')) as HTMLElement[];
      const isVisible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const matches = (el: HTMLElement, rx: RegExp) => {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const txt = (el.textContent || '').toLowerCase();
        return rx.test(label) || rx.test(txt);
      };
      const tryClick = (rx: RegExp) => {
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          if (!matches(el, rx)) continue;
          const disabled = el.getAttribute('aria-disabled');
          if (disabled === 'true') continue;
          el.click();
          return true;
        }
        return false;
      };
      // Prefer explicit next-page; fallback to more places
      if (tryClick(/next\s*page|next/i)) return true;
      if (tryClick(/more\s*places/i)) return true;
      return false;
    });
    if (!clicked) return false;
    await page.waitForTimeout(700);
    return true;
  } catch {
    return false;
  }
}

async function getCurrentPlaceUrl(page: any): Promise<string> {
  try {
    const u = page.url() || "";
    return u.split('&')[0];
  } catch {
    return "";
  }
}

async function clickNextPlace(page: any): Promise<string | null> {
  try {
    const before = await getCurrentPlaceUrl(page);
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"]')) as HTMLElement[];
      const isVisible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const matches = (el: HTMLElement, rx: RegExp) => {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const txt = (el.textContent || '').toLowerCase();
        return rx.test(label) || rx.test(txt);
      };
      const tryClick = (rx: RegExp) => {
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          if (!matches(el, rx)) continue;
          const disabled = el.getAttribute('aria-disabled');
          if (disabled === 'true') continue;
          el.click();
          return true;
        }
        return false;
      };
      // Try obvious next controls first
      if (tryClick(/next\s*place|next\s*result|next\s*page|next/i)) return true;
      // Fallback: try Right Arrow key
      const evt = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
      document.dispatchEvent(evt);
      return true;
    });
    if (!clicked) return null;
    // Wait for URL to change to a different place
    const maxWaitMs = 5000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await page.waitForTimeout(200);
      const cur = await getCurrentPlaceUrl(page);
      if (cur && cur !== before) return cur;
    }
    return null;
  } catch {
    return null;
  }
}

function deterministicPlan(industry: string) {
  // Focus on directories we can parse reliably. MerchantCircle removed to reduce noise.
  const dirs = ["yellowpages.com", "manta.com", "bbb.org", "superpages.com", "cityfos.com"];
  const angles = [
    industry,
    `${industry} companies`,
    `${industry} directory`,
  ];
  return { directories: dirs, angles };
}

function buildSearchUrl(domain: string, query: string, location?: string) {
  const q = encodeURIComponent(query + (location ? ` ${location}` : ""));
  const loc = encodeURIComponent(location || "United States");
  if (domain.includes("yellowpages.com")) {
    return `https://www.yellowpages.com/search?search_terms=${q}&geo_location_terms=${loc}`;
  }
  if (domain.includes("manta.com")) {
    // Manta search doesn't expose a clean location param; include in query
    return `https://www.manta.com/search?search=${q}`;
  }
  if (domain.includes("bbb.org")) {
    return `https://www.bbb.org/search?find_text=${q}&find_loc=${encodeURIComponent(location || "")}`;
  }
  if (domain.includes("superpages.com")) {
    return `https://www.superpages.com/search?search_terms=${q}&geo_location_terms=${encodeURIComponent(location || "")}`;
  }
  if (domain.includes("cityfos.com")) {
    // Cityfos may ignore location, but include as hint
    return `https://www.cityfos.com/company-listing?search_term=${q}&location=${encodeURIComponent(location || "")}`;
  }
  return `https://${domain}/search?q=${q}`;
}

function unwrapGoogleOutbound(url: string): string {
  try {
    const u = new URL(url);
    if (u.host.includes("google.")) {
      const q = u.searchParams.get("q") || u.searchParams.get("url") || u.searchParams.get("target");
      if (q) return decodeURIComponent(q);
    }
    return url;
  } catch {
    return url;
  }
}

function tokenize(str: string) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function expandIndustryTerms(industry: string) {
  const terms = new Set<string>(tokenize(industry));
  // Tiny synonym expansions for common local-service verticals
  const s = industry.toLowerCase();
  if (s.includes("nail")) {
    terms.add("manicure");
    terms.add("pedicure");
    terms.add("salon");
    terms.add("spas");
  }
  if (s.includes("paint")) {
    terms.add("painter");
    terms.add("painting");
  }
  if (s.includes("clean")) {
    terms.add("cleaning");
    terms.add("maid");
    terms.add("janitorial");
  }
  return Array.from(terms);
}

const GENERIC_BLOCK = new Set([
  "facebook.com","instagram.com","x.com","twitter.com","youtube.com","wikipedia.org",
  "google.com","maps.google.com","bing.com","amazon.com","ebay.com","blogspot.com",
  "linkedin.com",
]);

const DIRECTORY_BLOCK = new Set([
  // Directories/aggregators we should never emit as company websites
  "yellowpages.com","manta.com","bbb.org","superpages.com","merchantcircle.com","cylex.us.com",
  "cityfos.com","find-us-here.com","tuugo.us","brownbook.net","iglobal.co","company-list.org",
  "yalwa.com","hotfrog.com","citysquares.com","localstack.com","us-info.com","hub.biz","bizapedia.com",
  "opencorporates.com","yelp.com","angi.com","angi.es","homeadvisor.com","thumbtack.com",
]);

function isRelevantLink(text: string, url: string, industryTerms: string[], directoryHost: string) {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "").toLowerCase();
    if (!host || host.includes(directoryHost)) return false;
    if (GENERIC_BLOCK.has(host)) return false;
    const lowerText = text.toLowerCase();
    const lowerUrl = (u.pathname + " " + u.search).toLowerCase();
    // Reject generic anchor labels
    if (lowerText === "website" || lowerText === "home" || lowerText === "click here") return false;
    // Require at least one industry term in anchor text or url path
    return industryTerms.some((t) => lowerText.includes(t) || lowerUrl.includes(t));
  } catch {
    return false;
  }
}

function extractLinks(html: string, directoryHost: string, industryTerms: string[]) {
  const results: { title: string; url: string }[] = [];
  const anchorRe = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>(.*?)<\/a>/gims;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    let text = m[2].replace(/<[^>]+>/g, "").trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) continue;
    try {
      const u = new URL(href, `https://${directoryHost}`);
      const host = u.host.toLowerCase();
      if (!host || host.includes(directoryHost)) continue; // external only
      if (!isRelevantLink(text || host, u.toString(), industryTerms, directoryHost)) continue;
      const title = text || host;
      results.push({ title, url: u.toString() });
    } catch {
      continue;
    }
  }
  // de-dupe by host
  const seen = new Set<string>();
  return results.filter((r) => {
    try {
      const h = new URL(r.url).host.replace(/^www\./, "");
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    } catch {
      return false;
    }
  });
}

function extractOutboundWebsitesFromSearchPage(html: string, directoryHost: string, terms: string[]) {
  const rows: { title: string; url: string }[] = [];
  // Common pattern: anchors labeled Website/Visit with external href or wrapped url param
  const aRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gims;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html))) {
    let href = m[1];
    const text = (m[2] || "").replace(/<[^>]+>/g, " ").trim();
    const lower = text.toLowerCase();
    // Accept common labels or YP redirect links
    if (!/(visit|website|official|site)/.test(lower) && !/\/redirect\?|\burl=/.test(href)) continue;
    try {
      // unwrap ?url= style
      try {
        const tmp = new URL(href, `https://${directoryHost}`);
        const wrapped = tmp.searchParams.get("url") || tmp.searchParams.get("target") || tmp.searchParams.get("u");
        if (wrapped) href = decodeURIComponent(wrapped);
      } catch {}
      const u = new URL(href);
      const host = u.host.replace(/^www\./, "").toLowerCase();
      if (!host || host === directoryHost || GENERIC_BLOCK.has(host) || DIRECTORY_BLOCK.has(host)) continue;
      // Try to derive a company name from nearby context (business-name anchors, headings)
      let company = host;
      const idx = m.index || 0;
      const prefix = html.slice(Math.max(0, idx - 1500), idx);
      const bn = prefix.match(/<a[^>]*class=["'][^"']*(business-name|listing-name|name)[^"']*["'][^>]*>([\s\S]*?)<\/a>/im);
      if (bn && bn[2]) {
        company = bn[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || company;
      } else {
        const h2 = prefix.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/im);
        if (h2 && h2[1]) company = h2[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || company;
      }
      rows.push({ title: company, url: u.toString() });
    } catch {}
  }
  // Also catch YP explicit redirect anchors even without visible text
  const ypRedir = html.matchAll(/href=["'][^"']*\/redirect\?[^"']*[?&]url=([^"'&]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gims);
  for (const mm of ypRedir) {
    try {
      const decoded = decodeURIComponent(mm[1]);
      const u = new URL(decoded);
      const host = u.host.replace(/^www\./, "").toLowerCase();
      if (!host || host === directoryHost || GENERIC_BLOCK.has(host) || DIRECTORY_BLOCK.has(host)) continue;
      rows.push({ title: host, url: u.toString() });
    } catch {}
  }
  // de-dupe by host
  const seen = new Set<string>();
  return rows.filter((r) => {
    try {
      const h = new URL(r.url).host.replace(/^www\./, "");
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    } catch { return false; }
  });
}

function extractInternalListingLinks(html: string, directoryHost: string): { url: string; text: string }[] {
  const links: { url: string; text: string }[] = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gims;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    try {
      const u = new URL(href, `https://${directoryHost}`);
      const host = u.host.replace(/^www\./, "").toLowerCase();
      if (host !== directoryHost) continue;
      const path = u.pathname.toLowerCase();
      // site-tuned patterns
      const isListing = (
        (directoryHost === "yellowpages.com" && /(mip|company|business|listing|profile|biz|detail)/.test(path)) ||
        (directoryHost === "manta.com" && /(c|company|business|listing|profile|place|detail)/.test(path)) ||
        (directoryHost === "superpages.com" && /(bp|company|business|listing|profile|detail)/.test(path)) ||
        (directoryHost === "cityfos.com" && /(company|business|listing|profile|detail)/.test(path)) ||
        /(company|business|listing|profile|biz|place|provider|detail)/.test(path)
      );
      if (isListing) {
        const text = (m[2] || "").replace(/<[^>]+>/g, " ").trim();
        links.push({ url: u.toString(), text });
      }
    } catch {}
  }
  // de-dupe
  const seen = new Set<string>();
  const out: { url: string; text: string }[] = [];
  for (const l of links) {
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    out.push(l);
    if (out.length >= 20) break;
  }
  return out;
}

function extractExternalWebsiteFromListing(html: string, directoryHost: string, terms: string[]) {
  // 1) JSON-LD url
  const jsonldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gims;
  let m: RegExpExecArray | null;
  while ((m = jsonldRe.exec(html))) {
    try {
      const obj = JSON.parse(m[1]);
      const url = (Array.isArray(obj) ? obj.map((o:any)=>o.url).find(Boolean) : obj.url) as string | undefined;
      if (url) {
        const u = new URL(url);
        const host = u.host.replace(/^www\./, "").toLowerCase();
        if (host && host !== directoryHost && !GENERIC_BLOCK.has(host)) {
          return url;
        }
      }
    } catch {}
  }
  // 2) Anchors with Website/Visit text or outbound links containing industry terms
  const aRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gims;
  while ((m = aRe.exec(html))) {
    let href = m[1];
    const text = (m[2] || "").replace(/<[^>]+>/g, "").trim();
    try {
      // Unwrap common redirect patterns (e.g., BBB /redirect?url=...)
      try {
        const tmp = new URL(href, `https://${directoryHost}`);
        const wrapped = tmp.searchParams.get("url") || tmp.searchParams.get("u") || tmp.searchParams.get("target");
        if (wrapped) href = decodeURIComponent(wrapped);
      } catch {}
      const u = new URL(href);
      const host = u.host.replace(/^www\./, "").toLowerCase();
      if (!host || host === directoryHost || GENERIC_BLOCK.has(host)) continue;
      const lower = text.toLowerCase();
      if (/(visit|website|official)/.test(lower) || terms.some((t)=>lower.includes(t))) {
        return href;
      }
    } catch {}
  }
  return null;
}

function listingMatchesIndustry(html: string, terms: string[]) {
  // Check title, h1, and common category chips/badges
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const catChips = html.match(/<a[^>]*class=["'][^"']*(category|chip|tag|badge)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gim) || [];
  const texts: string[] = [];
  if (titleM) texts.push(titleM[1]);
  if (h1M) texts.push(h1M[1]);
  for (const c of catChips) {
    const m = c.match(/>([\s\S]*?)<\/a>/);
    if (m) texts.push(m[1]);
  }
  const blob = texts.join(" ").toLowerCase();
  return terms.some((t) => blob.includes(t));
}

function extractGoogleOrganicLinks(html: string, industryTerms: string[]) {
  const out: { title: string; url: string }[] = [];
  // Google organic links often look like <a href="/url?q=<TARGET>&sa=..."> with an <h3> nearby
  const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gims;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html))) {
    const rawHref = m[1];
    try {
      let href = rawHref;
      if (href.startsWith('/url?')) {
        const u = new URL('https://www.google.com' + href);
        const q = u.searchParams.get('q');
        if (q) href = decodeURIComponent(q);
      }
      const u = new URL(href);
      const host = u.host.replace(/^www\./, '').toLowerCase();
      if (!host) continue;
      if (host.includes('google.')) continue;
      if (GENERIC_BLOCK.has(host) || DIRECTORY_BLOCK.has(host)) continue;
      // nearby title
      const idx = m.index || 0;
      const prefix = html.slice(Math.max(0, idx - 800), Math.min(html.length, idx + 800));
      let title = '';
      const h3 = prefix.match(/<h3[^>]*>([\s\S]*?)<\/h3>/im);
      if (h3 && h3[1]) {
        title = h3[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      // Require at least one industry term in title or path to reduce noise
      const lowerTitle = title.toLowerCase();
      const pathBlob = (u.pathname + ' ' + u.search).toLowerCase();
      if (!industryTerms.some((t) => lowerTitle.includes(t) || pathBlob.includes(t))) continue;
      out.push({ title: title || host, url: u.toString() });
    } catch {}
  }
  // de-dupe by host
  const seen = new Set<string>();
  return out.filter((r) => {
    try {
      const h = new URL(r.url).host.replace(/^www\./, '');
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    } catch { return false; }
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const industry = (searchParams.get("industry") || "").trim();
  const maxResults = Math.max(1, Number(searchParams.get("max") || "200"));
  if (!industry) {
    return new Response("Missing industry", { status: 400 });
  }
  console.log("[stream] start", { industry });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      function safe(chunk: Uint8Array) {
        if (closed) return;
        try { controller.enqueue(chunk); } catch { closed = true; }
      }
      // initial ping
      safe(enc.encode("event: ping\n\n"));
      const seenHosts = new Set<string>();
      try {
        // Google Custom Search only: discover company websites using CSE
        const angles = [industry, `${industry} companies`, `${industry} directory`];
        const seenHosts = new Set<string>();
        let emitted = 0;
        outer: for (const angle of angles) {
          for (let start = 1; start <= 91; start += 10) {
            if (emitted >= maxResults) break outer;
            safe(sseData({ type: "searching", directory: "google-cse", angle }));
            let items: Array<{ title?: string; link?: string }> = [];
            try {
              items = await cseFetch(angle, start);
            } catch (err: any) {
              safe(sseData({ type: "status", message: `CSE error: ${String(err?.message || err)}` }));
              break; // move to next angle
            }
            if (!items || items.length === 0) break;
            for (const it of items) {
              if (emitted >= maxResults) break outer;
              const href = (it?.link || '').trim();
              if (!href) continue;
              try {
                const u = new URL(href);
                const host = u.host.replace(/^www\./, '').toLowerCase();
                if (!host || GENERIC_BLOCK.has(host) || DIRECTORY_BLOCK.has(host)) continue;
                if (seenHosts.has(host)) continue;
                seenHosts.add(host);
                const website = `${u.protocol}//${u.host}`;
                const title = (it?.title || '').trim();
                const name = title && !title.includes(host) ? title : host;
                safe(sseData({ type: 'row', name, website, source: 'google-cse', sourceUrl: href, query: angle }));
                emitted += 1;
              } catch {}
            }
            safe(sseData({ type: 'progress', directory: 'google-cse', query: angle, pageStart: start, discovered: seenHosts.size, emitted }));
          }
        }

        if (!closed) {
          safe(enc.encode('event: done\n\n'));
          closed = true;
          try { controller.close(); } catch {}
          return;
        }
      } catch (e) {
        console.error("[stream] fatal error", e);
        safe(sseData({ type: "error", message: "stream failed" }));
        safe(enc.encode("event: done\n\n"));
        closed = true;
        try { controller.close(); } catch {}
        return;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
