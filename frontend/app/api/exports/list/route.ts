import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_req: NextRequest) {
  try {
    const isVercel = Boolean(process.env.VERCEL);
    const repoRoot = path.resolve(process.cwd(), "..");
    const exportsDir = isVercel ? "/tmp/exports" : path.join(repoRoot, "industry-finder", "exports");
    let entries: Array<{ name: string; size: number; mtimeMs: number; href: string; ext: string }> = [];
    try {
      const names = fs.readdirSync(exportsDir);
      for (const name of names) {
        const full = path.join(exportsDir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          const ext = path.extname(name).toLowerCase().replace(/^\./, "");
          entries.push({ name, size: st.size, mtimeMs: st.mtimeMs, href: `/api/exports/get?name=${encodeURIComponent(name)}`, ext });
        } catch {}
      }
    } catch {}
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    entries = entries.slice(0, 50);
    return new Response(JSON.stringify({ files: entries }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}


