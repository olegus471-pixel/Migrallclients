// ═══════════════════════════════════════════════════════════════
// CRM MigrAll — Render.com Node.js сервер
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const https   = require('https');
const http    = require('http');
const url     = require('url');
const path    = require('path');
const fs      = require('fs');
const app     = express();

// ── Переменные окружения ──────────────────────────────────────
const GAS_URL = process.env.GAS_URL || '';

const ENV = {
  GAS_URL:           GAS_URL,
  SHEET_USERS:       process.env.SHEET_USERS        || '',
  SHEET_CLIENTS:     process.env.SHEET_CLIENTS      || '',
  SHEET_STATUSES:    process.env.SHEET_STATUSES     || '',
  SHEET_COURTS:      process.env.SHEET_COURTS       || '',
  SHEET_SCHEDULE:    process.env.SHEET_SCHEDULE     || '',
  SHEET_CITIZENSHIP: process.env.SHEET_CITIZENSHIP  || '',
  SHEET_RIGHTS:      process.env.SHEET_RIGHTS       || '',
  SHEET_ORDERS:      process.env.SHEET_ORDERS       || '',
  SHEET_TASKS:       process.env.SHEET_TASKS        || '',
  SHEET_FILINGS:     process.env.SHEET_FILINGS      || '',
  SHEET_SPEC_TASKS:  process.env.SHEET_SPEC_TASKS   || '',
  DRIVE_ROOT:        process.env.DRIVE_ROOT         || '',
  CALENDAR_ID:       process.env.CALENDAR_ID        || '',
};

if (!GAS_URL) console.warn('WARNING: GAS_URL is not set! API calls will fail.');

// ── Keep-alive: self-ping every 10 minutes to prevent sleep ──
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
function selfPing() {
  if (!RENDER_URL) return;
  const pingUrl = RENDER_URL + '/ping';
  const parsed = url.parse(pingUrl);
  const mod = parsed.protocol === 'https:' ? https : http;
  const req = mod.get({ hostname: parsed.hostname, path: parsed.path || '/ping', headers: { 'User-Agent': 'MigrAll-KeepAlive' } }, (res) => {
    console.log('[keepalive] ping', res.statusCode);
  });
  req.on('error', (e) => console.warn('[keepalive] ping error:', e.message));
  req.end();
}
// Ping every 10 minutes
setInterval(selfPing, 10 * 60 * 1000);
// First ping after 1 minute
setTimeout(selfPing, 60 * 1000);

// ── GAS прокси ────────────────────────────────────────────────
function proxyToGAS(method, apiPath, body, callback) {
  if (!GAS_URL) {
    return callback({ error: 'GAS_URL not configured on server' });
  }

  const gasUrl    = GAS_URL + '?path=' + encodeURIComponent(apiPath.replace(/^\//, ''));
  const parsedUrl = url.parse(gasUrl);

  const options = {
    hostname: parsedUrl.hostname,
    path:     parsedUrl.path,
    method:   method === 'GET' ? 'GET' : 'POST',
    headers:  { 'Content-Type': 'text/plain' },
  };

  let requestBody = '';
  if (method !== 'GET') {
    const bodyObj = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
    if (method === 'PUT')    bodyObj._method = 'PUT';
    if (method === 'DELETE') bodyObj._method = 'DELETE';
    requestBody = JSON.stringify(bodyObj);
    options.headers['Content-Length'] = Buffer.byteLength(requestBody);
  }

  console.log('[proxy]', method, apiPath, '->', gasUrl.slice(0, 80));

  function doRequest(reqOpts, reqBody, cb) {
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redir = url.parse(res.headers.location);
          doRequest({ hostname: redir.hostname, path: redir.path, method: 'GET', headers: {} }, '', cb);
          return;
        }
        try { cb(null, JSON.parse(data)); }
        catch(e) { cb({ error: 'Invalid JSON: ' + data.slice(0, 200) }); }
      });
    });
    req.on('error', e => cb({ error: e.message }));
    if (reqBody) req.write(reqBody);
    req.end();
  }

  doRequest(options, requestBody, (err, data) => {
    callback(err || data);
  });
}

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.text());

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

// ── Health/ping endpoint ──────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── API прокси: /api/* → GAS ──────────────────────────────────
app.all('/api/*', (req, res) => {
  const apiPath = req.path.replace('/api', '') || '/';
  let body = req.body || '';
  if (typeof body === 'object') body = JSON.stringify(body);
  proxyToGAS(req.method, apiPath, body, (data) => res.json(data));
});

// ── HTML с инжекцией __ENV ────────────────────────────────────
const envScript = `<script>\nwindow.__ENV = ${JSON.stringify(ENV)};\n</script>`;

function serveHtml(file, res) {
  const filePath = path.join(__dirname, file);
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) { res.status(404).send('Not found: ' + file); return; }
    const injected = html.replace('<head>', '<head>\n' + envScript);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(injected);
  });
}

// Статика
app.use(express.static(__dirname, { index: false }));

// Маршруты порталов
app.get('/client.html',     (req, res) => serveHtml('client.html', res));
app.get('/client',          (req, res) => serveHtml('client.html', res));
app.get('/lawyer.html',     (req, res) => serveHtml('lawyer.html', res));
app.get('/lawyer',          (req, res) => serveHtml('lawyer.html', res));
app.get('/translator.html', (req, res) => serveHtml('translator.html', res));
app.get('/translator',      (req, res) => serveHtml('translator.html', res));
app.get('/realestate.html', (req, res) => serveHtml('realestate.html', res));
app.get('/realestate',      (req, res) => serveHtml('realestate.html', res));
app.get('*',                (req, res) => serveHtml('index.html', res));

// ── Старт ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('MigrAll CRM running on port ' + PORT);
  console.log('ENV:', Object.entries(ENV).map(([k,v]) => k + '=' + (v ? 'OK' : 'MISSING')).join(' | '));
  if (RENDER_URL) console.log('[keepalive] Self-ping enabled:', RENDER_URL + '/ping');
  else console.log('[keepalive] Set RENDER_EXTERNAL_URL env var to enable self-ping');
});
