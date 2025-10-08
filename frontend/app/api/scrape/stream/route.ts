import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function sseData(obj: any) {
  const enc = new TextEncoder();
  const evt = obj && typeof obj.type === "string" ? String(obj.type) : "";
  const head = evt ? `event: ${evt}\n` : "";
  return enc.encode(head + "data: " + JSON.stringify(obj) + "\n\n");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const industry = (searchParams.get("industry") || "").trim();
  const city = (searchParams.get("city") || "New York").trim();
  const verbose = (searchParams.get("verbose") || "false").toLowerCase() === "true";
  const maxPages = Math.max(1, Number(searchParams.get("maxPages") || "120"));

  if (!industry) {
    return new Response("Missing industry", { status: 400 });
  }

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const encodePlus = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
  const buildUrl = (p: number) => {
    const base = "https://www.yellowpages.com/search";
    const qs = `search_terms=${encodePlus(industry)}&geo_location_terms=${encodePlus(city)}&page=${encodePlus(String(p))}`;
    return `${base}?${qs}`;
  };
  const normalizePlusUrl = (rawUrl: string, pageNum: number) => {
    try {
      const u = new URL(rawUrl);
      const qs = `search_terms=${encodePlus(industry)}&geo_location_terms=${encodePlus(city)}&page=${encodePlus(String(pageNum))}`;
      return `${u.origin}${u.pathname}?${qs}`;
    } catch {
      return buildUrl(pageNum);
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const enqueue = (chunk: Uint8Array) => { try { controller.enqueue(chunk); } catch {} };
      const seenKeys = new Set<string>();
      function normalizeHost(u: string | null | undefined) {
        if (!u) return "";
        try { const x = new URL(u); return x.host.replace(/^www\./, "").toLowerCase(); } catch {}
        try { const x2 = new URL(`https://${u}`); return x2.host.replace(/^www\./, "").toLowerCase(); } catch {}
        return String(u || "").toLowerCase();
      }
      function dedupeRows(rows: Array<{ name: string; website: string | null }>) {
        const seen = new Set<string>();
        const out: Array<{ name: string; website: string | null }> = [];
        for (const r of rows || []) {
          const key = `${String(r?.name || '').trim().toLowerCase()}|${normalizeHost(r?.website || '')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(r);
        }
        return out;
      }

      // initial ping and start
      enqueue(enc.encode("event: ping\n\n"));
      enqueue(sseData({ type: "status", message: "start", industry, city }));

      (async () => {
        // Dynamic import to avoid hard dependency if Playwright not installed
        // @ts-ignore
        const pw = await import("playwright").catch(() => null as any);
        if (!pw || !pw.chromium) {
          enqueue(sseData({ type: "error", message: "Playwright not installed. Run: npm i -D playwright && npx playwright install chromium" }));
          enqueue(sseData({ type: "done" }));
          try { controller.close(); } catch {}
          return;
        }
        const browser = await pw.chromium.launch({ headless: true });
        const context = await browser.newContext({ userAgent: UA });
        const page = await context.newPage();
        let lastUrl: string | null = null;
        try {
          await page.route("**/*", (route: any) => {
            const req = route.request();
            const baseHeaders = req.headers();
            const headers = Object.assign({}, baseHeaders, {
              "User-Agent": UA,
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "Cache-Control": "no-cache",
              "Pragma": "no-cache",
              Referer: lastUrl || "https://www.yellowpages.com/",
            });
            route.continue({ headers });
          });
        } catch {}

        let total: number | null = null;
        let perPage: number | null = null;
        let emitted = 0;
        let end = maxPages;
        let sawTotal = false;
        let p = 1;
        let nextUrlOverride: string | null = null;
        while (p <= end) {
          const url = normalizePlusUrl(nextUrlOverride || buildUrl(p), p);
          try {
            // For pages > 1, prefer YellowPages AJAX snippet first
            if (p > 1) {
              try {
                const ajaxUrl = url.includes('ajax=true') ? url : url + (url.includes('?') ? '&' : '?') + 'ajax=true';
                const snippet = await page.evaluate(async (u) => {
                  try {
                    const res = await fetch(u, { credentials: 'include' as any, headers: { 'X-Requested-With': 'XMLHttpRequest' } as any });
                    if (!res.ok) return null;
                    return await res.text();
                  } catch { return null; }
                }, ajaxUrl);
                if (snippet && typeof snippet === 'string') {
                  const extracted = await page.evaluate((html) => {
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const out: { name: string; website: string | null }[] = [];
                    const cards = Array.from(doc.querySelectorAll('div.result, div.srp-listing, article.srp-listing, div.business-card, div.info'));
                    const extractRedirect = (u: string) => {
                      try {
                        const x = new URL(u, 'https://www.yellowpages.com');
                        if (x.pathname === '/redirect' || x.pathname === '/redir' || x.pathname === '/link') {
                          const t = x.searchParams.get('url');
                          if (t) return decodeURIComponent(t);
                        }
                        return u;
                      } catch { return u; }
                    };
                    for (const el of cards) {
                      const name = (el.querySelector('a.business-name span')?.textContent || el.querySelector('a.business-name')?.textContent || (el.querySelector('h2 a, h3 a') as HTMLAnchorElement | null)?.textContent || '').trim();
                      if (!name) continue;
                      // Try multiple selectors for website
                      let href = (el.querySelector('a.track-visit-website') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                      if (!href) href = (el.querySelector('a.website, a.website-link') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                      if (!href) href = (el.querySelector('a[href*="/redirect?url="], a[href*="/redir?url="], a[href*="/link?url="]') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                      if (!href) {
                        const anchors = Array.from(el.querySelectorAll('a[href]')) as HTMLAnchorElement[];
                        for (const a of anchors) {
                          const raw = (a.getAttribute('href') || '').trim();
                          if (!raw) continue;
                          const abs = extractRedirect(raw);
                          if (/yellowpages\.com|\/directions|\/map\b|^tel:|^mailto:/i.test(abs)) continue;
                          if (/^https?:\/\//i.test(abs)) { href = abs; break; }
                        }
                      }
                      if (href) href = extractRedirect(href);
                      out.push({ name, website: href ? (href as any) : (null as any) });
                    }
                    return { rows: out, cards: cards.length };
                  }, snippet);
                  if (extracted && typeof extracted === 'object' && Array.isArray((extracted as any).rows)) {
                    const rowsBefore = (extracted as any).rows.length;
                    const deduped = dedupeRows((extracted as any).rows);
                    enqueue(sseData({ type: 'debug', source: 'yellowpages', page: p, url: ajaxUrl, method: 'yp-ajax', ajaxPrimaryRows: rowsBefore, rows: deduped.length, cards: (extracted as any).cards }));
                    if (deduped.length) {
                      for (const r of deduped) {
                        const key = `${String(r?.name || '').trim().toLowerCase()}|${normalizeHost(r?.website || '')}`;
                        if (seenKeys.has(key)) continue;
                        seenKeys.add(key);
                        enqueue(sseData({ type: 'row', name: r.name, website: r.website, source: 'yellowpages', method: 'yp-ajax', page: p }));
                      }
                      enqueue(sseData({ type: 'status', message: 'page_done', page: p }));
                      p += 1;
                      continue;
                    }
                  }
                }
                // Fallback: try snippet endpoint explicitly if ajax=true returned empty
                try {
                  const snippetUrl = (() => {
                    const base = 'https://www.yellowpages.com/search/snippet';
                    const qs = `search_terms=${encodePlus(industry)}&geo_location_terms=${encodePlus(city)}&page=${encodePlus(String(p))}`;
                    return `${base}?${qs}`;
                  })();
                  const snippet2 = await page.evaluate(async (u) => {
                    try {
                      const res = await fetch(u, { credentials: 'include' as any, headers: { 'X-Requested-With': 'XMLHttpRequest' } as any });
                      if (!res.ok) return null;
                      return await res.text();
                    } catch { return null; }
                  }, snippetUrl);
                  if (snippet2 && typeof snippet2 === 'string') {
                    const extracted2 = await page.evaluate((html) => {
                      const doc = new DOMParser().parseFromString(html, 'text/html');
                      const out: { name: string; website: string | null }[] = [];
                      const cards = Array.from(doc.querySelectorAll('div.result, div.srp-listing, article.srp-listing, div.business-card, div.info'));
                      const extractRedirect = (u: string) => {
                        try {
                          const x = new URL(u, 'https://www.yellowpages.com');
                          if (x.pathname === '/redirect' || x.pathname === '/redir' || x.pathname === '/link') {
                            const t = x.searchParams.get('url');
                            if (t) return decodeURIComponent(t);
                          }
                          return u;
                        } catch { return u; }
                      };
                      for (const el of cards) {
                        const name = (el.querySelector('a.business-name span')?.textContent || el.querySelector('a.business-name')?.textContent || (el.querySelector('h2 a, h3 a') as HTMLAnchorElement | null)?.textContent || '').trim();
                        if (!name) continue;
                        let href = (el.querySelector('a.track-visit-website') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                        if (!href) href = (el.querySelector('a.website, a.website-link') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                        if (!href) href = (el.querySelector('a[href*="/redirect?url="], a[href*="/redir?url="], a[href*="/link?url="]') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                        if (!href) {
                          const anchors = Array.from(el.querySelectorAll('a[href]')) as HTMLAnchorElement[];
                          for (const a of anchors) {
                            const raw = (a.getAttribute('href') || '').trim();
                            if (!raw) continue;
                            const abs = extractRedirect(raw);
                            if (/yellowpages\.com|\/directions|\/map\b|^tel:|^mailto:/i.test(abs)) continue;
                            if (/^https?:\/\//i.test(abs)) { href = abs; break; }
                          }
                        }
                        if (href) href = extractRedirect(href);
                        out.push({ name, website: href ? (href as any) : (null as any) });
                      }
                      return { rows: out, cards: cards.length };
                    }, snippet2);
                    if (extracted2 && typeof extracted2 === 'object' && Array.isArray((extracted2 as any).rows)) {
                      const rowsBefore = (extracted2 as any).rows.length;
                      const deduped = dedupeRows((extracted2 as any).rows);
                      enqueue(sseData({ type: 'debug', source: 'yellowpages', page: p, url: snippetUrl, method: 'yp-snippet', ajaxSnippetRows: rowsBefore, rows: deduped.length, cards: (extracted2 as any).cards }));
                      if (deduped.length) {
                        for (const r of deduped) {
                          const key = `${String(r?.name || '').trim().toLowerCase()}|${normalizeHost(r?.website || '')}`;
                          if (seenKeys.has(key)) continue;
                          seenKeys.add(key);
                          enqueue(sseData({ type: 'row', name: r.name, website: r.website, source: 'yellowpages', method: 'yp-snippet', page: p }));
                        }
                        enqueue(sseData({ type: 'status', message: 'page_done', page: p }));
                        p += 1;
                        continue;
                      }
                    }
                  }
                } catch {}
              } catch {}
            }
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
            lastUrl = url;
            // ensure URL reflects the requested page number
            try {
              await page.waitForFunction((pn) => {
                try { return new URL(window.location.href).searchParams.get('page') === String(pn); } catch { return true; }
              }, p, { timeout: 3000 });
            } catch {}
            // small settle delay to let listings render
            await page.waitForTimeout(600);
            try { await page.waitForLoadState('networkidle', { timeout: 5000 } as any); } catch {}
            // Best-effort consent dismissal
            try {
              await page.evaluate(() => {
                const clickText = (rx: RegExp) => {
                  const btns = Array.from(document.querySelectorAll('button, a')) as HTMLElement[];
                  for (const b of btns) {
                    const t = (b.textContent || '').toLowerCase();
                    if (rx.test(t)) { (b as any).click?.(); break; }
                  }
                };
                clickText(/accept|agree|consent|got it/i);
              });
            } catch {}
            try { await page.waitForSelector('div.result, div.srp-listing, article.srp-listing', { timeout: 12000 } as any); } catch {}
            // if still potentially empty, scroll to trigger any lazy render
            try {
              await page.evaluate(async () => {
                const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
                for (let i = 0; i < 2; i++) { window.scrollBy(0, window.innerHeight * 2); await sleep(200); }
                window.scrollTo(0, 0);
              });
            } catch {}
            const data = await page.evaluate(() => {
              function extractRedirect(u: string) {
                try {
                  const x = new URL(u, "https://www.yellowpages.com");
                  if (x.pathname === "/redirect" || x.pathname === "/redir" || x.pathname === "/link") {
                    const t = x.searchParams.get("url");
                    if (t) return decodeURIComponent(t);
                  }
                  return u;
                } catch { return u; }
              }
              const out: { name: string; website: string | null }[] = [];
              const cards = Array.from(document.querySelectorAll("div.result, div.srp-listing, article.srp-listing, div.business-card, div.info"));
              for (const el of cards) {
                const name = (el.querySelector("a.business-name span")?.textContent || el.querySelector("a.business-name")?.textContent || (el.querySelector('h2 a, h3 a') as HTMLAnchorElement | null)?.textContent || "").trim();
                if (!name) continue;
                let href = (el.querySelector("a.track-visit-website") as HTMLAnchorElement | null)?.getAttribute("href") || "";
                if (!href) href = (el.querySelector('a.website, a.website-link') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                if (!href) href = (el.querySelector('a[href*="/redirect?url="], a[href*="/redir?url"], a[href*="/link?url="]') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                if (!href) {
                  const anchors = Array.from(el.querySelectorAll('a[href]')) as HTMLAnchorElement[];
                  for (const a of anchors) {
                    const raw = (a.getAttribute('href') || '').trim();
                    if (!raw) continue;
                    const abs = extractRedirect(raw);
                    if (/yellowpages\.com|\/directions|\/map\b|^tel:|^mailto:/i.test(abs)) continue;
                    if (/^https?:\/\//i.test(abs)) { href = abs; break; }
                  }
                }
                if (href) href = extractRedirect(href);
                out.push({ name, website: href ? (href as any) : (null as any) });
              }
              let total: number | null = null;
              try {
                const holder = document.querySelector('#refine-search, .pagination')?.textContent || document.body.innerText || "";
                const m = holder.match(/Showing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)/i);
                if (m) total = parseInt(m[1].replace(/,/g, ''), 10);
              } catch {}
              // Detect next-page presence
              let hasNext = false;
              try {
                const nextA = Array.from(document.querySelectorAll('a, button'))
                  .find((a: any) => /next/i.test((a.textContent || a.getAttribute('aria-label') || '').toLowerCase()));
                if (nextA && !(nextA as any).disabled) hasNext = true;
              } catch {}
              return { rows: out, total, hasNext, cards: cards.length };
            });

            if (!sawTotal && data.total && data.rows.length) {
              total = data.total;
              perPage = data.rows.length;
              const totalPages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
              end = Math.min(end, totalPages);
              sawTotal = true;
              enqueue(sseData({ type: "debug", source: "yellowpages", page: p, url, total, perPage, totalPages }));
            }
            // emit per-page debug with row count
            const beforeLen = Array.isArray(data.rows) ? data.rows.length : 0;
            const deduped = dedupeRows(data.rows || []);
            enqueue(sseData({ type: "debug", source: "yellowpages", page: p, url, method: 'yp-playwright', rowsBeforeDedup: beforeLen, rows: deduped.length, cards: data.cards }));
            // If page unexpectedly 0 rows, try YP ajax snippet endpoint as a fallback
            if (deduped.length === 0) {
              try {
                const ajaxUrl = url.includes('ajax=true') ? url : url + (url.includes('?') ? '&' : '?') + 'ajax=true';
                const snippet = await page.evaluate(async (u) => {
                  try {
                    const res = await fetch(u, { credentials: 'include' as any, headers: { 'X-Requested-With': 'XMLHttpRequest' } as any });
                    if (!res.ok) return null;
                    return await res.text();
                  } catch { return null; }
                }, ajaxUrl);
                if (snippet && typeof snippet === 'string') {
                  const extracted = await page.evaluate((html) => {
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const out: { name: string; website: string | null }[] = [];
                    const cards = Array.from(doc.querySelectorAll('div.result, div.srp-listing, article.srp-listing, div.business-card, div.info'));
                    const extractRedirect = (u: string) => {
                      try {
                        const x = new URL(u, 'https://www.yellowpages.com');
                        if (x.pathname === '/redirect' || x.pathname === '/redir' || x.pathname === '/link') {
                          const t = x.searchParams.get('url');
                          if (t) return decodeURIComponent(t);
                        }
                        return u;
                      } catch { return u; }
                    };
                    for (const el of cards) {
                      const name = (el.querySelector('a.business-name span')?.textContent || el.querySelector('a.business-name')?.textContent || (el.querySelector('h2 a, h3 a') as HTMLAnchorElement | null)?.textContent || '').trim();
                      if (!name) continue;
                      let href = (el.querySelector('a.track-visit-website') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                      if (!href) href = (el.querySelector('a.website, a.website-link') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                      if (!href) href = (el.querySelector('a[href*="/redirect?url="], a[href*="/redir?url"], a[href*="/link?url="]') as HTMLAnchorElement | null)?.getAttribute('href') || '';
                      if (!href) {
                        const anchors = Array.from(el.querySelectorAll('a[href]')) as HTMLAnchorElement[];
                        for (const a of anchors) {
                          const raw = (a.getAttribute('href') || '').trim();
                          if (!raw) continue;
                          const abs = extractRedirect(raw);
                          if (/yellowpages\.com|\/directions|\/map\b|^tel:|^mailto:/i.test(abs)) continue;
                          if (/^https?:\/\//i.test(abs)) { href = abs; break; }
                        }
                      }
                      if (href) href = extractRedirect(href);
                      out.push({ name, website: href ? (href as any) : (null as any) });
                    }
                    return { rows: out, cards: cards.length };
                  }, snippet);
                  if (extracted && typeof extracted === 'object' && Array.isArray((extracted as any).rows)) {
                    const rowsBefore = (extracted as any).rows.length;
                    const dedup2 = dedupeRows((extracted as any).rows);
                    enqueue(sseData({ type: 'debug', source: 'yellowpages', page: p, url: ajaxUrl, method: 'yp-ajax', ajaxRows: rowsBefore, rows: dedup2.length, cards: (extracted as any).cards }));
                    if (dedup2.length) {
                      for (const r of dedup2) {
                        const key = `${String(r?.name || '').trim().toLowerCase()}|${normalizeHost(r?.website || '')}`;
                        if (seenKeys.has(key)) continue;
                        seenKeys.add(key);
                        enqueue(sseData({ type: 'row', name: r.name, website: r.website, source: 'yellowpages', method: 'yp-ajax', page: p }));
                        emitted += 1;
                      }
                    }
                  }
                }
              } catch {}
            }
            for (const r of deduped) {
              const key = `${String(r?.name || '').trim().toLowerCase()}|${normalizeHost(r?.website || '')}`;
              if (seenKeys.has(key)) continue;
              seenKeys.add(key);
              enqueue(sseData({ type: "row", name: r.name, website: r.website, source: "yellowpages", method: 'yp-playwright', page: p }));
              emitted += 1;
            }
            // Prefer in-page pagination href for next page if present
            try {
              const href = await page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
                // Try rel=next first
                const relNext = document.querySelector('a[rel="next"]') as HTMLAnchorElement | null;
                const pick = relNext || anchors.find(a => /next/i.test((a.textContent || a.getAttribute('aria-label') || '')));
                if (pick) {
                  const raw = pick.getAttribute('href') || '';
                  try { return new URL(raw, location.origin).toString(); } catch { return raw; }
                }
                // fallback: find a numeric page link equal to current+1
                const cur = new URL(location.href).searchParams.get('page');
                const want = String((cur ? (parseInt(cur) || 1) : 1) + 1);
                const num = anchors.find(a => (a.textContent || '').trim() === want);
                if (num) {
                  const raw2 = num.getAttribute('href') || '';
                  try { return new URL(raw2, location.origin).toString(); } catch { return raw2; }
                }
                return null;
              });
              nextUrlOverride = (href && typeof href === 'string' && href.length) ? normalizePlusUrl(href, p + 1) : null;
            } catch { nextUrlOverride = null; }
            // If this page unexpectedly yielded 0 rows, force next URL via builder (with + encoding)
            if (!data.rows.length) nextUrlOverride = buildUrl(p + 1);
            // advance page counter
            p += 1;
          } catch (e: any) {
            enqueue(sseData({ type: "stderr", message: `YP page ${p} failed: ${String(e?.message || e)}` }));
            p += 1; // keep advancing despite errors
            continue;
          }
          // page processed; emit progress
          enqueue(sseData({ type: "status", message: "page_done", page: p }));
        }

        await context.close();
        await browser.close();
        enqueue(sseData({ type: "status", message: "yp_done" }));
        enqueue(sseData({ type: "done" }));
        try { controller.close(); } catch {}
      })().catch((e) => {
        enqueue(sseData({ type: "error", message: String(e?.message || e) }));
        enqueue(sseData({ type: "done" }));
        try { controller.close(); } catch {}
      });
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


