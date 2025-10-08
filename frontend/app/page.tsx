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
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const seenKeysRef = useRef<Set<string>>(new Set());
  

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

  function runStream(q: string) {
    setIsLoading(true);
    setRows([]);
    seenKeysRef.current.clear();
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
      params.set("forceBrowserFirst", "true");
      params.set("headless", "true");
      params.set("pageTimeoutMs", "15000");
      params.set("pageJitterMinMs", "1200");
      params.set("pageJitterMaxMs", "3000");
      params.set("maxRetriesPerPage", "1");
      params.set("fresh", "true");
      // Stream from orchestrator-backed endpoint
      const es = new EventSource(`/api/orchestrator/stream?${params.toString()}`);
      esRef.current = es;
      setCurrentTerm(q);
      setStatus("Scraping…");
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "status" && msg.message === "city_start") {
            setCurrentCity(String(msg.city || ""));
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
            setRows((prev) => [{ name: displayName, website: origin || rawWebsite || "", city: (msg.city || msg.location || ""), query: msg.query || "", source: (msg.source || msg.method || "") }, ...prev]);
            if (typeof msg.location === "string" && msg.location) setCurrentCity(msg.location);
            // Update status with data source when streaming rows
            if (typeof msg.source === "string") setStatus(`Source: ${msg.source}`);
          } else if (msg.type === "searching") {
            const dir = (msg.directory || "").toString();
            const ang = (msg.angle || "").toString();
            setCurrentTerm(ang || q);
            setStatus(dir ? `Scraping ${dir}…` : "Scraping…");
          } else if (msg.type === "status" && typeof msg.message === "string") {
            setStatus(msg.message);
          }
        } catch {}
      };
      es.addEventListener("done", () => {
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
        {status && (
          <p className="text-xs text-gray-600 inline-flex items-center gap-2">
            <svg className="animate-spin h-3 w-3 text-blue-600" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0"></path></svg>
            {status}
          </p>
        )}
        {/* planning UI removed */}
      </div>

      

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
                    <td className="p-6 text-gray-500 text-center border" colSpan={2}>No results yet. Click Search to start.</td>
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
