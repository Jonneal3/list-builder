const fs = require('fs');
const path = require('path');

function getLogFilePath() {
  const logsDir = path.join(__dirname, '../../logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  return path.join(logsDir, `${date}.log`);
}

function createLogger(verbose = false) {
  const filePath = getLogFilePath();

  function write(level, msg) {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    try { fs.appendFileSync(filePath, line); } catch (_) {}
    if (verbose || level !== 'INFO') {
      const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
      fn(line.trim());
    }
  }

  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
  };
}

module.exports = { createLogger };


