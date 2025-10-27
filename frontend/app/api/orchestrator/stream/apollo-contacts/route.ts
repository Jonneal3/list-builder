import { NextRequest } from "next/server";
import fs from "fs";
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
  // Expect orgIds JSON array, optional email/password, headless flag
  let orgIdsParam = (searchParams.get("orgIds") || "").trim();
  const token = (searchParams.get("token") || "").trim();
  const apolloEmail = (searchParams.get("apolloEmail") || "").trim();
  const apolloPassword = (searchParams.get("apolloPassword") || "").trim();
  const headless = String(searchParams.get("headless") || "true").toLowerCase() !== "false";
  const pageTimeoutMs = Math.max(5000, Number(searchParams.get("pageTimeoutMs") || "15000"));
  const pages = Math.max(1, Number(searchParams.get("pages") || "1"));
  const seniorities = (searchParams.get("seniorities") || "").trim();
  const sortByField = (searchParams.get("sortByField") || "recommendations_score").trim();
  const sortAscending = String(searchParams.get("sortAscending") || "false").toLowerCase() === 'true';

  const repoRoot = path.resolve(process.cwd(), "..");
  const scriptPath = path.join(repoRoot, "backend", "src", "apollo_contacts.js");

  let childRef: import("child_process").ChildProcess | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const enqueue = (chunk: Uint8Array) => { try { controller.enqueue(chunk); } catch {} };
      enqueue(enc.encode("event: ping\n\n"));

      // Resolve orgIds from token if provided
      let orgIdsArg = orgIdsParam;
      let tokenArg = token;
      if (tokenArg) {
        try {
          const repoRoot = path.resolve(process.cwd(), "..");
          const tokenFile = path.join(repoRoot, "backend", "data", "people_tokens", `${token}.json`);
          const txt = fs.readFileSync(tokenFile, "utf8");
          const json = JSON.parse(txt);
          if (Array.isArray(json.orgIds)) orgIdsArg = JSON.stringify(json.orgIds);
        } catch {}
      }
      // If still missing, surface an error row to the client
      if (!orgIdsArg && !tokenArg) {
        enqueue(sse({ type: 'error', message: 'no_org_ids' }));
      }
      // Emit a status event to confirm launch args
      try {
        const parsed = JSON.parse(orgIdsArg || '[]');
        enqueue(sse({ type: 'status', message: 'contacts_start', orgIds: parsed.length, headless, pages, sortByField, sortAscending, seniorities: seniorities ? JSON.parse(seniorities) : [] }));
      } catch {
        enqueue(sse({ type: 'status', message: 'contacts_start', orgIds: 0, headless, pages, sortByField, sortAscending }));
      }
      // If orgIdsArg is huge, write a temp token file here to pass to child
      try {
        const parsed = JSON.parse(orgIdsArg || '[]');
        if (Array.isArray(parsed) && parsed.length > 50) {
          const tokenTmp = Math.random().toString(36).slice(2, 12);
          const repoRoot = path.resolve(process.cwd(), "..");
          const dir = path.join(repoRoot, "backend", "data", "people_tokens");
          try { require('fs').mkdirSync(dir, { recursive: true }); } catch {}
          require('fs').writeFileSync(path.join(dir, `${tokenTmp}.json`), JSON.stringify({ orgIds: parsed }));
          orgIdsArg = '';
          tokenArg = tokenTmp;
        }
      } catch {}
      const args = [
        scriptPath,
        ...(orgIdsArg ? ["--orgIds=" + orgIdsArg] : []),
        ...(tokenArg ? ["--token=" + tokenArg] : []),
        `--headless=${headless ? 'true' : 'false'}`,
        `--pageTimeoutMs=${String(pageTimeoutMs)}`,
        `--pages=${String(pages)}`,
        ...(seniorities ? ["--seniorities=" + seniorities] : []),
        `--sortByField=${sortByField}`,
        `--sortAscending=${sortAscending ? 'true' : 'false'}`,
        ...(apolloEmail ? ["--apolloEmail=" + apolloEmail] : []),
        ...(apolloPassword ? ["--apolloPassword=" + apolloPassword] : []),
      ];

      // Ensure Puppeteer has a browser path/cache like other routes
      const puppeteerCacheDir = path.join(repoRoot, "backend", ".puppeteer");
      const defaultChrome = process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : (process.platform === "linux" ? "/usr/bin/google-chrome" : "");
      // Ensure data dir for cookies exists
      try { fs.mkdirSync(path.join(repoRoot, "backend", "data"), { recursive: true }); } catch {}
      const apolloCookiesPath = path.join(repoRoot, "backend", "data", "apollo_cookies.json");
      const userDataDir = path.join(repoRoot, "backend", ".puppeteer_profile");
      const child = spawn("node", args, { cwd: repoRoot, env: { ...process.env,
        PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR || puppeteerCacheDir,
        PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || defaultChrome,
        PUPPETEER_USER_DATA_DIR: process.env.PUPPETEER_USER_DATA_DIR || userDataDir,
        APOLLO_COOKIES_JSON: process.env.APOLLO_COOKIES_JSON || apolloCookiesPath,
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
            if (obj && obj.type === 'person') {
              enqueue(sse(obj, 'person'));
            } else {
              enqueue(sse(obj));
            }
          } catch {
            enqueue(sse({ type: "log", message: line }));
          }
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        enqueue(sse({ type: "stderr", message: data.toString() }));
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
      try {
        if (childRef && !childRef.killed) {
          try { childRef.kill('SIGTERM'); } catch {}
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


