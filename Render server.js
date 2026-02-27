// ═══════════════════════════════════════════════════════════════
// CRM MigrAll — Render.com Node.js сервер
// Проксирует запросы к Google Apps Script
// 
// Деплой на Render:
// 1. Создать новый Web Service
// 2. Build command: npm install
// 3. Start command: node server.js
// 4. Environment variables:
//    GAS_URL = https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GAS_URL = process.env.GAS_URL || '';

if (!GAS_URL) {
  console.error('ERROR: GAS_URL environment variable is not set!');
  console.error('Set it in Render dashboard: Environment → GAS_URL = https://script.google.com/macros/s/.../exec');
}

function proxyToGAS(method, path, body, callback) {
  if (!GAS_URL) {
    return callback({ error: 'GAS_URL not configured on server' });
  }

  // Построить URL для GAS
  const gasUrl = GAS_URL + '?path=' + encodeURIComponent(path.replace(/^\//, ''));
  const parsedUrl = url.parse(gasUrl);

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.path,
    method: method,
    headers: { 'Content-Type': 'application/json' },
    followAllRedirects: true,
  };

  console.log('[proxy]', method, path, '→', gasUrl.slice(0, 80));

  // GAS всегда требует GET для чтения, POST для записи
  // Но GAS не поддерживает PUT/DELETE напрямую — симулируем через POST с _method
  let requestBody = '';
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const bodyObj = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
    if (method === 'PUT')    bodyObj._method = 'PUT';
    if (method === 'DELETE') bodyObj._method = 'DELETE';
    requestBody = JSON.stringify(bodyObj);
    options.headers['Content-Length'] = Buffer.byteLength(requestBody);
  }

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      // GAS может вернуть редирект — обработаем
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log('[proxy] redirect to:', res.headers.location);
        const redirectUrl = url.parse(res.headers.location);
        const redirectOpts = {
          hostname: redirectUrl.hostname,
          path: redirectUrl.path,
          method: 'GET',
          headers: {},
        };
        const req2 = https.request(redirectOpts, (res2) => {
          let data2 = '';
          res2.on('data', c => data2 += c);
          res2.on('end', () => {
            try { callback(JSON.parse(data2)); }
            catch(e) { callback({ error: 'Invalid JSON from GAS: ' + data2.slice(0, 200) }); }
          });
        });
        req2.on('error', e => callback({ error: e.message }));
        req2.end();
        return;
      }
      try { callback(JSON.parse(data)); }
      catch(e) { callback({ error: 'Invalid JSON: ' + data.slice(0, 200) }); }
    });
  });

  req.on('error', e => {
    console.error('[proxy] error:', e.message);
    callback({ error: e.message });
  });

  if (requestBody) req.write(requestBody);
  req.end();
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  // Получить path из query string (?path=/users) или из URL (/users)
  const pathParam = parsedUrl.query.path || parsedUrl.pathname;

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    proxyToGAS(req.method, pathParam, body, (data) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(data));
    });
  });
});

server.listen(PORT, () => {
  console.log('CRM MigrAll proxy server running on port ' + PORT);
  console.log('GAS URL:', GAS_URL ? GAS_URL.slice(0, 60) + '...' : 'NOT SET!');
});
