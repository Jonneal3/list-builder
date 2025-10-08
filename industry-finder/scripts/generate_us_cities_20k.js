const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Minimal FIPS state code to USPS abbreviation mapping
const STATE_FIPS_TO_ABBR = {
  '01': 'AL','02': 'AK','04': 'AZ','05': 'AR','06': 'CA','08': 'CO','09': 'CT','10': 'DE','11': 'DC','12': 'FL',
  '13': 'GA','15': 'HI','16': 'ID','17': 'IL','18': 'IN','19': 'IA','20': 'KS','21': 'KY','22': 'LA','23': 'ME',
  '24': 'MD','25': 'MA','26': 'MI','27': 'MN','28': 'MS','29': 'MO','30': 'MT','31': 'NE','32': 'NV','33': 'NH',
  '34': 'NJ','35': 'NM','36': 'NY','37': 'NC','38': 'ND','39': 'OH','40': 'OK','41': 'OR','42': 'PA','44': 'RI',
  '45': 'SC','46': 'SD','47': 'TN','48': 'TX','49': 'UT','50': 'VT','51': 'VA','53': 'WA','54': 'WV','55': 'WI','56': 'WY',
  '72': 'PR'
};

function cleanPlaceName(name) {
  // NAME looks like "Springfield city, Illinois" or "Someplace CDP, State"
  let base = name.split(',')[0].trim();
  base = base.replace(/\b(city|town|village|borough|cdp|municipality|balance)\b$/i, '').trim();
  // collapse spaces
  base = base.replace(/\s+/g, ' ');
  return base;
}

async function main() {
  const url = 'https://api.census.gov/data/2023/acs/acs1?get=NAME,B01003_001E&for=place:*&in=state:*';
  const outPath = path.join(__dirname, '../config/us_cities_20k.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const res = await axios.get(url, { timeout: 120000 });
  const rows = res.data; // [ [headers...], [NAME, POP, state, place], ... ]
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('Unexpected Census response');
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const [name, popStr, stateFips] = rows[i];
    const pop = Number(popStr);
    if (!Number.isFinite(pop) || pop < 20000) continue;
    const abbr = STATE_FIPS_TO_ABBR[String(stateFips).padStart(2, '0')];
    if (!abbr) continue;
    const cityName = cleanPlaceName(String(name));
    if (!cityName) continue;
    out.push(`${cityName}, ${abbr}`);
  }
  // de-dupe + sort
  const unique = Array.from(new Set(out)).sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(outPath, JSON.stringify(unique, null, 2));
  console.log(`Wrote ${unique.length} cities to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


