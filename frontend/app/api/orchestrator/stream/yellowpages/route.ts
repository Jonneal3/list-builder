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
  const queries = Math.max(1, Number(searchParams.get("queries") || "3"));
  const pages = Math.max(1, Number(searchParams.get("pages") || "1"));
  const ypPagesParam = (searchParams.get("ypPages") || "-1").trim();
  const ypPagesNum = Number(ypPagesParam);
  const ypPages = ypPagesParam === "-1" || ypPagesNum === -1 ? -1 : Math.max(1, ypPagesNum || 1);
  const browserFallback = String(searchParams.get("browserFallback") || "true").toLowerCase() === "true";
  const pageTimeoutMs = Math.max(5000, Number(searchParams.get("pageTimeoutMs") || "15000"));
  const puppeteerProxy = (searchParams.get("puppeteerProxy") || "").trim() || undefined;
  const puppeteerProxyUser = (searchParams.get("puppeteerProxyUser") || "").trim() || undefined;
  const puppeteerProxyPass = (searchParams.get("puppeteerProxyPass") || "").trim() || undefined;
  const headless = String(searchParams.get("headless") || "true").toLowerCase() !== "false";
  const maxRetriesPerPage = Math.max(1, Number(searchParams.get("maxRetriesPerPage") || "2"));
  const useFreeProxies = String(searchParams.get("useFreeProxies") || "false").toLowerCase() === "true";
  const proxyCountry = (searchParams.get("proxyCountry") || "").trim();
  const proxyTypes = (searchParams.get("proxyTypes") || "http,https").trim();
  const proxyLimit = Math.max(1, Number(searchParams.get("proxyLimit") || "10"));
  const fresh = String(searchParams.get("fresh") || "false").toLowerCase() === "true";
  const autoMaxPagesYp = Math.max(1, Number(searchParams.get("autoMaxPagesYp") || "80"));
  const forceBrowserFirst = String(searchParams.get("forceBrowserFirst") || "false").toLowerCase() === "true";
  const pageJitterMinMs = Math.max(0, Number(searchParams.get("pageJitterMinMs") || "800"));
  const pageJitterMaxMs = Math.max(pageJitterMinMs, Number(searchParams.get("pageJitterMaxMs") || "2000"));
  const rotateViewport = String(searchParams.get("rotateViewport") || "false").toLowerCase() === "true";
  const allCitiesParam = String(searchParams.get("allCities") || "false").toLowerCase() === "true";
  const exhaustCity = String(searchParams.get("exhaustCity") || "false").toLowerCase() === "true";
  const useAllCities = allCitiesParam || !cityParam;
  const enableGmaps = String(searchParams.get("enableGmaps") || "true").toLowerCase() === "true";
  const gmapsLimit = Math.max(1, Number(searchParams.get("gmapsLimit") || "25"));
  const gmapsDetailClicks = Math.max(0, Number(searchParams.get("gmapsDetailClicks") || "5"));
  const onlyGmaps = String(searchParams.get("onlyGmaps") || "false").toLowerCase() === "true";
  const gmapsExhaust = String(searchParams.get("gmapsExhaust") || "false").toLowerCase() === "true";
  const gmapsMaxTotal = Math.max(gmapsLimit, Number(searchParams.get("gmapsMaxTotal") || "600"));
  const gmapsDetailAll = String(searchParams.get("gmapsDetailAll") || "false").toLowerCase() === "true";
  const isVercel = Boolean(process.env.VERCEL);
  const puppeteerPages = Math.max(1, Number(searchParams.get("puppeteerPages") || (isVercel ? "1" : "2")));

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
        `--queries=${String(queries)}`,
        `--pages=${String(pages)}`,
        `--ypPages=${String(ypPages)}`,
        `--browserFallback=${browserFallback ? "true" : "false"}`,
        `--pageTimeoutMs=${String(pageTimeoutMs)}`,
        `--autoMaxPagesYp=${String(autoMaxPagesYp)}`,
        `--useFreeProxies=${useFreeProxies ? 'true' : 'false'}`,
        `--proxyCountry=${proxyCountry}`,
        `--proxyTypes=${proxyTypes}`,
        `--proxyLimit=${String(proxyLimit)}`,
        `--forceBrowserFirst=${forceBrowserFirst ? 'true' : 'false'}`,
        `--pageJitterMinMs=${String(pageJitterMinMs)}`,
        `--pageJitterMaxMs=${String(pageJitterMaxMs)}`,
        `--rotateViewport=${rotateViewport ? 'true' : 'false'}`,
        `--exhaustCity=${exhaustCity ? 'true' : 'false'}`,
        `--enableGmaps=${enableGmaps ? 'true' : 'false'}`,
        `--gmapsLimit=${String(gmapsLimit)}`,
        `--gmapsDetailClicks=${String(gmapsDetailClicks)}`,
        `--gmapsExhaust=${gmapsExhaust ? 'true' : 'false'}`,
        `--gmapsMaxTotal=${String(gmapsMaxTotal)}`,
        `--gmapsDetailAll=${gmapsDetailAll ? 'true' : 'false'}`,
        `--onlyGmaps=${onlyGmaps ? 'true' : 'false'}`,
        `--puppeteerPages=${String(puppeteerPages)}`,
        `--headless=${headless ? 'true' : 'false'}`,
        // Disable Apollo for YellowPages-only runs
        `--enableApollo=false`,
        `--onlyApollo=false`,
        // enforce sequential pages per city when exhausting
        ...(exhaustCity ? ["--ypConcurrency=1"] : []),
        "--stream",
        "--verbose=false",
      ];
      if (isVercel) {
        // On Vercel, prefer conservative settings to avoid resource contention
        // Ensure single-page concurrency for Puppeteer and YP
        if (!args.some(a => a.startsWith('--ypConcurrency='))) args.push('--ypConcurrency=1');
        // Avoid forcing browser-first in serverless
        for (let i = 0; i < args.length; i++) {
          if (args[i].startsWith('--forceBrowserFirst=')) args[i] = '--forceBrowserFirst=false';
        }
        // Cap auto pages for YP unless explicitly set by query
        const hasAuto = args.some(a => a.startsWith('--autoMaxPagesYp='));
        if (!hasAuto) args.push('--autoMaxPagesYp=12');
      }
      if (useAllCities) args.push("--allCities=true");
      if (fresh) args.push("--fresh=true");

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