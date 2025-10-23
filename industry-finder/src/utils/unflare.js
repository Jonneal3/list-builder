const fetchImpl = (typeof fetch === 'function') ? fetch : require('node-fetch');

async function requestUnflare({ url, timeout, proxy, apiUrl, apiKey }) {
  const endpoint = String(apiUrl || process.env.UNFLARE_URL || '').replace(/\/$/, '') + '/scrape';
  if (!endpoint) throw new Error('UNFLARE_URL not set');
  const body = { url, timeout: Math.max(15000, Number(timeout || 60000)), method: 'GET' };
  if (proxy && proxy.host && proxy.port) {
    body.proxy = { host: String(proxy.host), port: Number(proxy.port) };
    if (proxy.username && proxy.password) { body.proxy.username = String(proxy.username); body.proxy.password = String(proxy.password); }
  }
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${String(apiKey)}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code === 'error') {
    const msg = (json && json.message) ? json.message : `HTTP ${res.status}`;
    throw new Error(`Unflare error: ${msg}`);
  }
  return json;
}

module.exports = { requestUnflare };


