/**
 * Vercel Serverless Function — /api/qr
 *
 * Tumhare bot panel (http://IP:PORT/api/qr) ke upar ek PROXY.
 *   my-project.vercel.app/api/qr            -> naya QR (redirect -> /api/qr?id=...)
 *   my-project.vercel.app/api/qr?id=XXXX    -> us QR job ki current PNG image
 *   (PNG default = 1:1 cut + transparent background)
 *   my-project.vercel.app/api/qr?bg=white   -> safed background + padding
 *
 * Kyu proxy: Vercel/website HTTPS hoti hai aur panel HTTP — browser seedha
 * http:// API ko call karne se block kar deta hai (mixed content). Ye function
 * server-side se panel ko call karta hai, isliye website pe koi problem nahi.
 *
 * Panel ka address Vercel > Settings > Environment Variables me BACKEND_URL
 * se set hota hai (default neeche diya hai).
 */

const DEFAULT_BACKEND = 'http://45.13.226.96:9024';
const TIMEOUT_MS = 25000; // panel ko naya QR banane me ~10s tak lag sakta hai
const RETRIES = 1; // network hiccup par 1 baar dobara try

function backendBase() {
  return String(process.env.BACKEND_URL || DEFAULT_BACKEND).replace(/\/+$/, '');
}

// Sirf ye 2 cheezein panel tak jaati hain: QR id aur background mode.
function parseParams(source) {
  const rawId = source.get('id');
  const id = rawId && /^[a-zA-Z0-9_-]{4,64}$/.test(rawId) ? rawId : null;
  const t = String(source.get('transparent') || '').toLowerCase();
  const white = ['0', 'false', 'no'].includes(t); // default = transparent
  return { id, white };
}

// forBackend=true  -> panel ko jaane wali query (transparent default ON)
// forBackend=false -> Vercel URL ki query (default me sirf ?id=, bilkul panel jaisa)
function toQuery({ id, white }, forBackend) {
  const q = new URLSearchParams();
  if (id) q.set('id', id);
  if (forBackend) {
    if (!white) q.set('transparent', '1');
  } else if (white) {
    q.set('transparent', '0');
  }
  return q.toString();
}

async function callBackend(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, {
        redirect: 'manual', // redirect (naya QR id) hum khud Vercel URL pe bhejte hain
        headers: { 'User-Agent': 'vercel-qr-proxy', Accept: 'image/png,*/*' },
        signal: ctrl.signal,
      });
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 400));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = async function handler(req, res) {
  // CORS — apni website kisi bhi domain pe ho, fetch/img dono chalenge.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Refresh, Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }

  const incoming = new URL(req.url, 'http://localhost');
  const params = parseParams(incoming.searchParams);
  const qs = toQuery(params, true);
  const target = `${backendBase()}/api/qr${qs ? `?${qs}` : ''}`;

  try {
    const up = await callBackend(target);

    // Panel naya QR job bana ke redirect karta hai -> Vercel ke apne /api/qr?id=... pe bhejo.
    if ([301, 302, 303, 307, 308].includes(up.status)) {
      const loc = up.headers.get('location') || '';
      const nextId = parseParams(new URL(loc, backendBase() + '/').searchParams).id;
      const next = toQuery({ id: nextId, white: params.white }, false);
      res.statusCode = 302;
      res.setHeader('Location', `/api/qr${next ? `?${next}` : ''}`);
      return res.end();
    }

    const body = Buffer.from(await up.arrayBuffer());
    res.statusCode = up.status;
    const type = up.headers.get('content-type');
    if (type) res.setHeader('Content-Type', type);
    const refresh = up.headers.get('refresh'); // QR kab badlega (seconds)
    if (refresh) res.setHeader('Refresh', refresh);
    res.setHeader('Content-Length', String(body.length));
    return req.method === 'HEAD' ? res.end() : res.end(body);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Refresh', '5');
    return res.end(`QR server se connect nahi hua (${err.name === 'AbortError' ? 'timeout' : err.message}). Panel chalu hai? BACKEND_URL sahi hai?`);
  }
};
