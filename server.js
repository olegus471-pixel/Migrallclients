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

// ── Health/ping endpoint ──────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── API прокси: /api/* → GAS (excluding /api/tg/*) ───────────
app.all('/api/*', (req, res, next) => {
  // TG routes are handled by dedicated endpoints below
  if (req.path.startsWith('/api/tg/') || req.path === '/api/tg') {
    return next();
  }
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

// ═══════════════════════════════════════════════════════════════
// TELEGRAM BUSINESS INTEGRATION
// ═══════════════════════════════════════════════════════════════
const TG_TOKEN   = process.env.TG_BOT_TOKEN    || '';
const TG_SECRET  = process.env.TG_WEBHOOK_SECRET || '';
const TG_API     = 'https://api.telegram.org/bot';

// In-memory chat store + GAS persistence
const tgChats = {}; // { chatId: { info, messages[] } }

// ── Persist message to GAS ────────────────────────────────────
function persistTgMessage(chatInfo, msg) {
  if (!GAS_URL) return;
  const payload = {
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
  };

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
  const gasUrl    = GAS_URL + '?path=tg-messages';
  const parsedUrl = url.parse(gasUrl);
  https.get({ hostname: parsedUrl.hostname, path: parsedUrl.path }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const rows = JSON.parse(data);
        if (!Array.isArray(rows)) return;
        let loaded = 0;
        rows.forEach(r => {
          const chatId = String(r.chatId || '');
          if (!chatId) return;
          if (!tgChats[chatId]) {
            tgChats[chatId] = {
              id:       chatId,
              name:     r.chatName     || 'Unknown',
              username: r.chatUsername || '',
              type:     'private',
              messages: [],
              unread:   0,
              lastTs:   0,
            };
          }
          const msg = {
            id:         r.id,
            ts:         Number(r.ts) || 0,
            text:       r.text       || '',
            fromName:   r.fromName   || '',
            fromId:     r.fromId     || '',
            isOutgoing: r.isOutgoing === 'TRUE' || r.isOutgoing === true,
            isRead:     r.isRead     === 'TRUE' || r.isRead     === true,
          };
          tgChats[chatId].messages.push(msg);
          if (msg.ts > tgChats[chatId].lastTs) tgChats[chatId].lastTs = msg.ts;
          if (!msg.isOutgoing && !msg.isRead) tgChats[chatId].unread++;
          loaded++;
        });
        // Sort messages by ts in each chat
        Object.values(tgChats).forEach(c => {
          c.messages.sort((a, b) => a.ts - b.ts);
        });
        console.log('[TG] Loaded', loaded, 'messages from GAS for', Object.keys(tgChats).length, 'chats');
      } catch(e) {
        console.warn('[TG] Failed to load history from GAS:', e.message);
      }
    });
  }).on('error', e => console.warn('[TG] History load error:', e.message));
}

// Load history on startup (with delay to let server fully start)
setTimeout(loadTgHistoryFromGAS, 3000);

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
  // Verify secret token
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (TG_SECRET && secret !== TG_SECRET) {
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
      };
    }

    const chat = tgChats[chatId];
    const msgObj = {
      id:        msg.message_id,
      ts:        msg.date * 1000,
      text:      msg.text || msg.caption || '[медиа]',
      fromName:  from.first_name ? (from.first_name + ' ' + (from.last_name||'')).trim() : 'Business',
      fromId:    from.id,
      isOutgoing: isBot || (from.id && String(from.id) === String(msg.chat.id) ? false : isBusinessConn && from.is_bot),
      isRead:    false,
    };

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
      lastMsg:  c.messages.length ? c.messages[c.messages.length - 1].text.slice(0, 80) : '',
    }));
  res.json({ ok: true, chats: list, total: list.length });
});

// ── GET /api/tg/messages/:chatId ─────────────────────────────
app.get('/api/tg/messages/:chatId', requireAuth, (req, res) => {
  const chatId = req.params.chatId;
  const chat   = tgChats[chatId];
  if (!chat) return res.json({ ok: true, messages: [], chat: null });
  // Mark as read in memory
  chat.unread = 0;
  chat.messages.forEach(m => { m.isRead = true; });

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

  res.json({ ok: true, chat: { id: chat.id, name: chat.name, username: chat.username }, messages: chat.messages });
});

// ── POST /api/tg/send — send message with signature ──────────
app.post('/api/tg/send', express.json(), requireAuth, (req, res) => {
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
