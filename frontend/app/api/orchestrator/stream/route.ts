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

  if (!industry) {
    return new Response("Missing industry", { status: 400 });
  }

  // Resolve orchestrator.js relative to repo root (frontend/..)
  const repoRoot = path.resolve(process.cwd(), "..");
  const scriptPath = path.join(repoRoot, "industry-finder", "src", "orchestrator.js");

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
        // enforce sequential pages per city when exhausting
        ...(exhaustCity ? ["--ypConcurrency=1"] : []),
        "--stream",
        "--verbose=false",
      ];
      if (useAllCities) args.push("--allCities=true");
      if (fresh) args.push("--fresh=true");

      const child = spawn("node", args, { cwd: repoRoot, env: { ...process.env,
        PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '',
        IF_DB_PATH: process.env.IF_DB_PATH || "/tmp/industry-finder.sqlite",
      } });

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
    cancel() {},
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


