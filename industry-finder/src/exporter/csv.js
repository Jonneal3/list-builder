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
    'id','name','website','normalized_domain','industry','location','size_category','source_list','method','fallback_used','first_seen','last_seen',
    'phone','address','address_street','address_city','address_state','address_postal_code','rating','reviews_count','categories','yp_listing_url','hours_text','email'
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
      toCsvValue(r.phone),
      toCsvValue(r.address),
      toCsvValue(r.address_street),
      toCsvValue(r.address_city),
      toCsvValue(r.address_state),
      toCsvValue(r.address_postal_code),
      toCsvValue(r.rating),
      toCsvValue(r.reviews_count),
      toCsvValue(Array.isArray(r.categories) ? r.categories.join('; ') : r.categories),
      toCsvValue(r.yp_listing_url),
      toCsvValue(r.hours_text),
      toCsvValue(r.email),
    ].join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'));
  return outPath;
}

module.exports = { exportToCsv };


