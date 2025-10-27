import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: NextRequest) {
  try {
    const repoRoot = path.resolve(process.cwd(), "..");
    const scriptPath = path.join(repoRoot, "backend", "src", "prepare_people.js");
    const body = await req.text();
    const orgCol = (new URL(req.url).searchParams.get('orgCol') || '').trim();
    return await new Promise<Response>((resolve) => {
      const args = [scriptPath, ...(orgCol ? ["--orgCol=" + orgCol] : [])];
      const child = spawn("node", args, { cwd: repoRoot, env: { ...process.env } });
      let out = ""; let err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("close", () => {
        try { const json = JSON.parse(out.trim() || '{}'); resolve(new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
        catch { resolve(new Response(JSON.stringify({ ok:false, error: err || 'prepare_failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } })); }
      });
      child.stdin.write(body || '');
      child.stdin.end();
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok:false, error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}


