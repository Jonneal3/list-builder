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
      const exportsDir = isVercel ? "/tmp/exports" : path.join(repoRoot, "backend", "exports");
    // Read jobs if available
    let jobs: any[] = [];
    try {
      const jf = path.join(exportsDir, 'jobs.json');
      const txt = fs.readFileSync(jf, 'utf8');
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) jobs = arr.slice(0, 50);
    } catch {}
    let entries: Array<{ name: string; size: number; mtimeMs: number; href: string; ext: string; rows?: number }> = [];
    try {
      const names = fs.readdirSync(exportsDir);
      for (const name of names) {
        // Hide internal jobs tracker from exports list
        if (name === 'jobs.json') continue;
        const full = path.join(exportsDir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          const ext = path.extname(name).toLowerCase().replace(/^\./, "");
          const entry: { name: string; size: number; mtimeMs: number; href: string; ext: string; rows?: number } = {
            name,
            size: st.size,
            mtimeMs: st.mtimeMs,
            href: `/api/exports/get?name=${encodeURIComponent(name)}`,
            ext,
          };
          // Best-effort row count for CSV/JSON (skip very large files)
          try {
            if (st.size <= 50 * 1024 * 1024) {
              if (ext === 'csv') {
                const data = fs.readFileSync(full, 'utf8');
                const lines = data.split(/\r?\n/);
                const count = Math.max(0, lines.length - 1); // minus header
                entry.rows = count;
              } else if (ext === 'json') {
                const data = fs.readFileSync(full, 'utf8');
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) entry.rows = parsed.length;
              }
            }
          } catch {}
          entries.push(entry);
        } catch {}
      }
    } catch {}
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    entries = entries.slice(0, 50);
    return new Response(JSON.stringify({ files: entries, jobs }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}


