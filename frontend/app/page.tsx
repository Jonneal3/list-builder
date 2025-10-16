"use client";

import { useEffect, useRef, useState } from "react";

type Row = {
  name: string;
  website: string;
  city?: string;
  state?: string;
  query?: string;
  source?: string;
  phone?: string | null;
  address?: string | null;
  rating?: number | null;
  reviews_count?: number | null;
  categories?: string[] | string | null;
  hours_text?: string | null;
  email?: string | null;
  yp_listing_url?: string | null;
  revenueScore?: number;
  employees?: string | null;
  industry?: string | null;
  keywords?: string | null;
  linkedin_url?: string | null;
  facebook_url?: string | null;
  twitter_url?: string | null;
  apollo_profile_url?: string | null;
  revenue?: string | null;
};

export default function Home() {
  const [industry, setIndustry] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<string>("");
  const [currentTerm, setCurrentTerm] = useState<string>("");
  const [currentCity, setCurrentCity] = useState<string>("");
  // City input removed; we iterate internal city list via orchestrator
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const seenKeysRef = useRef<Set<string>>(new Set());
  const [browserFirst] = useState<boolean>(true);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const bufferedRef = useRef<any[]>([]);
  const pendingRowsRef = useRef<Row[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const FLUSH_INTERVAL_MS = 150;
  const MAX_ROWS = 1000;
  const [logs, setLogs] = useState<Array<{ ts: number; level: string; text: string }>>([]);
  const [showLogs, setShowLogs] = useState<boolean>(false);
  const [logsExpanded, setLogsExpanded] = useState<boolean>(false);
  const pagesSeenRef = useRef<Set<string>>(new Set());
  const [pageCount, setPageCount] = useState<number>(0);
  const [rowCount, setRowCount] = useState<number>(0);
  const [source, setSource] = useState<'yellowpages' | 'googlemaps' | 'apollo'>('yellowpages');
  const [showBrowser, setShowBrowser] = useState<boolean>(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [waitingForApolloLogin, setWaitingForApolloLogin] = useState<boolean>(false);
  const [apolloEmail, setApolloEmail] = useState<string>("");
  const [apolloPassword, setApolloPassword] = useState<string>("");
  // Cookie input removed: we now prioritize login-based Apollo auth

  // Column resizing state (px widths)
  const [colWidths, setColWidths] = useState<Record<string, number>>({
    idx: 40,
    name: 220,
    website: 260,
    phone: 120,
    address: 260,
    city: 140,
    state: 90,
    employees: 90,
    rating: 90,
    reviews: 90,
    categories: 220,
    hours: 180,
    email: 180,
    yp: 160,
    industry: 160,
    keywords: 220,
    linkedin: 200,
    facebook: 200,
    twitter: 200,
    apollo: 160,
    revenue: 100,
    source: 100,
    query: 140,
  });
  const resizingRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const r = resizingRef.current;
      if (!r) return;
      const dx = e.clientX - r.startX;
      const next = Math.max(60, r.startW + dx);
      setColWidths((prev) => ({ ...prev, [r.key]: next }));
    }
    function onUp() {
      resizingRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    if (resizingRef.current) {
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [resizingRef.current]);
  // Auto-scroll to bottom on new rows
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [rows.length]);
  function startResize(key: string, e: React.MouseEvent) {
    const startW = colWidths[key] || 120;
    resizingRef.current = { key, startX: e.clientX, startW };
  }

  const MAX_LOGS = 500;
  function pushLog(level: string, text: string) {
    const entry = { ts: Date.now(), level, text };
    setLogs((prev) => {
      const next = [entry, ...prev];
      if (next.length > MAX_LOGS) next.length = MAX_LOGS;
      return next;
    });
  }
  

  function normalizeWebsite(url: string) {
    try {
      const u = new URL(url);
      const host = u.host.replace(/^www\./, "").toLowerCase();
      const origin = `${u.protocol}//${u.host}`;
      return { host, origin };
    } catch {
      try {
        // attempt to coerce missing protocol
        const u2 = new URL(`https://${url}`);
        const host = u2.host.replace(/^www\./, "").toLowerCase();
        const origin = `${u2.protocol}//${u2.host}`;
        return { host, origin };
      } catch {
        return { host: url.toLowerCase(), origin: url };
      }
    }
  }

  function deriveCompanyNameFromHost(host: string) {
    const base = host.split(".").slice(0, -1).join(" ") || host; // drop TLD
    return base
      .split(/[-_.\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // Removed planning and angle selection

  function processMsg(msg: any, q: string) {
    if (msg && typeof msg === "object") {
      if (msg.type === "status" && msg.message === "city_start") {
        setCurrentCity(String(msg.city || ""));
        pushLog("info", `City start: ${String(msg.city || "").trim()}`);
        return;
      }
      if (msg.type === "status" && msg.source === "apollo" && msg.message === "awaiting_manual_login") {
        setWaitingForApolloLogin(true);
        pushLog("info", "Apollo login required - please log in to Apollo in the browser window");
        return;
      }
      if (msg.type === "status" && msg.source === "apollo" && msg.message === "manual_login_detected") {
        setWaitingForApolloLogin(false);
        pushLog("info", "Apollo login detected - proceeding with scraping");
        return;
      }
      if (msg.type === "row") {
        const rawWebsite = String(msg.website ?? "");
        const { host, origin } = normalizeWebsite(rawWebsite);
        let displayName = (msg.name || "").toString().trim();
        const looksLikeUrlish = displayName.startsWith("http") || displayName.includes("/") || displayName.includes(".");
        if (!displayName || looksLikeUrlish) {
          displayName = deriveCompanyNameFromHost(host);
        }
        const key = `${displayName.toLowerCase()}|${host}`;
        if (seenKeysRef.current.has(key)) return;
        seenKeysRef.current.add(key);
        // enqueue row for batched rendering
        pendingRowsRef.current.push({
          name: displayName,
          website: (origin || rawWebsite || ""),
          city: (msg.address_city || msg.city || msg.location || ""),
          state: (msg.address_state || ""),
          query: (msg.query || ""),
          source: (msg.source || msg.method || ""),
          phone: (msg.phone ?? null),
          address: (msg.address ?? null),
          rating: (typeof msg.rating === 'number' ? msg.rating : (msg.rating == null ? null : Number(msg.rating))),
          reviews_count: (Number.isFinite(msg.reviews_count) ? Number(msg.reviews_count) : null),
          categories: (Array.isArray(msg.categories) ? msg.categories : (msg.categories ? String(msg.categories) : null)),
          hours_text: (msg.hours_text ?? null),
          email: (msg.email ?? null),
          yp_listing_url: (msg.yp_listing_url ?? null),
          employees: (msg.employee_count ?? msg.employeeCount ?? null),
          industry: (msg.industry ?? null),
          keywords: (typeof msg.keywords === 'string' ? msg.keywords : (Array.isArray(msg.keywords) ? msg.keywords.join(', ') : null)),
          linkedin_url: (msg.linkedin_url ?? null),
          facebook_url: (msg.facebook_url ?? null),
          twitter_url: (msg.twitter_url ?? null),
          apollo_profile_url: (msg.apollo_profile_url ?? null),
          revenue: (msg.revenue ?? null),
        });
        // schedule a flush soon to minimize re-renders
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null;
            const queued = pendingRowsRef.current.splice(0);
            if (queued.length) {
              setRows((prev) => {
                const next = prev.concat(queued);
                if (next.length > MAX_ROWS) next.length = MAX_ROWS;
                return next;
              });
              setRowCount((c) => c + queued.length);
            }
          }, FLUSH_INTERVAL_MS);
        }
        if (typeof msg.location === "string" && msg.location) setCurrentCity(msg.location);
        if (typeof msg.source === "string") setStatus(`Source: ${msg.source}`);
        return;
      }
      if (msg.type === "debug") {
        if (String(msg.source || "") === "yellowpages") {
          const city = String(msg.city || currentCity || "").trim();
          const page = Number(msg.page || 0);
          if (page > 0 && city) {
            const key = `${city}|${page}`;
            if (!pagesSeenRef.current.has(key)) {
              pagesSeenRef.current.add(key);
              setPageCount(pagesSeenRef.current.size);
            }
          }
          const method = String(msg.method || msg.info || "");
          const rows = typeof msg.rows === "number" ? msg.rows : undefined;
          if (page || rows != null || method) {
            const bits = [city ? `[${city}]` : "", page ? `p${page}` : "", rows != null ? `${rows} rows` : "", method ? `(${method})` : ""].filter(Boolean).join(" ");
            if (bits) pushLog("debug", `YP ${bits}`);
          }
        } else if (String(msg.source || "") === "apollo") {
          const info = String(msg.info || msg.message || "");
          if (info === 'planned_nav') {
            const label = String(msg.label || '');
            const url = String(msg.url || '');
            pushLog('debug', `Apollo nav ${label ? `[${label}] `: ''}${url}`);
          } else if (info === 'planned_error') {
            pushLog('error', `Apollo error: ${String(msg.error || '')}`);
          } else if (info === 'filtered_nav_start' || info === 'filtered_nav_done') {
            pushLog('debug', `Apollo ${info.replace(/_/g,' ')} ${String(msg.url || '')}`);
          } else if (info === 'total_count_simple') {
            const t = (typeof msg.totalCount === 'number') ? msg.totalCount : undefined;
            if (t != null) pushLog('info', `Apollo total ~${t}`);
          } else if (info === 'simple_page_nav') {
            const p = Number(msg.page || 0);
            if (p) pushLog('debug', `Apollo page ${p}`);
          } else if (info === 'simple_page_items') {
            const p = Number(msg.page || 0);
            const c = Number(msg.count || 0);
            pushLog('debug', `Apollo page ${p} items ${c}`);
          } else if (info === 'simple_page_added') {
            const p = Number(msg.page || 0);
            const tot = Number(msg.total || 0);
            pushLog('debug', `Apollo page ${p} cumulative ${tot}`);
          } else if (info === 'enrich_start') {
            pushLog('debug', `Apollo email enrich start (${Number(msg.count||0)} candidates, batch ${Number(msg.batchSize||0)})`);
          } else if (info === 'enrich_batch_done') {
            pushLog('debug', `Apollo email enrich batch ${Number(msg.start||0)}-${Number(msg.end||0)}`);
          } else if (info === 'return_rows') {
            pushLog('info', `Apollo rows ${Number(msg.rows||0)}`);
          } else if (String(msg.message||'') === 'scrape_planned_start') {
            pushLog('info', `Apollo planned scrape start`);
          } else if (String(msg.message||'') === 'scrape_planned_done') {
            pushLog('info', `Apollo planned scrape done (${Number(msg.rows||0)} rows)`);
          } else {
            pushLog('debug', JSON.stringify(msg));
          }
        } else {
          pushLog("debug", JSON.stringify(msg));
        }
        return;
      }
      if (msg.type === "searching") {
        const dir = (msg.directory || "").toString();
        const ang = (msg.angle || "").toString();
        setCurrentTerm(ang || q);
        setStatus(dir ? `Scraping ${dir}…` : "Scraping…");
        pushLog("info", ang ? `Angle: ${ang}` : (dir ? `Searching: ${dir}` : "Searching"));
        return;
      }
      if (msg.type === "status" && typeof msg.message === "string") {
        setStatus(msg.message);
        const city = String(msg.city || currentCity || "").trim();
        if (String(msg.source||'') === 'apollo') {
          if (msg.message === 'state_start') {
            pushLog('info', `Apollo state start: ${String(msg.state||'')}`);
            return;
          }
          if (msg.message === 'state_done') {
            const added = (typeof msg.added === 'number') ? ` (+${msg.added})` : '';
            pushLog('info', `Apollo state done: ${String(msg.state||'')}${added}`);
            return;
          }
        }
        if (msg.message === "page_done") {
          const page = Number(msg.page || 0);
          if (page > 0) pushLog("info", `${city ? city + ": " : ""}page ${page} done`);
        } else if (msg.message === "total" && typeof msg.total === "number") {
          pushLog("info", `${city ? city + ": " : ""}estimated total ${msg.total}`);
        } else if (msg.message === "pages_done" && typeof msg.pagesFetched === "number") {
          pushLog("info", `${city ? city + ": " : ""}${msg.pagesFetched} pages fetched`);
        } else if (msg.message === "city_pass_start") {
          pushLog("info", `${city ? city + ": " : ""}pass ${msg.pass || 1} start`);
        } else if (msg.message === "city_pass_done") {
          pushLog("info", `${city ? city + ": " : ""}pass ${msg.pass || 1} done (new domains ${msg.new_domains ?? "?"})`);
        } else if (msg.message === "city_done") {
          pushLog("info", `${city || "City"} done`);
        } else if (msg.message === "yp_done") {
          pushLog("info", `YellowPages done`);
        } else if (msg.message) {
          pushLog("info", msg.message);
        }
        return;
      }
      if (msg.type === "export") {
        const fmt = String(msg.format || "");
        const rows = typeof msg.rows === "number" ? msg.rows : undefined;
        const path = String(msg.path || "");
        pushLog("info", `export ${fmt}${rows != null ? ` ${rows} rows` : ""}${path ? ` → ${path}` : ""}`);
        return;
      }
      if (msg.type === "stderr") {
        pushLog("error", String(msg.message || "stderr"));
        return;
      }
    }
  }

  function runStream(q: string) {
    if (!q) {
      setStatus("Please enter an industry");
      return;
    }
    setIsLoading(true);
    setRows([]);
    seenKeysRef.current.clear();
    setIsPaused(false);
    bufferedRef.current = [];
    pendingRowsRef.current = [];
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    setLogs([]);
    pagesSeenRef.current = new Set();
    setPageCount(0);
    setRowCount(0);
    try {
      setStatus("Connecting…");
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      const params = new URLSearchParams();
      params.set("industry", q);
      // Proven-stable defaults for realtime results
      params.set("ypPages", "-1");
      params.set("autoMaxPagesYp", "80");
      params.set("browserFallback", "true");
      // Source selection
      if (source === 'googlemaps') {
        params.set('enableGmaps', 'true');
        params.set('onlyGmaps', 'true');
        // Default to exhaustive GMaps with full details pass
        params.set('gmapsExhaust', 'true');
        params.set('gmapsMaxTotal', '1200');
        params.set('gmapsDetailAll', 'true');
        // reasonable guard in case of heavy listings
        params.set('gmapsLimit', '200');
      } else if (source === 'apollo') {
        // Enable Apollo (will still run YellowPages afterwards)
        params.set('enableGmaps', 'false');
        params.set('onlyGmaps', 'false');
        params.set('enableApollo', 'true');
        params.set('onlyApollo', 'true');
        params.set('apolloLogin', 'true');
        // If credentials provided, use auto-login; otherwise allow manual login flow
        if (apolloEmail && apolloPassword) {
          params.set('apolloEmail', apolloEmail);
          params.set('apolloPassword', apolloPassword);
        } else if (showBrowser) {
          params.set('apolloManualLogin', 'true');
        }
      } else {
        params.set('enableGmaps', 'false');
        params.set('onlyGmaps', 'false');
      }
      // Force browser-first for reliability
      params.set("forceBrowserFirst", browserFirst ? "true" : "false");
      // Using orchestrator (all cities); no per-city params needed
      // Note: headless is now passed at the end based on toggle
      params.set("pageTimeoutMs", "15000");
      params.set("pageJitterMinMs", "1200");
      params.set("pageJitterMaxMs", "3000");
      params.set("maxRetriesPerPage", "1");
      params.set("fresh", "true");
      // Always run orchestrator across bundled city list
      params.delete("city");
      params.set("allCities", "true");
      params.set("exhaustCity", "true");
      // Append headless last to ensure it wins
      if (source === 'apollo') {
        params.set('headless', showBrowser ? 'false' : 'true');
      }
      // Route to appropriate endpoint based on source
      const endpoint = source === 'apollo' ? '/api/orchestrator/stream/apollo' : 
                     source === 'googlemaps' ? '/api/orchestrator/stream/yellowpages' : 
                     '/api/orchestrator/stream/yellowpages';
      const es = new EventSource(`${endpoint}?${params.toString()}`);
      esRef.current = es;
      setCurrentTerm(q);
      setStatus("Scraping…");
      const handleData = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data);
          try { console.log('[SSE]', msg); } catch {}
          if (isPaused) { bufferedRef.current.push(msg); return; }
          processMsg(msg, q);
        } catch {}
      };
      // Support both unnamed messages (orchestrator) and named events (scrape)
      es.onmessage = handleData;
      es.addEventListener("row", handleData as any);
      es.addEventListener("status", handleData as any);
      es.addEventListener("searching", handleData as any);
      es.addEventListener("debug", handleData as any);
      es.addEventListener("stderr", handleData as any);
      es.addEventListener("export", handleData as any);
      es.addEventListener("done", () => {
        // flush any queued rows before closing
        if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
        const queued = pendingRowsRef.current.splice(0);
        if (queued.length) {
          setRows((prev) => {
            const next = prev.concat(queued);
            if (next.length > MAX_ROWS) next.length = MAX_ROWS;
            return next;
          });
          setRowCount((c) => c + queued.length);
        }
        setStatus("Done");
        setIsLoading(false);
        es.close();
      });
      es.onerror = (err: any) => {
        try { console.error('SSE error', err); } catch {}
        setIsLoading(false);
      };
    } catch (e) {
      setStatus("Failed to connect.");
      setIsLoading(false);
    }
  }

  function pauseStream() {
    if (!isLoading) return;
    setIsPaused(true);
    setStatus((s) => (s ? s.replace(/\s*\(paused\)$/,'') + " (paused)" : "Paused"));
  }

  function resumeStream() {
    if (!isLoading) return;
    setIsPaused(false);
    const queued = bufferedRef.current.splice(0);
    for (const msg of queued) processMsg(msg, currentTerm || industry);
    setStatus((s) => (s ? s.replace(/\s*\(paused\)$/,'') : s));
  }

  async function confirmApolloLogin() {
    try {
      // Call the API to signal the backend that login is confirmed
      await fetch('/api/apollo-login-confirm', { method: 'POST' });
      setWaitingForApolloLogin(false);
      pushLog("info", "Apollo login confirmed - proceeding with scraping");
    } catch (error) {
      console.error('Error confirming Apollo login:', error);
      pushLog("error", "Failed to confirm Apollo login");
    }
  }

  function stopStream() {
    try { if (esRef.current) { esRef.current.close(); esRef.current = null; } } catch {}
    setIsLoading(false);
    setIsPaused(false);
    bufferedRef.current = [];
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    const queued = pendingRowsRef.current.splice(0);
    if (queued.length) {
      setRows((prev) => {
        const next = prev.concat(queued);
        if (next.length > MAX_ROWS) next.length = MAX_ROWS;
        return next;
      });
      setRowCount((c) => c + queued.length);
    }
    setStatus("Stopped");
  }

  async function estimateRevenueScore(url: string): Promise<number> {
    // Heuristic: page size + signals
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ac.signal as any, cache: "no-store" });
      clearTimeout(to);
      if (!res.ok) return 0;
      const text = await res.text();
      const len = text.length;
      const lc = text.toLowerCase();
      let score = Math.log10(Math.max(len, 1));
      const signals = ["locations", "franchise", "careers", "about", "our team", "privacy policy", "terms", "contact"];
      for (const s of signals) if (lc.includes(s)) score += 0.5;
      const phones = (lc.match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || []).length;
      score += Math.min(phones, 5) * 0.4;
      const addresses = (lc.match(/\d{2,5}\s+[a-zA-Z\s]+(street|st\.|road|rd\.|ave|avenue|blvd|drive|dr\.)/g) || []).length;
      score += Math.min(addresses, 5) * 0.4;
      return Number.isFinite(score) ? score : 0;
    } catch {
      clearTimeout(to);
      return 0;
    }
  }

  // Background enrich revenue score with small concurrency
  const inflightRef = useRef<number>(0);
  const MAX_CONCURRENT = 3;
  const estimateEnabled = false;
  async function maybeEnrichRow(website: string) {
    if (!estimateEnabled) return;
    if (inflightRef.current >= MAX_CONCURRENT) return;
    inflightRef.current += 1;
    const score = await estimateRevenueScore(website);
    inflightRef.current -= 1;
    setRows((prev) => {
      const copy = [...prev];
      for (let k = 0; k < copy.length; k++) {
        if (copy[k].website === website && (copy[k].revenueScore === undefined || copy[k].revenueScore === null)) {
          copy[k] = { ...copy[k], revenueScore: score };
          break;
        }
      }
      return copy;
    });
  }

  function exportVisibleCsv() {
    const headers = [
      "Name","Website","Phone","Address","City","Rating","Reviews","Categories","Hours","Email","YP Listing","Source","Query",
    ];
    const csvRows = rows.map((r) => [
      (r.name || "").replace(/\s+/g, " ").trim(),
      r.website || "",
      r.phone || "",
      r.address || "",
      r.city || "",
      (r.rating == null ? '' : String(r.rating)),
      (r.reviews_count == null ? '' : String(r.reviews_count)),
      Array.isArray(r.categories) ? r.categories.join('; ') : (r.categories || ''),
      r.hours_text || "",
      r.email || "",
      r.yp_listing_url || "",
      r.source || "",
      r.query || "",
    ]);
    const csv = [headers, ...csvRows]
      .map((cols) => cols.map((c) => {
        const s = String(c ?? "");
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(industry || "results").trim().replace(/\s+/g, "_")}_companies.csv`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();
  }

  function clearRows() {
    setRows([]);
    seenKeysRef.current.clear();
    setStatus("");
    setIsLoading(false);
    try { if (esRef.current) { esRef.current.close(); esRef.current = null; } } catch {}
  }

  return (
    <main className="h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
      {/* Apollo Login Confirmation Modal */}
      {waitingForApolloLogin && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Apollo Login Required</h3>
            <p className="text-gray-600 mb-6">
              Please log in to Apollo in the browser window that opened. Once you're logged in, click the button below to continue.
            </p>
            <div className="flex gap-3">
              <button
                onClick={confirmApolloLogin}
                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors"
              >
                I'm Logged In - Continue
              </button>
              <button
                onClick={stopStream}
                className="flex-1 bg-gray-300 text-gray-700 px-4 py-2 rounded-md hover:bg-gray-400 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className="sticky top-0 z-20 border-b bg-white/80 backdrop-blur">
        <div className="px-2 py-1">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded-md bg-gradient-to-br from-blue-500 to-blue-700 shadow-sm" />
              <h1 className="text-xs font-semibold tracking-tight">AI List Builder</h1>
            </div>
            <div className="flex-1 flex items-center gap-2">
              <input
                className="border rounded-full px-3 h-8 text-xs w-full max-w-[520px] bg-white shadow-sm focus:outline-none focus:ring focus:ring-blue-200"
                placeholder="Industry (e.g., nail salons)"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
              />
              {source === 'apollo' && (
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1 text-xs text-gray-700">
                    <input type="checkbox" checked={showBrowser} onChange={(e) => setShowBrowser(e.target.checked)} />
                    Show browser
                  </label>
                  <input
                    className="border rounded-full px-3 h-8 text-xs w-44 bg-white shadow-sm focus:outline-none focus:ring focus:ring-blue-200"
                    placeholder="Apollo email (optional)"
                    value={apolloEmail}
                    onChange={(e) => setApolloEmail(e.target.value)}
                  />
                  <input
                    className="border rounded-full px-3 h-8 text-xs w-40 bg-white shadow-sm focus:outline-none focus:ring focus:ring-blue-200"
                    placeholder="Password"
                    type="password"
                    value={apolloPassword}
                    onChange={(e) => setApolloPassword(e.target.value)}
                  />
                </div>
              )}
              <select
                className="border rounded-full px-2 h-8 text-xs bg-white shadow-sm focus:outline-none focus:ring focus:ring-blue-200"
                value={source}
                onChange={(e) => setSource(e.target.value as any)}
                aria-label="Source"
              >
                <option value="yellowpages">Yellow Pages</option>
                <option value="googlemaps">Google Maps</option>
                <option value="apollo">Apollo</option>
              </select>
              <button className="h-8 px-3 text-[11px] rounded-full text-white bg-gradient-to-br from-blue-600 to-blue-700 shadow hover:from-blue-700 hover:to-blue-800 disabled:opacity-60" disabled={isLoading || industry.trim().length === 0} onClick={() => runStream(industry.trim()) } title={industry.trim().length === 0 ? 'Enter an industry to start' : undefined}>
                {isLoading ? (
                  <span className="inline-flex items-center gap-1.5">
                    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0"></path></svg>
                    Working…
                  </span>
                ) : (
                  "Search"
                )}
              </button>
            </div>
            {currentTerm && (
              <span className="hidden md:inline text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded-full px-2 py-0.5">Now: <span className="font-medium">{currentTerm}</span></span>
            )}
            {currentCity && (
              <span className="hidden md:inline text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5">City: <span className="font-medium">{currentCity}</span></span>
            )}
            <span className="text-[11px] text-gray-700 bg-gray-100 rounded-full px-2 py-0.5">Rows: <span className="font-medium">{rowCount}</span></span>
            <span className="text-[11px] text-gray-700 bg-gray-100 rounded-full px-2 py-0.5">Pages: <span className="font-medium">{pageCount}</span></span>
            <button
              className="h-8 px-3 text-[11px] rounded-full border bg-white hover:bg-gray-50 disabled:opacity-60"
              disabled={!isLoading}
              onClick={() => (isPaused ? resumeStream() : pauseStream())}
            >
              {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              className="h-8 px-3 text-[11px] rounded-full text-white bg-gradient-to-br from-rose-500 to-rose-600 shadow hover:from-rose-600 hover:to-rose-700 disabled:opacity-60"
              disabled={!isLoading}
              onClick={stopStream}
            >
              Stop
            </button>
            <button className="text-[11px] text-blue-700 underline" onClick={() => setShowLogs((v) => !v)}>
              {showLogs ? "Hide details" : "Show details"}
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                className="h-8 px-3 text-[11px] rounded-full border bg-white hover:bg-gray-50 text-blue-700"
                onClick={exportVisibleCsv}
              >
                Export
              </button>
              <button
                className="h-8 px-3 text-[11px] rounded-full border bg-white hover:bg-gray-50 text-blue-700"
                onClick={clearRows}
              >
                Clear
              </button>
              {status && (
                <p className="text-[11px] text-gray-700 inline-flex items-center gap-1.5">
                  <svg className="animate-spin h-3 w-3 text-blue-600" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0"></path></svg>
                  {status}
                </p>
              )}
              <ExportsMenu />
            </div>
          </div>
        </div>
      </div>

      {showLogs && (
        <section className="w-full bg-white rounded-md border p-2 shadow-sm mb-2 px-2">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-medium text-sm">Activity</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">{logs.length} logs</span>
              <button className="text-xs text-blue-600" onClick={() => setLogs([])}>Clear</button>
              <button
                className="text-xs text-blue-600"
                onClick={() => {
                  const text = logs.slice().reverse().map(l => `[${new Date(l.ts).toLocaleTimeString()}] ${l.level.toUpperCase()} ${l.text}`).join('\n');
                  try { navigator.clipboard.writeText(text); pushLog('info', 'Logs copied to clipboard'); } catch { pushLog('error', 'Copy failed'); }
                }}
              >Copy</button>
              <button className="text-xs text-blue-600" onClick={() => setLogsExpanded(v => !v)}>{logsExpanded ? 'Shrink' : 'Expand'}</button>
            </div>
          </div>
          <div className={"overflow-auto text-[11px] font-mono leading-5 " + (logsExpanded ? 'max-h-80' : 'max-h-32')}>
            <ul className="space-y-1">
              {logs.map((l, i) => (
                <li key={i} className={l.level === 'error' ? 'text-red-600' : l.level === 'debug' ? 'text-gray-600' : 'text-gray-800'}>
                  <span className="text-gray-400">[{new Date(l.ts).toLocaleTimeString()}]</span> {l.text}
                </li>
              ))}
              {logs.length === 0 && (
                <li className="text-gray-400">No activity yet.</li>
              )}
            </ul>
          </div>
        </section>
      )}

      <section className="w-full mt-1 bg-white p-0">
        <div className="max-h-[calc(100vh-64px)] overflow-auto" ref={listRef}>
          <div className="overflow-x-auto">
            <table className="min-w-max border-collapse text-[11px] leading-5">
              <colgroup>
                <col style={{ width: colWidths.idx }} />
                <col style={{ width: colWidths.name }} />
                <col style={{ width: colWidths.website }} />
                <col style={{ width: colWidths.phone }} />
                <col style={{ width: colWidths.address }} />
                <col style={{ width: colWidths.city }} />
                <col style={{ width: colWidths.state }} />
                <col style={{ width: colWidths.employees }} />
                <col style={{ width: colWidths.rating }} />
                <col style={{ width: colWidths.reviews }} />
                <col style={{ width: colWidths.categories }} />
                <col style={{ width: colWidths.hours }} />
                <col style={{ width: colWidths.email }} />
                <col style={{ width: colWidths.yp }} />
                <col style={{ width: colWidths.industry }} />
                <col style={{ width: colWidths.keywords }} />
                <col style={{ width: colWidths.linkedin }} />
                <col style={{ width: colWidths.facebook }} />
                <col style={{ width: colWidths.twitter }} />
                <col style={{ width: colWidths.apollo }} />
                <col style={{ width: colWidths.revenue }} />
                <col style={{ width: colWidths.source }} />
                <col style={{ width: colWidths.query }} />
              </colgroup>
              <thead>
                <tr className="bg-white">
                  {[
                    { key: 'idx', label: '#', align: 'text-right' },
                    { key: 'name', label: 'Name' },
                    { key: 'website', label: 'Website' },
                    { key: 'phone', label: 'Phone' },
                    { key: 'address', label: 'Address' },
                    { key: 'city', label: 'City' },
                    { key: 'state', label: 'State' },
                    { key: 'employees', label: 'Employees' },
                    { key: 'rating', label: 'Rating' },
                    { key: 'reviews', label: 'Reviews' },
                    { key: 'categories', label: 'Categories' },
                    { key: 'hours', label: 'Hours' },
                    { key: 'email', label: 'Email' },
                    { key: 'yp', label: 'YP Listing' },
                    { key: 'industry', label: 'Industry' },
                    { key: 'keywords', label: 'Keywords' },
                    { key: 'linkedin', label: 'LinkedIn' },
                    { key: 'facebook', label: 'Facebook' },
                    { key: 'twitter', label: 'Twitter' },
                    { key: 'apollo', label: 'Apollo' },
                    { key: 'revenue', label: 'Revenue' },
                    { key: 'source', label: 'Source' },
                    { key: 'query', label: 'Query' },
                  ].map((c) => (
                    <th key={c.key} className={`sticky top-0 bg-white z-10 p-2 border-b-2 border-gray-200 text-[10px] uppercase tracking-wider text-slate-600 ${c.align || 'text-left'} relative select-none`}>
                      <div className="pr-2 whitespace-nowrap">{c.label}</div>
                      <span
                        onMouseDown={(e) => startResize(c.key, e)}
                        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize"
                        style={{ transform: 'translateX(50%)' }}
                        aria-hidden
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows
                  .slice()
                  .map((r, i) => (
                    <tr key={`${r.website}-${i}`} className="odd:bg-white even:bg-slate-50 hover:bg-slate-50">
                      <td className="p-2 border-b border-r border-gray-200 align-top text-right text-[11px] text-gray-500">{i + 1}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.name || ""}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top break-words"><a className="text-blue-700 hover:underline" href={r.website} target="_blank" rel="noreferrer">{r.website}</a></td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.phone || ""}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.address || ""}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.city || ""}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.state || ""}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.employees || ""}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.rating == null ? '' : r.rating.toFixed(1)}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.reviews_count == null ? '' : r.reviews_count}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{Array.isArray(r.categories) ? r.categories.join(', ') : (r.categories || '')}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.hours_text || ""}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top break-words">{r.email || ""}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top break-words">{r.yp_listing_url ? (<a className="text-blue-700 hover:underline" href={r.yp_listing_url} target="_blank" rel="noreferrer">Open</a>) : ''}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.industry || ''}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top break-words">{r.keywords || ''}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top break-words">{r.linkedin_url ? (<a className="text-blue-700 hover:underline" href={r.linkedin_url} target="_blank" rel="noreferrer">LinkedIn</a>) : ''}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top break-words">{r.facebook_url ? (<a className="text-blue-700 hover:underline" href={r.facebook_url} target="_blank" rel="noreferrer">Facebook</a>) : ''}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top break-words">{r.twitter_url ? (<a className="text-blue-700 hover:underline" href={r.twitter_url} target="_blank" rel="noreferrer">Twitter</a>) : ''}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top break-words">{r.apollo_profile_url ? (<a className="text-blue-700 hover:underline" href={r.apollo_profile_url} target="_blank" rel="noreferrer">Apollo</a>) : ''}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.revenue || ''}</td>
                      <td className="p-2 border-b border-r border-gray-200 align-top">{r.source || ""}</td>
                      <td className="p-2 border-b border-gray-200 align-top">{r.query || ""}</td>
                    </tr>
                  ))}
                {rows.length === 0 && (
                  <tr>
                    <td className="p-6 text-gray-500 text-center border-b text-xs" colSpan={14}>No results yet. Click Search to start.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

function ExportsMenu() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<Array<{ name: string; size: number; mtimeMs: number; href: string; ext: string }>>([]);
  async function refresh() {
    try {
      setLoading(true);
      const res = await fetch('/api/exports/list', { cache: 'no-store' });
      const json = await res.json();
      setFiles(Array.isArray(json.files) ? json.files : []);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (open) { refresh(); } }, [open]);
  return (
    <div className="relative">
      <button aria-label="Exports" className="h-8 w-8 rounded-full border bg-white hover:bg-gray-50 flex items-center justify-center shadow-sm" onClick={() => setOpen(v => !v)}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-gray-700"><path fillRule="evenodd" d="M12 3.75a.75.75 0 01.75.75v8.69l2.47-2.47a.75.75 0 011.06 1.06l-3.75 3.75a.75.75 0 01-1.06 0l-3.75-3.75a.75.75 0 111.06-1.06l2.47 2.47V4.5A.75.75 0 0112 3.75zm-6 12a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H6.75a.75.75 0 01-.75-.75z" clipRule="evenodd"/></svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border rounded-md shadow-lg z-20">
          <div className="flex items-center justify-between p-2 border-b">
            <span className="text-sm font-medium">Recent exports</span>
            <button className="text-xs text-blue-600" onClick={refresh} disabled={loading}>{loading ? '...' : 'Refresh'}</button>
          </div>
          <div className="max-h-64 overflow-auto">
            <ul className="divide-y">
              {files.map((f, i) => (
                <li key={i} className="p-2 text-sm flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate">{f.name}</div>
                    <div className="text-[10px] text-gray-500">{Math.round(f.size/1024)} KB • {new Date(f.mtimeMs).toLocaleString()}</div>
                  </div>
                  <a className="text-xs text-blue-700 whitespace-nowrap hover:underline" href={f.href}>Download</a>
                </li>
              ))}
              {files.length === 0 && (
                <li className="p-2 text-xs text-gray-500">No exports yet.</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
