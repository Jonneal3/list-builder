import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function sse(obj: any, evt?: string) {
  const enc = new TextEncoder();
  const head = evt ? `event: ${evt}\n` : "";
  return enc.encode(head + "data: " + JSON.stringify(obj) + "\n\n");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const industry = (searchParams.get("industry") || "").trim();
  const cityParam = (searchParams.get("city") || "").trim();
  const apolloLimit = Math.max(1, Number(searchParams.get("apolloLimit") || "50"));
  const apolloPerPage = Math.max(1, Number(searchParams.get("apolloPerPage") || "25"));
  const apolloMaxPagesPerBucket = Math.max(1, Number(searchParams.get("apolloMaxPagesPerBucket") || "5"));
  const apolloBucketsParam = (searchParams.get("apolloBuckets") || "").trim();
  const apolloCookieHeader = (searchParams.get("apolloCookieHeader") || "").trim();
  const apolloLogin = String(searchParams.get("apolloLogin") || "false").toLowerCase() === "true";
  const apolloManualLogin = String(searchParams.get("apolloManualLogin") || "false").toLowerCase() === "true";
  const apolloEmail = (searchParams.get("apolloEmail") || "").trim();
  const apolloPassword = (searchParams.get("apolloPassword") || "").trim();
  const apolloListUrl = (searchParams.get("apolloListUrl") || "").trim();
  const uiPages = Math.max(1, Number(searchParams.get("uiPages") || "5"));
  const headless = String(searchParams.get("headless") || "true").toLowerCase() !== "false";
  const pageTimeoutMs = Math.max(5000, Number(searchParams.get("pageTimeoutMs") || "15000"));
  const puppeteerProxy = (searchParams.get("puppeteerProxy") || "").trim() || undefined;
  const puppeteerProxyUser = (searchParams.get("puppeteerProxyUser") || "").trim() || undefined;
  const puppeteerProxyPass = (searchParams.get("puppeteerProxyPass") || "").trim() || undefined;
  const rotateViewport = String(searchParams.get("rotateViewport") || "false").toLowerCase() === "true";
  const allCitiesParam = String(searchParams.get("allCities") || "false").toLowerCase() === "true";
  const useAllCities = allCitiesParam || !cityParam;
  const fresh = String(searchParams.get("fresh") || "false").toLowerCase() === "true";

  const apolloBuckets = (() => {
    if (!apolloBucketsParam) return undefined;
    try { const p = JSON.parse(apolloBucketsParam); return Array.isArray(p) ? apolloBucketsParam : undefined; } catch { return undefined; }
  })();

  if (!industry) {
    return new Response("Missing industry", { status: 400 });
  }

  // Resolve orchestrator.js relative to repo root (frontend/..)
  const repoRoot = path.resolve(process.cwd(), "..");
  const scriptPath = path.join(repoRoot, "industry-finder", "src", "orchestrator.js");

  let childRef: import("child_process").ChildProcess | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const enqueue = (chunk: Uint8Array) => { try { controller.enqueue(chunk); } catch {} };
      enqueue(enc.encode("event: ping\n\n"));

      const args = [
        scriptPath,
        `--industry=${industry}`,
        // Only pass a specific city when not running all-cities mode
        ...(useAllCities ? [] : [`--city=${cityParam || 'New York'}`]),
        `--enableApollo=true`,
        `--onlyApollo=true`,
        `--apolloLimit=${String(apolloLimit)}`,
        `--apolloPerPage=${String(apolloPerPage)}`,
        `--apolloMaxPagesPerBucket=${String(apolloMaxPagesPerBucket)}`,
        ...(apolloBuckets ? [`--apolloBuckets=${apolloBuckets}`] : []),
        ...(apolloCookieHeader ? [`--apolloCookieHeader=${apolloCookieHeader}`] : []),
        ...(apolloLogin ? [`--apolloLogin=true`] : []),
        ...(apolloManualLogin ? [`--apolloManualLogin=true`] : []),
        ...(apolloEmail ? [`--apolloEmail=${apolloEmail}`] : []),
        ...(apolloPassword ? [`--apolloPassword=${apolloPassword}`] : []),
        ...(apolloListUrl ? [`--apolloListUrl=${apolloListUrl}`] : []),
        ...(uiPages ? [`--uiPages=${String(uiPages)}`] : []),
        `--headless=${headless ? 'true' : 'false'}`,
        `--pageTimeoutMs=${String(pageTimeoutMs)}`,
        `--rotateViewport=${rotateViewport ? 'true' : 'false'}`,
        ...(puppeteerProxy ? [`--puppeteerProxy=${puppeteerProxy}`] : []),
        ...(puppeteerProxyUser ? [`--puppeteerProxyUser=${puppeteerProxyUser}`] : []),
        ...(puppeteerProxyPass ? [`--puppeteerProxyPass=${puppeteerProxyPass}`] : []),
        // Disable YellowPages and Google Maps for Apollo-only runs
        `--enableGmaps=false`,
        `--onlyGmaps=false`,
        ...(useAllCities ? ["--allCities=true"] : []),
        ...(fresh ? ["--fresh=true"] : []),
        "--stream",
        "--verbose=false",
      ];

      const child = spawn("node", args, { cwd: repoRoot, env: { ...process.env,
        PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '',
        IF_DB_PATH: process.env.IF_DB_PATH || "/tmp/industry-finder.sqlite",
      } });
      childRef = child;

      let buf = "";
      child.stdout.on("data", (data: Buffer) => {
        buf += data.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            // Ensure categories field is parsed as array if it's a JSON string
            if (obj && typeof obj.categories === 'string') {
              try { obj.categories = JSON.parse(obj.categories); } catch {}
            }
            enqueue(sse(obj));
          } catch {
            enqueue(sse({ type: "log", message: line }));
          }
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        const msg = data.toString();
        enqueue(sse({ type: "stderr", message: msg }));
      });
      child.on("close", (code: number | null) => {
        enqueue(sse({ type: "done", code }, "done"));
        try { controller.close(); } catch {}
      });
      child.on("error", (err) => {
        enqueue(sse({ type: "error", message: String(err?.message || err) }));
        enqueue(enc.encode("event: done\n\n"));
        try { controller.close(); } catch {}
      });
    },
    async cancel() {
      // Kill the spawned orchestrator when client disconnects (Stop button closes EventSource)
      try {
        if (childRef && !childRef.killed) {
          try { childRef.kill('SIGTERM'); } catch {}
          // Force kill after a short grace period
          await new Promise(res => setTimeout(res, 1200));
          try { if (childRef && !childRef.killed) childRef.kill('SIGKILL'); } catch {}
        }
      } catch {}
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