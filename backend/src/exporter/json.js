const fs = require('fs');
const path = require('path');

function exportToJson(rows, outPath) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  return outPath;
}

module.exports = { exportToJson };


