import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const name = (searchParams.get("name") || "").trim();
  if (!name || name.includes("/") || name.includes("..")) {
    return new Response("Bad name", { status: 400 });
  }
  const repoRoot = path.resolve(process.cwd(), "..");
  const exportsDir = path.join(repoRoot, "industry-finder", "exports");
  const full = path.join(exportsDir, name);
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return new Response("Not found", { status: 404 });
    const ext = path.extname(name).toLowerCase();
    const type = ext === ".csv" ? "text/csv; charset=utf-8" : ext === ".json" ? "application/json" : "application/octet-stream";
    const data = fs.readFileSync(full);
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}


