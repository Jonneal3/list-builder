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
  // Expect orgIds JSON array, optional email/password, headless flag
  const orgIdsParam = (searchParams.get("orgIds") || "").trim();
  const apolloEmail = (searchParams.get("apolloEmail") || "").trim();
  const apolloPassword = (searchParams.get("apolloPassword") || "").trim();
  const headless = String(searchParams.get("headless") || "true").toLowerCase() !== "false";
  const pageTimeoutMs = Math.max(5000, Number(searchParams.get("pageTimeoutMs") || "15000"));

  const repoRoot = path.resolve(process.cwd(), "..");
  const scriptPath = path.join(repoRoot, "backend", "src", "apollo_contacts.js");

  let childRef: import("child_process").ChildProcess | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const enqueue = (chunk: Uint8Array) => { try { controller.enqueue(chunk); } catch {} };
      enqueue(enc.encode("event: ping\n\n"));

      const args = [
        scriptPath,
        ...(orgIdsParam ? ["--orgIds=" + orgIdsParam] : []),
        `--headless=${headless ? 'true' : 'false'}`,
        `--pageTimeoutMs=${String(pageTimeoutMs)}`,
        ...(apolloEmail ? ["--apolloEmail=" + apolloEmail] : []),
        ...(apolloPassword ? ["--apolloPassword=" + apolloPassword] : []),
      ];

      const child = spawn("node", args, { cwd: repoRoot, env: { ...process.env } });
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


