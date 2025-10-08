const axios = require('axios');
const fs = require('fs');
const path = require('path');

const userAgentsPath = path.join(__dirname, 'userAgents.json');
let userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
try {
  if (fs.existsSync(userAgentsPath)) {
    userAgents = JSON.parse(fs.readFileSync(userAgentsPath, 'utf8'));
  }
} catch (_) {}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function politeGet(url, opts = {}) {
  const minDelayMs = Number.isFinite(opts.minDelayMs) ? Math.max(0, Number(opts.minDelayMs)) : 300;
  const maxDelayMs = Number.isFinite(opts.maxDelayMs) ? Math.max(minDelayMs, Number(opts.maxDelayMs)) : 700;
  const timeout = opts.timeout || 15000;
  const maxAttempts = Math.max(1, Number(opts.retries || 2)) + 1;
  const proxyList = Array.isArray(opts.proxyList) ? opts.proxyList.filter(Boolean) : [];
  const rotateProxies = Boolean(opts.rotateProxies);
  const baseHeaders = opts.headers || {};
  const urlObj = new URL(url);
  const onDebug = typeof opts.onDebug === 'function' ? opts.onDebug : null;
  let lastErr = null;
  let backoffMs = Number.isFinite(opts.initialBackoffMs) ? Math.max(0, Number(opts.initialBackoffMs)) : 500;
  function maskProxy(u) {
    try {
      const x = new URL(String(u));
      const proto = x.protocol.replace(':','');
      const host = x.hostname;
      const port = x.port || (x.protocol === 'https:' ? '443' : '80');
      return `${proto}://${host}:${port}`;
    } catch { return String(u || ''); }
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(randomBetween(minDelayMs, maxDelayMs));
    try {
      const headers = Object.assign({
        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      }, baseHeaders);
      // Determine proxy for this attempt
      let axiosProxy = false;
      let selectedProxyUrl = null;
      if (opts.proxyUrl) {
        selectedProxyUrl = opts.proxyUrl;
        axiosProxy = parseAxiosProxy(opts.proxyUrl);
      } else if (proxyList.length > 0) {
        const idx = rotateProxies ? ((attempt - 1) % proxyList.length) : 0;
        selectedProxyUrl = proxyList[idx];
        axiosProxy = parseAxiosProxy(proxyList[idx]);
      }
      if (onDebug) {
        try { onDebug({ event: 'proxy_attempt', attempt, targetHost: urlObj.host, proxy: selectedProxyUrl ? maskProxy(selectedProxyUrl) : null }); } catch {}
      }
      const config = {
        headers,
        timeout,
        maxRedirects: 5,
        validateStatus: s => s >= 200 && s < 400,
        decompress: true,
      };
      if (axiosProxy) {
        config.proxy = axiosProxy;
      }
      const response = await axios.get(url, config);
      if (onDebug) {
        try { onDebug({ event: 'proxy_ok', attempt, targetHost: urlObj.host, status: response.status, proxy: selectedProxyUrl ? maskProxy(selectedProxyUrl) : null }); } catch {}
      }
      return response;
    } catch (err) {
      lastErr = err;
      const status = err && err.response && err.response.status;
      if (onDebug) {
        try { onDebug({ event: 'proxy_error', attempt, targetHost: urlObj.host, status: status || null, error: String(err && (err.message || err)), proxy: (opts.proxyUrl || (proxyList.length ? proxyList[(attempt - 1) % proxyList.length] : null)) ? maskProxy(opts.proxyUrl || proxyList[(attempt - 1) % proxyList.length]) : null }); } catch {}
      }
      if (status === 429) {
        // exponential backoff and possibly rotate proxy
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 8000);
        continue;
      }
      if (status === 403) {
        // brief backoff and retry (rotate proxy if provided)
        await sleep(randomBetween(800, 1600));
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error('Request failed');
}

function parseAxiosProxy(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const auth = (u.username || u.password) ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined;
    return { host, port, protocol: u.protocol.replace(':',''), auth };
  } catch {
    return false;
  }
}

module.exports = {
  politeGet,
  sleep,
  randomBetween,
};


