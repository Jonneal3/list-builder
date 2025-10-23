// Snapshot export of all companies in the database to CSV (and optionally JSON)
// Usage (from repo root context): node industry-finder/src/export_snapshot.js

const path = require('path');
const fs = require('fs');
const { initDb, listCompanies } = require('./db/sqlite');
const { exportToCsv } = require('./exporter/csv');
const { exportToJson } = require('./exporter/json');

async function main() {
  const db = initDb();
  const rows = listCompanies(db);
  const isVercel = Boolean(process.env.VERCEL);
  const outDir = isVercel ? '/tmp/exports' : path.join(__dirname, '../exports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const base = `${stamp}_snapshot_all-rows`;
  const csvPath = path.join(outDir, `${base}.csv`);
  exportToCsv(rows, csvPath);
  const jsonPath = path.join(outDir, `${base}.json`);
  exportToJson(rows, jsonPath);
  try { process.stdout.write(JSON.stringify({ ok: true, rows: rows.length, csv: csvPath, json: jsonPath }) + '\n'); } catch {}
}

if (require.main === module) {
  main().catch((e) => { try { process.stdout.write(JSON.stringify({ ok: false, error: String(e && (e.message || e)) }) + '\n'); } catch {} process.exit(1); });
}


