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

// Nothing sensitive is exposed to frontend
// GAS_URL stays on server — browser uses /api/* proxy
const ENV = {};

// Server-side config (never sent to browser)
const SERVER_CONFIG = {
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

// ── Session store (in-memory, keyed by token) ────────────────
// Token = 32-byte hex, maps to { email, name, role, createdAt }
const crypto   = require('crypto');
const sessions = {}; // { token: { email, name, role, createdAt } }
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 hours

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = {
    email:     user.email || '',
    name:      user.name  || '',
    role:      user.role  || 'manager',
    createdAt: Date.now(),
  };
  // Clean expired sessions
  const now = Date.now();
  Object.keys(sessions).forEach(t => {
    if (now - sessions[t].createdAt > SESSION_TTL) delete sessions[t];
  });
  return token;
}

function getSession(req) {
  // Accept token from header or cookie
  const authHeader = req.headers['x-crm-token'] || '';
  const cookieStr  = req.headers['cookie'] || '';
  const cookieToken = cookieStr.split(';').map(s => s.trim())
    .find(s => s.startsWith('crm_token='));
  const token = authHeader || (cookieToken ? cookieToken.split('=')[1] : '');
  if (!token) return null;
  const sess = sessions[token];
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_TTL) { delete sessions[token]; return null; }
  return { ...sess, token };
}

// ── Auth middleware for protected routes ──────────────────────
function requireAuth(req, res, next) {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: 'Unauthorized', code: 401 });
  req.session = sess;
  next();
}

// ── POST /auth/session — issue token after GAS login ─────────
// Called by CRM after successful /api/auth/login
app.post('/auth/session', express.json(), (req, res) => {
  const { email, name, role } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const token = createSession({ email, name, role });
  // Set as cookie too (httpOnly for safety)
  res.setHeader('Set-Cookie', `crm_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
  res.json({ ok: true, token });
});

// ── DELETE /auth/session — logout ────────────────────────────
app.delete('/auth/session', (req, res) => {
  const sess = getSession(req);
  if (sess) delete sessions[sess.token];
  res.setHeader('Set-Cookie', 'crm_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// ── GET /auth/session — check current session ─────────────────
app.get('/auth/session', (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.json({ ok: false });
  res.json({ ok: true, user: { email: sess.email, name: sess.name, role: sess.role } });
});

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
        try { cb(JSON.parse(data)); }
        catch(e) { cb({ error: 'Invalid JSON: ' + data.slice(0, 200) }); }
      });
    });
    req.on('error', e => cb({ error: e.message }));
    if (reqBody) req.write(reqBody);
    req.end();
  }

  doRequest(options, requestBody, (data) => {
    callback(data);
  });
}

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.text());

// ── CORS ──────────────────────────────────────────────────────
// Allowed origins: own domain + localhost for dev
const ALLOWED_ORIGINS = [
  process.env.RENDER_EXTERNAL_URL   || '',     // e.g. https://migrallclients.onrender.com
  process.env.CORS_EXTRA_ORIGIN     || '',     // optional extra domain (custom domain)
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';

  // Telegram webhook comes without Origin header — allow it on /tg/webhook only
  if (!origin && req.path === '/tg/webhook') {
    return next();
  }

  // Allow requests with no Origin (same-origin browser requests, server-to-server)
  if (!origin) {
    return next();
  }

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-crm-token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    // Unknown origin — log and block CORS (request still processes for same-origin)
    if (origin) console.warn('[CORS] Blocked origin:', origin);
  }

  if (req.method === 'OPTIONS') {
    // Preflight: only respond OK if origin was allowed
    if (ALLOWED_ORIGINS.includes(origin)) {
      res.sendStatus(204);
    } else {
      res.sendStatus(403);
    }
    return;
  }

  next();
});

// ── Field-level AES-256-CBC Encryption ───────────────────────
// Key stored in ENCRYPT_KEY env var (never in code or Sheets)
// Format stored in Sheets: "enc:<base64_iv>:<base64_ciphertext>"
// Plain values are stored as-is (no prefix) for backward compat

const ENCRYPT_KEY_HEX = process.env.ENCRYPT_KEY || '';
const ENCRYPT_KEY = ENCRYPT_KEY_HEX
  ? Buffer.from(ENCRYPT_KEY_HEX.padEnd(64, '0').slice(0, 64), 'hex')
  : null;

if (!ENCRYPT_KEY_HEX) {
  console.warn('⚠️  ENCRYPT_KEY not set — data stored in plaintext');
  console.warn(`⚠️  Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
}

function encryptField(value) {
  if (!ENCRYPT_KEY || !value) return value || '';
  try {
    const iv         = crypto.randomBytes(16);
    const cipher     = crypto.createCipheriv('aes-256-cbc', ENCRYPT_KEY, iv);
    const encrypted  = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return 'enc:' + iv.toString('base64') + ':' + encrypted.toString('base64');
  } catch(e) {
    console.error('[encrypt] error:', e.message);
    return value;
  }
}

function decryptField(value) {
  if (!ENCRYPT_KEY || !value || !String(value).startsWith('enc:')) return value || '';
  try {
    const parts      = String(value).split(':');
    if (parts.length !== 3) return value;
    const iv         = Buffer.from(parts[1], 'base64');
    const encrypted  = Buffer.from(parts[2], 'base64');
    const decipher   = crypto.createDecipheriv('aes-256-cbc', ENCRYPT_KEY, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch(e) {
    // Decryption failed - log error for debugging
    console.error('[decrypt] FAILED for value starting:', String(value).slice(0, 40), 'error:', e.message);
    return value; // Return as-is
  }
}

// Encrypt/decrypt objects by field list
function encryptFields(obj, fields) {
  if (!ENCRYPT_KEY) return obj;
  const result = { ...obj };
  fields.forEach(f => { if (result[f]) result[f] = encryptField(result[f]); });
  return result;
}

function decryptFields(obj, fields) {
  const result = { ...obj };
  fields.forEach(f => { if (result[f]) result[f] = decryptField(result[f]); });
  return result;
}

// Field lists per data type — ALL sensitive fields across ALL sheets
const ENC_FIELDS = {
  // Telegram messages
  tgmessages:  ['text', 'fromName', 'chatName', 'fileName'],

  // Clients
  clients:     ['name', 'tg', 'phone', 'email', 'comment', 'address',
                 'notes', 'passport', 'inn', 'snils', 'birthdate'],

  // Staff / users
  users:       ['name', 'phone'], // email excluded — used as login lookup key

  // Court cases
  courts:      ['name', 'comment', 'place'],

  // Citizenship cases
  citizenship: ['name', 'comment', 'track'],

  // Orders (Права, Переводы, Справки)
  orders:      ['comment', 'clientName'],

  // Spec tasks (lawyer/translator tasks)
  specTasks:   ['client', 'description', 'comment'],

  // Filings
  filings:     ['clientName', 'comment', 'notes'],

  // Checklists
  checklists:  ['comment', 'notes'],

  // Schedule
  schedule:    ['clientName', 'notes', 'comment'],
};

// Map API path prefix → ENC_FIELDS key
const ENC_PATH_MAP = {
  '/clients':    'clients',
  '/users':      'users',
  '/auth':       'users',
  '/courts':     'courts',
  '/citizenship':'citizenship',
  '/orders':     'orders',
  '/spec-tasks': 'specTasks',
  '/filings':    'filings',
  '/checklists': 'checklists',
  '/schedule':   'schedule',
  '/tg-messages':'tgmessages',
};

function getEncFields(apiPath) {
  for (const [prefix, key] of Object.entries(ENC_PATH_MAP)) {
    if (apiPath.startsWith(prefix)) return ENC_FIELDS[key] || [];
  }
  return [];
}

// ── Rate Limiter (no external deps) ──────────────────────────
// Protects auth endpoints from brute-force attacks
const _rateLimitStore = new Map(); // ip:endpoint → [timestamps]

function rateLimiter(maxRequests, windowMs, keyPrefix) {
  return (req, res, next) => {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              || req.socket?.remoteAddress
              || 'unknown';
    const key = keyPrefix + ':' + ip;
    const now = Date.now();

    // Get existing timestamps, remove expired ones
    const timestamps = (_rateLimitStore.get(key) || [])
      .filter(ts => now - ts < windowMs);

    if (timestamps.length >= maxRequests) {
      const oldest   = timestamps[0];
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil((oldest + windowMs) / 1000));
      console.warn('[RateLimit] Blocked:', ip, 'on', keyPrefix,
        '| attempts:', timestamps.length, '| retry in:', retryAfter + 's');
      return res.status(429).json({
        error: 'Слишком много попыток. Попробуйте через ' + retryAfter + ' секунд.',
        retryAfter,
        code: 429,
      });
    }

    // Record this request
    timestamps.push(now);
    _rateLimitStore.set(key, timestamps);

    // Add headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', maxRequests - timestamps.length);

    next();
  };
}

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const maxWindow = 15 * 60 * 1000;
  let cleaned = 0;
  for (const [key, timestamps] of _rateLimitStore.entries()) {
    const fresh = timestamps.filter(ts => now - ts < maxWindow);
    if (fresh.length === 0) { _rateLimitStore.delete(key); cleaned++; }
    else _rateLimitStore.set(key, fresh);
  }
  if (cleaned > 0) console.log('[RateLimit] Cleaned', cleaned, 'expired entries');
}, 5 * 60 * 1000);

// Specific limiters:
const loginLimiter    = rateLimiter(20, 15 * 60 * 1000, 'login');   // 20 per 15min
const authLimiter     = rateLimiter(50, 15 * 60 * 1000, 'auth');     // 50 per 15min
const tgSendLimiter   = rateLimiter(60,  1 * 60 * 1000, 'tg-send');  // 60 per min

// ── Health/ping endpoint ──────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Encryption diagnostic ──────────────────────────────────────
// Also: quick re-run migration without auth (uses ADMIN_SECRET)
app.post('/api/admin/remigrate', express.json(), (req, res) => {
  if (!ENCRYPT_KEY) return res.json({ error: 'ENCRYPT_KEY not set' });
  const adminSecret = process.env.ADMIN_SECRET || 'fix2024';
  const provided = (req.body || {}).secret || '';
  if (provided !== adminSecret) return res.status(403).json({ error: 'Wrong secret' });

  // Just re-trigger the full migration
  req.body = req.body || {};
  // Forward to encrypt-migrate handler
  const fakeReq = { body: req.body, headers: req.headers, ip: req.ip, socket: req.socket };
  // Call migration logic inline
  if (!GAS_URL) return res.json({ error: 'No GAS_URL' });

  const results = {};
  const tables = [
    { path: '/clients',    fields: ENC_FIELDS.clients,    idField: 'id' },
    { path: '/courts',     fields: ENC_FIELDS.courts,     idField: 'num' },
    { path: '/citizenship',fields: ENC_FIELDS.citizenship,idField: 'num' },
    { path: '/orders',     fields: ENC_FIELDS.orders,     idField: 'id' },
    { path: '/spec-tasks', fields: ENC_FIELDS.specTasks,  idField: 'id' },
    { path: '/schedule',   fields: ENC_FIELDS.schedule,   idField: 'id' },
    { path: '/filings',    fields: ENC_FIELDS.filings,    idField: 'id' },
    { path: '/users',      fields: ENC_FIELDS.users,      idField: 'email' },
  ];
  let pending = tables.length + 1;

  function checkDone() {
    pending--;
    if (pending === 0) {
      console.log('[remigrate] done:', results);
      res.json({ ok: true, results });
    }
  }

  tables.forEach(({ path, fields, idField }) => {
    const key = path.replace('/', '');
    proxyToGAS('GET', path, '', (rows) => {
      console.log('[remigrate]', path, 'got:', Array.isArray(rows) ? rows.length + ' rows' : 'ERROR: ' + JSON.stringify(rows).slice(0,100));
      if (!Array.isArray(rows)) { results[key] = 'error: not array'; checkDone(); return; }
      const toMigrate = rows.filter(r => fields.some(f => r[f] && !String(r[f]).startsWith('enc:')));
      console.log('[remigrate]', path, 'to encrypt:', toMigrate.length);
      if (!toMigrate.length) { results[key] = 'already encrypted or empty'; checkDone(); return; }
      let done = 0;
      toMigrate.forEach(row => {
        const encrypted = encryptFields(row, fields);
        proxyToGAS('PUT', path + '/' + (row[idField]||row.id||row.num||''), JSON.stringify(encrypted), (r) => {
          done++;
          if (done === toMigrate.length) { results[key] = 'migrated ' + done; checkDone(); }
        });
      });
    });
  });

  // TG messages
  proxyToGAS('GET', '/tg-messages', '', (msgs) => {
    if (!Array.isArray(msgs)) { results.tgmessages = 'error'; checkDone(); return; }
    const toMigrate = msgs.filter(m => ENC_FIELDS.tgmessages.some(f => m[f] && !String(m[f]).startsWith('enc:')));
    if (!toMigrate.length) { results.tgmessages = 'already encrypted or empty'; checkDone(); return; }
    let done = 0;
    toMigrate.forEach(msg => {
      const encrypted = encryptFields(msg, ENC_FIELDS.tgmessages);
      proxyToGAS('PUT', '/tg-messages/' + msg.id, JSON.stringify(encrypted), () => {
        done++;
        if (done === toMigrate.length) { results.tgmessages = 'migrated ' + done; checkDone(); }
      });
    });
  });
});

app.get('/api/diag/enc', (req, res) => {
  const keySet = !!ENCRYPT_KEY;
  const keyLen = ENCRYPT_KEY ? ENCRYPT_KEY.length : 0;
  const testResult = keySet ? (() => {
    try {
      const enc = encryptField('test_value_123');
      const dec = decryptField(enc);
      return { encrypted: enc.slice(0, 30) + '...', decrypted: dec, ok: dec === 'test_value_123' };
    } catch(e) { return { error: e.message }; }
  })() : null;

  // Fetch one client and show raw vs decrypted
  if (!GAS_URL) return res.json({ keySet, keyLen, testResult, error: 'No GAS_URL' });

  proxyToGAS('GET', '/clients', '', (rawClients) => {
    const sample = Array.isArray(rawClients) ? rawClients.slice(0, 2) : rawClients;
    const encFields = ENC_FIELDS.clients || [];
    const decSample = Array.isArray(rawClients)
      ? rawClients.slice(0, 2).map(r => decryptFields(r, encFields))
      : null;
    res.json({
      keySet, keyLen, testResult,
      encFields,
      rawSample: sample,
      decryptedSample: decSample,
      proxyWorking: Array.isArray(rawClients),
    });
  });
});
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Rate limiting on auth routes ─────────────────────────────
// Login: 5 attempts per 15min per IP
app.post('/api/auth/login',        loginLimiter, (req, res, next) => next());
app.post('/api/auth/client_login', loginLimiter, (req, res, next) => next());
// All other auth: 20 per 15min per IP
app.all('/api/auth/*',             authLimiter,  (req, res, next) => next());

// ── Login interceptor: handle encrypted emails ────────────────
// If ENCRYPT_KEY is set and user emails are encrypted in Sheets,
// we need to find user by decrypting all emails server-side
app.post('/api/auth/login', express.json(), (req, res, next) => {
  if (!ENCRYPT_KEY || !GAS_URL) return next(); // no encryption, pass through
  const { email, password } = req.body || {};
  if (!email || !password) return next();

  // Fetch all users from GAS and find by decrypted email
  proxyToGAS('GET', '/users', '', (users) => {
    if (!Array.isArray(users)) return next(); // fallback to normal flow

    // Find user whose decrypted email matches
    const user = users.find(u => {
      const decryptedEmail = decryptField(u.email || '');
      return decryptedEmail.toLowerCase() === email.toLowerCase();
    });

    if (!user) {
      // Try exact match (email not encrypted)
      const plainUser = users.find(u => (u.email||'').toLowerCase() === email.toLowerCase());
      if (!plainUser) return res.json({ error: 'Неверный email или пароль' });
    }

    // Found user - proxy login to GAS using the decrypted/plain email
    // GAS will do verifyPassword on the stored hash
    proxyToGAS('POST', '/auth/login', JSON.stringify({ action: 'login', email, password }), (result) => {
      if (result && result.ok && result.user) {
        result.user = decryptFields(result.user, ENC_FIELDS.users || []);
      }
      res.json(result);
    });
  });
});

// ── API прокси: /api/* → GAS (excluding /api/tg/*) ───────────
app.all('/api/*', (req, res, next) => {
  // TG and admin routes are handled by dedicated endpoints
  if (req.path.startsWith('/api/tg/') || req.path === '/api/tg') {
    return next();
  }
  if (req.path.startsWith('/api/admin/')) {
    return next();
  }
  const apiPath = req.path.replace('/api', '') || '/';
  let body = req.body || '';
  if (typeof body === 'object') body = JSON.stringify(body);
  // Encrypt sensitive fields BEFORE sending to GAS
  const _encFields = getEncFields(apiPath);
  if (req.method !== 'GET' && body && typeof body === 'string' && _encFields.length) {
    try {
      const parsed = JSON.parse(body);
      body = JSON.stringify(encryptFields(parsed, _encFields));
    } catch(e) {}
  }

  proxyToGAS(req.method, apiPath, body, (data) => {
    if (!data || data.error) return res.json(data);

    // Decrypt all sensitive fields coming FROM GAS
    console.log('[proxy result] path:', apiPath, 'encFields:', _encFields.length, 'dataType:', Array.isArray(data) ? 'array('+data.length+')' : typeof data, data && data.error ? 'ERROR:'+data.error : '');
    if (_encFields.length) {
      console.log('[proxy decrypt] path:', apiPath, 'fields:', _encFields, 'isArray:', Array.isArray(data));
      if (Array.isArray(data) && data.length > 0) {
        // Log first record before decrypt
        const sample = data[0];
        const encCount = _encFields.filter(f => sample[f] && String(sample[f]).startsWith('enc:')).length;
        console.log('[proxy decrypt] first record encrypted fields:', encCount, '/', _encFields.length);
        data = data.map(r => decryptFields(r, _encFields));
        // Log after decrypt
        const decSample = data[0];
        const stillEnc = _encFields.filter(f => decSample[f] && String(decSample[f]).startsWith('enc:')).length;
        console.log('[proxy decrypt] after decrypt still enc:', stillEnc);
      } else if (data.data && Array.isArray(data.data)) {
        data.data = data.data.map(r => decryptFields(r, _encFields));
      } else if (data.user) {
        data.user = decryptFields(data.user, _encFields);
      } else if (data.id || data.num) {
        data = decryptFields(data, _encFields);
      }
    }

    res.json(data);
  });
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

// ═══════════════════════════════════════════════════════════════
// TELEGRAM BUSINESS INTEGRATION
// ═══════════════════════════════════════════════════════════════
const TG_TOKEN   = process.env.TG_BOT_TOKEN    || '';
const TG_SECRET  = process.env.TG_WEBHOOK_SECRET || '';
if (!TG_SECRET) {
  console.warn('⚠️  WARNING: TG_WEBHOOK_SECRET is not set!');
  console.warn('⚠️  Anyone can send fake messages to /tg/webhook');
  console.warn('⚠️  Add TG_WEBHOOK_SECRET to Render Environment Variables');
}
const TG_API     = 'https://api.telegram.org/bot';

// In-memory chat store + GAS persistence
const tgChats = {}; // { chatId: { info, messages[] } }

// ── Persist message to GAS ────────────────────────────────────
function persistTgMessage(chatInfo, msg) {
  if (!GAS_URL) return;
  const rawPayload = {
    id:           String(msg.id || Date.now()),
    chatId:       String(chatInfo.id),
    chatName:     chatInfo.name     || '',
    chatUsername: chatInfo.username || '',
    fromName:     msg.fromName      || '',
    fromId:       String(msg.fromId || ''),
    text:         msg.text          || '',
    ts:           msg.ts            || Date.now(),
    isOutgoing:   msg.isOutgoing ? 'TRUE' : 'FALSE',
    isRead:       msg.isRead    ? 'TRUE' : 'FALSE',
    mediaType:    msg.mediaType  || '',
    fileId:       msg.fileId     || '',
    fileName:     msg.fileName   || '',
    mimeType:     msg.mimeType   || '',
    fileSize:     msg.fileSize   || '',
    fileUrl:      msg.fileUrl    || '',
  };
  // Encrypt sensitive fields before storing in Sheets
  const payload = encryptFields(rawPayload, ENC_FIELDS.tgmessages);

  const body = JSON.stringify(payload);
  const gasUrl = GAS_URL + '?path=tg-messages';
  const parsedUrl = url.parse(gasUrl);
  const req = https.request({
    hostname: parsedUrl.hostname,
    path:     parsedUrl.path,
    method:   'POST',
    headers:  { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }
  }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try { const r = JSON.parse(data); if (!r.ok) console.warn('[TG persist] error:', r); }
      catch(e) { console.warn('[TG persist] parse error:', e.message); }
    });
  });
  req.on('error', e => console.warn('[TG persist] request error:', e.message));
  req.write(body);
  req.end();
}

// ── Load chat history from GAS on startup ─────────────────────
function loadTgHistoryFromGAS() {
  if (!GAS_URL) return;
  console.log('[TG] Loading message history from GAS...');

  function processRows(rows) {
    if (!Array.isArray(rows)) {
      console.warn('[TG] History: expected array, got:', typeof rows, JSON.stringify(rows).slice(0,100));
      return;
    }
    let loaded = 0;
    rows.forEach(r => {
      const chatId = String(r.chatId || '');
      if (!chatId) return;
      if (!tgChats[chatId]) {
        const _n = r.chatName || 'Unknown';
        tgChats[chatId] = {
          id:       chatId,
          name:     (ENCRYPT_KEY && String(_n).startsWith('enc:')) ? decryptField(_n) : _n,
          username: r.chatUsername || '',
          type:     'private',
          messages: [],
          unread:   0,
          lastTs:   0,
        };
      }
      // proxyToGAS already decrypts fields — use directly
      const msg = {
        id:         r.id,
        ts:         Number(r.ts) || 0,
        text:       r.text       || '',
        fromName:   r.fromName   || '',
        fromId:     r.fromId     || '',
        isOutgoing: r.isOutgoing === 'TRUE' || r.isOutgoing === true,
        isRead:     true, // history always read; new messages marked unread by webhook
        mediaType:  r.mediaType  || null,
        fileId:     r.fileId     || null,
        fileName:   r.fileName   || null,
        mimeType:   r.mimeType   || null,
        fileSize:   r.fileSize   ? Number(r.fileSize) : null,
        fileUrl:    r.fileUrl    || null,
      };
      tgChats[chatId].messages.push(msg);
      if (msg.ts > tgChats[chatId].lastTs) tgChats[chatId].lastTs = msg.ts;
      // unread not counted for history — only for new webhook messages
      loaded++;
    });
    // Sort messages by ts in each chat
    Object.values(tgChats).forEach(c => {
      c.messages.sort((a, b) => a.ts - b.ts);
    });
    console.log('[TG] Loaded', loaded, 'messages from GAS for', Object.keys(tgChats).length, 'chats');
  }

  // Use proxyToGAS which correctly follows GAS redirects
  proxyToGAS('GET', '/tg-messages', '', (data) => {
    if (data && data.error) {
      console.warn('[TG] History load error from GAS:', data.error);
      return;
    }
    processRows(data);
  });
}

// ── Resolve Telegram file URL ────────────────────────────────
// Calls getFile API → gets file_path → builds CDN URL
// Updates message in tgChats in-place after async resolution
function resolveFileUrl(fileId, msgObj, chatId) {
  tgCall('getFile', { file_id: fileId }, (err, result) => {
    if (err || !result || !result.ok) {
      console.warn('[TG] getFile error:', err || result);
      return;
    }
    const filePath = result.result.file_path;
    const fileUrl  = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
    msgObj.fileUrl = fileUrl;

    // Also update persisted record in GAS
    if (GAS_URL && msgObj.id) {
      const body = JSON.stringify({ ...msgObj, chatId, isUpdate: true });
      const pu   = url.parse(GAS_URL + '?path=tg-messages');
      const req  = https.request({
        hostname: pu.hostname, path: pu.path, method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }
      }, r => r.resume());
      req.on('error', () => {});
      req.write(body); req.end();
    }
  });
}

// ── Proxy file download: /api/tg/file/:fileId ─────────────────
// Browser can't directly access api.telegram.org (CORS)
// Server proxies the file download
app.get('/api/tg/file/:fileId', requireAuth, (req, res) => {
  const fileId = decodeURIComponent(req.params.fileId);
  if (!TG_TOKEN) return res.status(503).json({ error: 'Bot not configured' });

  // Handle raw: prefixed IDs from Telethon import (internal IDs, not Bot API compatible)
  if (fileId.startsWith('raw:')) {
    return res.status(404).json({
      error: 'File imported from history — not accessible via Bot API',
      hint: 'This file was imported using MTProto. Bot API cannot retrieve it.'
    });
  }

  // First get the file path
  tgCall('getFile', { file_id: fileId }, (err, result) => {
    if (err || !result || !result.ok) {
      return res.status(404).json({ error: 'File not found', fileId });
    }
    const filePath = result.result.file_path;
    const fileUrl  = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
    const parsedUrl = url.parse(fileUrl);

    // Set content-type based on extension
    const ext = filePath.split('.').pop().toLowerCase();
    const mimeMap = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4',
      ogg: 'audio/ogg', mp3: 'audio/mpeg', pdf: 'application/pdf',
      doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    if (mimeMap[ext]) res.setHeader('Content-Type', mimeMap[ext]);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    // Proxy the file
    https.get({ hostname: parsedUrl.hostname, path: parsedUrl.path }, tgRes => {
      tgRes.pipe(res);
    }).on('error', e => {
      console.warn('[TG file proxy] error:', e.message);
      res.status(500).json({ error: 'Download failed' });
    });
  });
});

// Load history on startup (with delay to let server fully start)
setTimeout(loadTgHistoryFromGAS, 5000); // wait for server to fully init

// ── Telegram API helper ────────────────────────────────────────
function tgCall(method, params, cb) {
  if (!TG_TOKEN) return cb && cb({ error: 'TG_BOT_TOKEN not set' });
  const body = JSON.stringify(params);
  const parsedUrl = url.parse(TG_API + TG_TOKEN + '/' + method);
  const req = https.request({
    hostname: parsedUrl.hostname,
    path:     parsedUrl.path,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try { cb && cb(null, JSON.parse(data)); }
      catch(e) { cb && cb({ error: data }); }
    });
  });
  req.on('error', e => cb && cb({ error: e.message }));
  req.write(body);
  req.end();
}

// ── Webhook: receive messages from Telegram ────────────────────
app.post('/tg/webhook', express.json(), (req, res) => {
  // Verify secret token — always required if configured
  const secret = req.headers['x-telegram-bot-api-secret-token'] || '';
  if (!TG_SECRET) {
    // No secret configured — log warning but accept (dev mode)
    console.warn('[TG webhook] No secret configured — accepting without verification');
  } else if (secret !== TG_SECRET) {
    console.warn('[TG webhook] Invalid secret from', req.ip, '— rejected');
    return res.sendStatus(403);
  }

  const update = req.body;
  console.log('[TG webhook]', JSON.stringify(update).slice(0, 200));

  // Handle business messages (from connected business account)
  const msg = update.message
    || update.business_message
    || update.edited_business_message
    || update.edited_message;

  if (msg) {
    const chatId   = String(msg.chat.id);
    const from     = msg.from || {};
    const isBot    = from.is_bot;
    const isBusinessConn = !!update.business_message || !!update.edited_business_message;

    const _bizConnId = (update.business_message && update.business_message.business_connection_id)
      || (update.edited_business_message && update.edited_business_message.business_connection_id)
      || null;

    if (!tgChats[chatId]) {
      tgChats[chatId] = {
        id:       chatId,
        name:     msg.chat.first_name
                  ? (msg.chat.first_name + ' ' + (msg.chat.last_name||'')).trim()
                  : (msg.chat.title || msg.chat.username || 'Unknown'),
        username: msg.chat.username || '',
        type:     msg.chat.type,
        messages: [],
        unread:   0,
        lastTs:   0,
        businessConnectionId: _bizConnId,
      };
    }

    const chat = tgChats[chatId];
    if (_bizConnId && !chat.businessConnectionId) {
      chat.businessConnectionId = _bizConnId;
    }
    // ── Extract media info ───────────────────────────────────────
    let mediaType = null;
    let fileId    = null;
    let fileName  = null;
    let mimeType  = null;
    let fileSize  = null;

    if (msg.photo && msg.photo.length) {
      // Telegram sends multiple resolutions — take largest
      const photo = msg.photo[msg.photo.length - 1];
      mediaType = 'photo';
      fileId    = photo.file_id;
      fileName  = 'photo.jpg';
      mimeType  = 'image/jpeg';
      fileSize  = photo.file_size;
    } else if (msg.document) {
      mediaType = 'document';
      fileId    = msg.document.file_id;
      fileName  = msg.document.file_name || 'file';
      mimeType  = msg.document.mime_type || 'application/octet-stream';
      fileSize  = msg.document.file_size;
    } else if (msg.video) {
      mediaType = 'video';
      fileId    = msg.video.file_id;
      fileName  = msg.video.file_name || 'video.mp4';
      mimeType  = msg.video.mime_type || 'video/mp4';
      fileSize  = msg.video.file_size;
    } else if (msg.voice) {
      mediaType = 'voice';
      fileId    = msg.voice.file_id;
      fileName  = 'voice.ogg';
      mimeType  = 'audio/ogg';
      fileSize  = msg.voice.file_size;
    } else if (msg.audio) {
      mediaType = 'audio';
      fileId    = msg.audio.file_id;
      fileName  = msg.audio.file_name || msg.audio.title || 'audio.mp3';
      mimeType  = msg.audio.mime_type || 'audio/mpeg';
      fileSize  = msg.audio.file_size;
    } else if (msg.video_note) {
      mediaType = 'video_note';
      fileId    = msg.video_note.file_id;
      fileName  = 'video_note.mp4';
      mimeType  = 'video/mp4';
      fileSize  = msg.video_note.file_size;
    } else if (msg.animation) {
      mediaType = 'animation';
      fileId    = msg.animation.file_id;
      fileName  = msg.animation.file_name || 'animation.gif';
      mimeType  = msg.animation.mime_type || 'image/gif';
      fileSize  = msg.animation.file_size;
    } else if (msg.sticker) {
      mediaType = 'sticker';
      fileId    = msg.sticker.file_id;
      fileName  = msg.sticker.emoji || '🎯';
      mimeType  = msg.sticker.is_animated ? 'application/json' : 'image/webp';
    }

    const _isOut = isBot || (from.id && String(from.id) === String(msg.chat.id) ? false : isBusinessConn && from.is_bot);
    const msgObj = {
      id:         msg.message_id,
      ts:         msg.date * 1000,
      text:       msg.text || msg.caption || '',
      fromName:   from.first_name ? (from.first_name + ' ' + (from.last_name||'')).trim() : 'Business',
      fromId:     from.id,
      isOutgoing: _isOut,
      isRead:     _isOut ? true : false, // outgoing = already read; incoming = unread
      // Media fields
      mediaType:  mediaType,
      fileId:     fileId,
      fileName:   fileName,
      mimeType:   mimeType,
      fileSize:   fileSize,
      fileUrl:    null,  // resolved asynchronously below
    };

    // Resolve file URL from Telegram (async, non-blocking)
    if (fileId && TG_TOKEN) {
      resolveFileUrl(fileId, msgObj, chatId);
    }

    chat.messages.push(msgObj);
    chat.lastTs = msgObj.ts;
    if (!msgObj.isOutgoing) chat.unread++;

    // Persist to GAS asynchronously (non-blocking)
    persistTgMessage(chat, msgObj);
  }

  // Handle business connection events
  if (update.business_connection) {
    console.log('[TG] Business connection:', update.business_connection.id);
  }

  res.sendStatus(200);
});

// ── GET /api/tg/chats — list all chats ────────────────────────
app.get('/api/tg/chats', requireAuth, (req, res) => {
  if (!TG_TOKEN) return res.json({ error: 'TG_BOT_TOKEN not configured' });
  const list = Object.values(tgChats)
    .sort((a, b) => b.lastTs - a.lastTs)
    .map(c => ({
      id:       c.id,
      name:     c.name,
      username: c.username,
      type:     c.type,
      unread:   c.unread,
      lastTs:   c.lastTs,
      lastMsg:       c.messages.length ? (() => {
        const t = c.messages[c.messages.length - 1].text || '';
        const dec = (ENCRYPT_KEY && t.startsWith('enc:')) ? decryptField(t) : t;
        return dec.slice(0, 80);
      })() : '',
      lastIsOutgoing: c.messages.length ? !!c.messages[c.messages.length - 1].isOutgoing : false,
    }));
  res.json({ ok: true, chats: list, total: list.length });
});

// ── GET /api/tg/messages/:chatId ─────────────────────────────
app.get('/api/tg/messages/:chatId', requireAuth, (req, res) => {
  const chatId = req.params.chatId;
  const chat   = tgChats[chatId];
  if (!chat) return res.json({ ok: true, messages: [], chat: null });
  // Decrypt name if still encrypted
  if (ENCRYPT_KEY && chat.name && String(chat.name).startsWith('enc:')) {
    chat.name = decryptField(chat.name);
  }
  // Mark as read in memory
  chat.unread = 0;
  chat.messages.forEach(m => {
    m.isRead = true;
    // Decrypt any fields that are still encrypted (e.g. loaded before ENC_PATH_MAP fix)
    if (ENCRYPT_KEY) {
      if (m.text     && String(m.text).startsWith('enc:'))     m.text     = decryptField(m.text);
      if (m.fromName && String(m.fromName).startsWith('enc:')) m.fromName = decryptField(m.fromName);
      if (m.fileName && String(m.fileName).startsWith('enc:')) m.fileName = decryptField(m.fileName);
    }
  });

  // Mark as read in GAS (async, non-blocking)
  if (GAS_URL) {
    const gasUrl = GAS_URL + '?path=tg-messages&chatId=' + encodeURIComponent(chatId) + '&action=markread';
    const body   = JSON.stringify({ action: 'markread', chatId });
    const pu     = url.parse(GAS_URL + '?path=tg-messages');
    const req    = https.request({
      hostname: pu.hostname, path: pu.path, method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }
    }, r => r.resume());
    req.on('error', () => {});
    req.write(body); req.end();
  }

  res.json({ ok: true, chat: { id: chat.id, name: chat.name, username: chat.username, businessConnectionId: chat.businessConnectionId || null }, messages: chat.messages });
});

// ── POST /api/tg/send — send message with signature ──────────
app.post('/api/tg/send', express.json(), requireAuth, tgSendLimiter, (req, res) => {
  if (!TG_TOKEN) return res.json({ error: 'TG_BOT_TOKEN not configured' });
  const { chatId, text, businessConnectionId } = req.body;
  if (!chatId || !text) return res.json({ error: 'chatId and text required' });

  // Use verified session data — NOT client-supplied name/role (security fix)
  const managerName = req.session.name || req.session.email || '';
  const managerRole = req.session.role || '';
  const roleLabel = managerRole === 'admin' ? 'Администратор'
    : managerRole === 'manager' ? 'Менеджер'
    : managerRole === 'lawyer' ? 'Адвокат'
    : managerRole === 'translator' ? 'Переводчик' : '';
  const signature = managerName
    ? `\n\n— ${managerName}${roleLabel ? ', ' + roleLabel : ''}\nMigrAll`
    : '';
  const fullText = text + signature;

  const params = {
    chat_id: chatId,
    text:    fullText,
    parse_mode: 'HTML',
  };
  if (businessConnectionId) {
    params.business_connection_id = businessConnectionId;
  }

  // Send "typing..." indicator before message (mimics real human)
  const typingDelay = Math.min(1500, fullText.length * 30); // ~30ms per char, max 1.5s
  tgCall('sendChatAction', { chat_id: chatId, action: 'typing',
    ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}) }, () => {});
  
  setTimeout(() => {
  tgCall('sendMessage', params, (err, result) => {
    if (err) return res.json({ error: err });
    if (!result.ok) return res.json({ error: result.description });

    // Store sent message in chat + persist to GAS
    if (tgChats[chatId]) {
      const sentMsg = {
        id:         result.result.message_id,
        ts:         Date.now(),
        text:       fullText,
        fromName:   managerName || 'MigrAll',
        fromId:     '',
        isOutgoing: true,
        isRead:     true,
      };
      tgChats[chatId].messages.push(sentMsg);
      tgChats[chatId].lastTs = Date.now();
      persistTgMessage(tgChats[chatId], sentMsg);
    }
    res.json({ ok: true, messageId: result.result.message_id });
  });
  }, typingDelay); // end setTimeout
});

// ── POST /api/tg/setup-webhook — register webhook ────────────
app.post('/api/tg/setup-webhook', express.json(), requireAuth, (req, res) => {
  if (!TG_TOKEN) return res.json({ error: 'TG_BOT_TOKEN not set' });
  const webhookUrl = req.body.url || (process.env.RENDER_EXTERNAL_URL + '/tg/webhook');
  const params = {
    url:                  webhookUrl,
    allowed_updates:      ['message','business_message','edited_business_message','business_connection'],
    drop_pending_updates: true,
  };
  if (TG_SECRET) params.secret_token = TG_SECRET;
  tgCall('setWebhook', params, (err, result) => {
    if (err) return res.json({ error: err });
    res.json(result);
  });
});

// ── GET /api/tg/status — bot info + webhook info ──────────────
app.get('/api/tg/status', requireAuth, (req, res) => {
  if (!TG_TOKEN) return res.json({ error: 'TG_BOT_TOKEN not set', configured: false });
  tgCall('getMe', {}, (err, meResult) => {
    if (err) return res.json({ error: err, configured: false });
    tgCall('getWebhookInfo', {}, (err2, whResult) => {
      res.json({
        ok:         true,
        configured: true,
        bot:        meResult.result,
        webhook:    whResult?.result,
        chatsCount: Object.keys(tgChats).length,
      });
    });
  });
});

// ── GET /api/env-status — config status (no values exposed) ────
app.get('/api/env-status', requireAuth, (req, res) => {
  const status = {};
  Object.keys(SERVER_CONFIG).forEach(key => {
    status[key] = SERVER_CONFIG[key] ? 'ok' : 'missing';
  });
  status['GAS_URL'] = GAS_URL ? 'ok' : 'missing';
  res.json({ ok: true, status });
});

// ── POST /api/tg/import — bulk import from MTProto script ───────
// Accepts single message, adds to in-memory store + persists to GAS
app.post('/api/tg/import', express.json(), requireAuth, (req, res) => {
  const m = req.body;
  if (!m || !m.chatId || !m.id) {
    return res.status(400).json({ error: 'chatId and id required' });
  }

  const chatId = String(m.chatId);

  // Init chat if not exists
  if (!tgChats[chatId]) {
    tgChats[chatId] = {
      id:       chatId,
      name:     m.chatName     || 'Unknown',
      username: m.chatUsername || '',
      type:     'private',
      messages: [],
      unread:   0,
      lastTs:   0,
    };
  }

  const chat = tgChats[chatId];

  // Check for duplicate by message id
  if (chat.messages.some(msg => String(msg.id) === String(m.id))) {
    return res.json({ ok: true, skipped: true });
  }

  const msgObj = {
    id:         m.id,
    ts:         Number(m.ts) || 0,
    text:       m.text        || '',
    fromName:   m.fromName    || '',
    fromId:     m.fromId      || '',
    isOutgoing: m.isOutgoing  === true || m.isOutgoing === 'TRUE',
    isRead:     true,
    mediaType:  m.mediaType   || null,
    fileId:     m.fileId      || null,
    fileName:   m.fileName    || null,
    mimeType:   m.mimeType    || null,
    fileSize:   m.fileSize    ? Number(m.fileSize) : null,
    fileUrl:    m.fileUrl     || null,
  };

  chat.messages.push(msgObj);

  // Keep messages sorted by timestamp
  if (msgObj.ts > chat.lastTs) {
    chat.lastTs = msgObj.ts;
  }

  // Persist to GAS
  persistTgMessage(chat, msgObj);

  res.json({ ok: true, imported: true });
});

// ── POST /api/tg/enrich — set CRM name for a chat ───────────────
// Called when CRM matches a chat username to a client record
app.post('/api/tg/enrich', express.json(), requireAuth, (req, res) => {
  const { chatId, crmName } = req.body || {};
  if (!chatId || !crmName) return res.json({ error: 'chatId and crmName required' });
  if (tgChats[chatId]) {
    tgChats[chatId].crmName = crmName;
  }
  res.json({ ok: true });
});

// ── POST /api/admin/encrypt-migrate — encrypt existing plaintext ─
// One-time migration: encrypts plaintext data already in all Sheets
// Call once after setting ENCRYPT_KEY
// ── POST /api/admin/decrypt-user-emails — one-time fix ──────────
// Decrypts email fields in users that were incorrectly encrypted
app.post('/api/admin/decrypt-user-emails', express.json(), (req, res) => {
  if (!ENCRYPT_KEY) return res.json({ error: 'ENCRYPT_KEY not set' });
  // Allow with admin secret OR valid admin session
  const adminSecret = process.env.ADMIN_SECRET || '';
  const providedSecret = (req.body || {}).secret || '';
  const sess = getSession(req);
  const isAdmin = (adminSecret && providedSecret === adminSecret) || (sess && sess.role === 'admin');
  if (!isAdmin) return res.status(403).json({ error: 'Provide admin secret or login as admin' });

  proxyToGAS('GET', '/users', '', (users) => {
    if (!Array.isArray(users)) return res.json({ error: 'Could not fetch users', raw: users });
    const toFix = users.filter(u => u.email && String(u.email).startsWith('enc:'));
    if (!toFix.length) return res.json({ ok: true, message: 'No encrypted emails found' });

    let done = 0;
    toFix.forEach(user => {
      const decryptedEmail = decryptField(user.email);
      const fixed = { ...user, email: decryptedEmail };
      proxyToGAS('PUT', '/users/' + decryptedEmail, JSON.stringify(fixed), () => {
        done++;
        if (done === toFix.length) {
          res.json({ ok: true, fixed: done, emails: toFix.map(u => decryptField(u.email)) });
        }
      });
    });
  });
});

app.post('/api/admin/encrypt-migrate', express.json(), requireAuth, (req, res) => {
  if (!ENCRYPT_KEY) return res.json({ error: 'ENCRYPT_KEY not set — add it to Render env vars first' });
  const sess = getSession(req);
  if (!sess || sess.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const results = {};
  const tables = [
    { path: '/clients',    fields: ENC_FIELDS.clients,    idField: 'id' },
    { path: '/courts',     fields: ENC_FIELDS.courts,     idField: 'num' },
    { path: '/citizenship',fields: ENC_FIELDS.citizenship,idField: 'num' },
    { path: '/orders',     fields: ENC_FIELDS.orders,     idField: 'id' },
    { path: '/spec-tasks', fields: ENC_FIELDS.specTasks,  idField: 'id' },
    { path: '/schedule',   fields: ENC_FIELDS.schedule,   idField: 'id' },
    { path: '/filings',    fields: ENC_FIELDS.filings,    idField: 'id' },
    { path: '/users',      fields: ENC_FIELDS.users,      idField: 'email' },
  ];
  let pending = tables.length + 1; // +1 for tgmessages

  function checkDone() {
    pending--;
    if (pending === 0) {
      console.log('[encrypt-migrate] done:', results);
      res.json({ ok: true, results });
    }
  }

  // Migrate each table
  tables.forEach(({ path, fields, idField }) => {
    const key = path.replace('/', '');
    proxyToGAS('GET', path, '', (rows) => {
      if (!Array.isArray(rows)) {
        results[key] = 'skipped (no array)';
        checkDone(); return;
      }
      const toMigrate = rows.filter(r =>
        fields.some(f => r[f] && !String(r[f]).startsWith('enc:'))
      );
      if (!toMigrate.length) { results[key] = 'already encrypted or empty'; checkDone(); return; }
      let done = 0;
      toMigrate.forEach(row => {
        const encrypted = encryptFields(row, fields);
        proxyToGAS('PUT', path + '/' + row[idField], JSON.stringify(encrypted), () => {
          done++;
          if (done === toMigrate.length) { results[key] = 'migrated ' + done; checkDone(); }
        });
      });
    });
  });

  // Migrate TG messages via GAS tg-messages path
  proxyToGAS('GET', '/tg-messages', '', (msgs) => {
    if (!Array.isArray(msgs)) { results.tgmessages = 'skipped'; checkDone(); return; }
    const toMigrate = msgs.filter(m =>
      ENC_FIELDS.tgmessages.some(f => m[f] && !String(m[f]).startsWith('enc:'))
    );
    if (!toMigrate.length) { results.tgmessages = 'already encrypted or empty'; checkDone(); return; }
    let done = 0;
    toMigrate.forEach(msg => {
      const encrypted = encryptFields(msg, ENC_FIELDS.tgmessages);
      proxyToGAS('PUT', '/tg-messages/' + msg.id, JSON.stringify(encrypted), () => {
        done++;
        if (done === toMigrate.length) { results.tgmessages = 'migrated ' + done; checkDone(); }
      });
    });
  });
});

// ── GET /api/tg/unread — total unread count ───────────────────
app.get('/api/tg/unread', requireAuth, (req, res) => {
  const total = Object.values(tgChats).reduce((s, c) => s + c.unread, 0);
  res.json({ ok: true, unread: total });
});

console.log('[TG]', TG_TOKEN ? 'Bot token configured' : 'WARNING: TG_BOT_TOKEN not set');

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
