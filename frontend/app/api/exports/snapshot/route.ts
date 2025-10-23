import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(_req: NextRequest) {
  const repoRoot = path.resolve(process.cwd(), "..");
  const scriptPath = path.join(repoRoot, "industry-finder", "src", "export_snapshot.js");
  return new Promise<Response>((resolve) => {
    const child = spawn("node", [scriptPath], { cwd: repoRoot, env: { ...process.env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("close", () => {
      try {
        const lastLine = out.trim().split(/\n/).pop() || "{}";
        const json = JSON.parse(lastLine);
        resolve(new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
      } catch {
        resolve(new Response(JSON.stringify({ ok: false, error: err || "snapshot_failed" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      }
    });
  });
}


