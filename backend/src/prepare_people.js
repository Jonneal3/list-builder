// Accepts CSV text via stdin and a header name via --orgCol
// Extracts Apollo org IDs from that column and writes to backend/data/people_tokens/<token>.json
// Prints { token, orgIds } on stdout

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const minimist = require('minimist');

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQ = false;
  const pushF = () => { row.push(field); field = ''; };
  const pushR = () => { rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { const n = text[i+1]; if (n === '"') { field += '"'; i++; } else { inQ = false; } }
      else { field += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') pushF();
      else if (c === '\n') { pushF(); pushR(); }
      else if (c === '\r') { const n = text[i+1]; if (n === '\n') i++; pushF(); pushR(); }
      else field += c;
    }
  }
  if (field.length || row.length) { pushF(); pushR(); }
  const compact = rows.filter(r => r.some(cell => String(cell||'').trim() !== ''));
  if (!compact.length) return { headers: [], records: [] };
  const headers = compact[0].map(h => String(h||'').trim());
  const records = compact.slice(1).map(r => {
    const rec = {}; for (let i=0;i<headers.length;i++) rec[headers[i]] = String(r[i] ?? ''); return rec;
  });
  return { headers, records };
}

function extractApolloOrgId(u) {
  try {
    const abs = u.startsWith('http') ? u : `https://app.apollo.io/${u.replace(/^#\/?/, '')}`;
    const url = new URL(abs);
    const idx = url.pathname.indexOf('/organizations/');
    if (idx !== -1) {
      const rest = url.pathname.slice(idx + '/organizations/'.length);
      const id = rest.split(/[/?#]/)[0];
      return id || '';
    }
    const hash = url.hash || '';
    const m = hash.match(/organizations\/([^\/?#]+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

(async () => {
  const argv = minimist(process.argv.slice(2));
  const orgCol = String(argv.orgCol || '').trim();
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => input += d);
  process.stdin.on('end', () => {
    const { headers, records } = parseCsv(input || '');
    if (!headers.length) { console.log(JSON.stringify({ error: 'no_headers' })); return; }
    const col = orgCol || headers[0];
    const ids = [];
    const seen = new Set();
    for (const r of records) {
      const v = String(r[col] || '').trim();
      const id = extractApolloOrgId(v);
      if (id && !seen.has(id)) { ids.push(id); seen.add(id); }
    }
    const token = crypto.randomBytes(8).toString('hex');
    const repoRoot = path.resolve(process.cwd(), '..');
    const dir = path.join(repoRoot, 'backend', 'data', 'people_tokens');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    // Store original row data mapped by org ID for preserving all original information
    const orgIdToOriginalRow = {};
    for (const r of records) {
      const v = String(r[col] || '').trim();
      const id = extractApolloOrgId(v);
      if (id && !orgIdToOriginalRow[id]) {
        orgIdToOriginalRow[id] = r; // Store the entire original row
      }
    }
    
    const out = { 
      orgIds: ids, 
      orgCol: col, 
      originalRows: orgIdToOriginalRow,
      headers: headers
    };
    fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify(out));
    console.log(JSON.stringify({ token, orgIds: ids.length }));
  });
})();


