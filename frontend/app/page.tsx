"use client";

import { useRef, useState } from "react";

type Row = { name: string; website: string; city?: string; query?: string; source?: string; revenueScore?: number };

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
  const pagesSeenRef = useRef<Set<string>>(new Set());
  const [pageCount, setPageCount] = useState<number>(0);
  const [rowCount, setRowCount] = useState<number>(0);

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
          city: (msg.city || msg.location || ""),
          query: (msg.query || ""),
          source: (msg.source || msg.method || ""),
        });
        // schedule a flush soon to minimize re-renders
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null;
            const queued = pendingRowsRef.current.splice(0);
            if (queued.length) {
              setRows((prev) => {
                const next = queued.concat(prev);
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
      // Force browser-first for reliability
      params.set("forceBrowserFirst", browserFirst ? "true" : "false");
      // Using orchestrator (all cities); no per-city params needed
      params.set("headless", "true");
      params.set("pageTimeoutMs", "15000");
      params.set("pageJitterMinMs", "1200");
      params.set("pageJitterMaxMs", "3000");
      params.set("maxRetriesPerPage", "1");
      params.set("fresh", "true");
      // Always run orchestrator across bundled city list
      params.delete("city");
      params.set("allCities", "true");
      params.set("exhaustCity", "true");
      const es = new EventSource(`/api/orchestrator/stream?${params.toString()}`);
      esRef.current = es;
      setCurrentTerm(q);
      setStatus("Scraping…");
      const handleData = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data);
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
            const next = queued.concat(prev);
            if (next.length > MAX_ROWS) next.length = MAX_ROWS;
            return next;
          });
          setRowCount((c) => c + queued.length);
        }
        setStatus("Done");
        setIsLoading(false);
        es.close();
      });
      es.onerror = () => {
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

  function stopStream() {
    try { if (esRef.current) { esRef.current.close(); esRef.current = null; } } catch {}
    setIsLoading(false);
    setIsPaused(false);
    bufferedRef.current = [];
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    const queued = pendingRowsRef.current.splice(0);
    if (queued.length) {
      setRows((prev) => {
        const next = queued.concat(prev);
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

  return (
    <main className="max-w-full mx-auto p-3">
      <div className="flex items-center gap-3 mb-3">
        <h1 className="text-lg font-semibold whitespace-nowrap">AI List Builder</h1>
        <input
          className="border rounded-md px-2 py-1 w-[360px] focus:outline-none focus:ring focus:ring-blue-200"
          placeholder="Industry (e.g., nail salons)"
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
        />
        {/* City input removed: orchestrator iterates city list automatically */}
        <button
          className="bg-gray-200 text-gray-900 px-2 py-1 rounded-md disabled:opacity-60"
          disabled={!isLoading}
          onClick={() => (isPaused ? resumeStream() : pauseStream())}
        >
          {isPaused ? "Resume" : "Pause"}
        </button>
        <button
          className="bg-red-600 text-white px-2 py-1 rounded-md hover:bg-red-700 disabled:opacity-60"
          disabled={!isLoading}
          onClick={stopStream}
        >
          Stop
        </button>
        <button className="bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 disabled:opacity-60" disabled={isLoading} onClick={() => runStream(industry.trim()) }>
          {isLoading ? (
            <span className="inline-flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0"></path></svg>
              Working…
            </span>
          ) : (
            "Search"
          )}
        </button>
        {currentTerm && (
          <span className="text-xs text-gray-700">Now scraping: <span className="font-medium">{currentTerm}</span></span>
        )}
        {currentCity && (
          <span className="text-xs text-gray-700">City: <span className="font-medium">{currentCity}</span></span>
        )}
        <span className="text-xs text-gray-700">Rows: <span className="font-medium">{rowCount}</span></span>
        <span className="text-xs text-gray-700">Pages: <span className="font-medium">{pageCount}</span></span>
        <button className="text-xs text-blue-600 underline" onClick={() => setShowLogs((v) => !v)}>
          {showLogs ? "Hide details" : "Show details"}
        </button>
        {status && (
          <p className="text-xs text-gray-600 inline-flex items-center gap-2">
            <svg className="animate-spin h-3 w-3 text-blue-600" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0"></path></svg>
            {status}
          </p>
        )}
        {/* planning UI removed */}
      </div>

      {showLogs && (
        <section className="bg-white rounded-md border p-2 shadow-sm mb-2">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-medium text-sm">Activity</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">{logs.length} logs</span>
              <button className="text-xs text-blue-600" onClick={() => setLogs([])}>Clear</button>
            </div>
          </div>
          <div className="max-h-40 overflow-auto text-xs font-mono leading-5">
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

      <section className="bg-white rounded-md border p-2 shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold">Results</h2>
          <div className="flex items-center gap-3">
            <button
              className="text-sm text-blue-600"
              onClick={() => {
                // Export visible rows to CSV
                const headers = ["Name","Website","City","Query","Source"];
                const csvRows = rows.map((r) => [
                  (r.name || "").replace(/\s+/g, " ").trim(),
                  r.website || "",
                  r.city || "",
                  r.query || "",
                  r.source || "",
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
              }}
            >
              Export CSV
            </button>
            <button className="text-sm text-blue-600" onClick={() => { setRows([]); seenKeysRef.current.clear(); setStatus(""); setIsLoading(false); if (esRef.current) { esRef.current.close(); esRef.current = null; } }}>Clear</button>
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border">
          <div className="max-h-[calc(100vh-140px)] overflow-auto">
            <table className="min-w-full border-collapse text-sm table-fixed">
              <thead>
                <tr className="bg-gray-100">
                  <th className="sticky top-0 bg-gray-100 z-10 text-left p-2 border w-1/3">Name</th>
                  <th className="sticky top-0 bg-gray-100 z-10 text-left p-2 border w-1/3">Website</th>
                  <th className="sticky top-0 bg-gray-100 z-10 text-left p-2 border w-1/6">City</th>
                  <th className="sticky top-0 bg-gray-100 z-10 text-left p-2 border w-1/6">Query</th>
                  <th className="sticky top-0 bg-gray-100 z-10 text-left p-2 border w-1/6">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .slice()
                  .map((r, i) => (
                    <tr key={`${r.website}-${i}`} className="odd:bg-white even:bg-gray-50">
                      <td className="p-2 border align-top">{r.name || ""}</td>
                      <td className="p-2 border align-top break-words"><a className="text-blue-600 hover:underline" href={r.website} target="_blank" rel="noreferrer">{r.website}</a></td>
                      <td className="p-2 border align-top">{r.city || ""}</td>
                      <td className="p-2 border align-top">{r.query || ""}</td>
                      <td className="p-2 border align-top">{r.source || ""}</td>
                    </tr>
                  ))}
                {rows.length === 0 && (
                  <tr>
                    <td className="p-6 text-gray-500 text-center border" colSpan={5}>No results yet. Click Search to start.</td>
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
