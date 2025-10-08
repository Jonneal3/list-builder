const fs = require('fs');
const path = require('path');

function toCsvValue(value) {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function exportToCsv(rows, outPath) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const headers = [
    'id','name','website','normalized_domain','industry','location','size_category','source_list','method','fallback_used','first_seen','last_seen'
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.id,
      toCsvValue(r.name),
      toCsvValue(r.website),
      toCsvValue(r.normalized_domain),
      toCsvValue(r.industry),
      toCsvValue(r.location),
      toCsvValue(r.size_category),
      toCsvValue(r.source_list),
      toCsvValue(r.method || ''),
      toCsvValue(r.fallback_used == null ? '' : String(r.fallback_used)),
      toCsvValue(r.first_seen),
      toCsvValue(r.last_seen),
    ].join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'));
  return outPath;
}

module.exports = { exportToCsv };


