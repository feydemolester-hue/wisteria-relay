// Wisteria relay: a tiny store-and-forward mailbox so messages reach friends who are offline.
// No dependencies. Run: node server.js   (PORT env var is respected)
// Data lives in memory: restarting the server clears mailboxes and username claims.
const http = require('http');

const PORT = process.env.PORT || 8787;
const NAME_RE = /^[a-z0-9_.]{2,32}$/;
const TTL = 7 * 24 * 3600 * 1000;   // undelivered items expire after 7 days
const MAX_BOX = 500;                 // items per mailbox
const MAX_BODY = 3.5e6;              // bytes per request (images are base64 in messages)
const ONLINE_MS = 45000;             // "online" = polled within this window

const users = new Map();             // name -> { token, box: [], lastSeen, waiter }
let seq = 1;

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function prune(u) { const now = Date.now(); u.box = u.box.filter(i => now - i.ts < TTL); }

// Returns the user record if name+token are valid, claiming the name if it is free.
function auth(name, token, claim) {
  if (!NAME_RE.test(String(name)) || typeof token !== 'string' || token.length < 8 || token.length > 128) return null;
  let u = users.get(name);
  if (!u) { if (!claim) return null; u = { token, box: [], lastSeen: 0, waiter: null }; users.set(name, u); }
  if (u.token === null && claim) u.token = token;   // mailbox created by a sender: first registrant claims it
  return u.token === token ? u : null;
}

function flushWaiter(u) {
  if (u.waiter && u.box.length) { const w = u.waiter; u.waiter = null; clearTimeout(w.t); w.done(); }
}

const routes = {
  async '/register'(b, res) {
    const u = auth(b.user, b.token, true);
    if (!u) return send(res, 403, { ok: false, error: 'name claimed with a different secret' });
    u.lastSeen = Date.now(); send(res, 200, { ok: true });
  },
  async '/send'(b, res) {
    const me = auth(b.user, b.token, true);
    if (!me) return send(res, 403, { ok: false });
    me.lastSeen = Date.now();
    const to = users.get(b.to);
    if (!to) {   // recipient never registered: create an empty mailbox so the message waits for them
      if (!NAME_RE.test(String(b.to))) return send(res, 400, { ok: false });
      users.set(b.to, { token: null, box: [], lastSeen: 0, waiter: null });
    }
    const t = users.get(b.to); prune(t);
    if (t.box.length >= MAX_BOX) return send(res, 429, { ok: false, error: 'mailbox full' });
    t.box.push({ id: String(seq++), from: b.user, p: b.p, ts: Date.now() });
    flushWaiter(t); send(res, 200, { ok: true });
  },
  async '/poll'(b, res) {
    const u = auth(b.user, b.token, true);
    if (!u) return send(res, 403, { ok: false });
    u.lastSeen = Date.now(); prune(u);
    const reply = () => send(res, 200, { ok: true, items: u.box.slice(0, 50) });
    if (u.box.length) return reply();
    const wait = Math.min(25, Math.max(0, +b.wait || 0)) * 1000;
    if (!wait) return reply();
    if (u.waiter) { clearTimeout(u.waiter.t); u.waiter.done(); }   // a newer poll supersedes the old one
    const w = { done: () => { u.lastSeen = Date.now(); reply(); } };
    w.t = setTimeout(() => { if (u.waiter === w) u.waiter = null; w.done(); }, wait);
    u.waiter = w;
    res.on('close', () => { if (u.waiter === w) { clearTimeout(w.t); u.waiter = null; } });
  },
  async '/ack'(b, res) {
    const u = auth(b.user, b.token, false);
    if (!u) return send(res, 403, { ok: false });
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
    u.box = u.box.filter(i => !ids.has(i.id)); send(res, 200, { ok: true });
  },
  async '/who'(b, res) {
    const u = auth(b.user, b.token, false);
    if (!u) return send(res, 403, { ok: false });
    u.lastSeen = Date.now(); const now = Date.now();
    const online = (Array.isArray(b.names) ? b.names : []).slice(0, 300)
      .filter(n => { const x = users.get(n); return x && now - x.lastSeen < ONLINE_MS; });
    send(res, 200, { ok: true, online });
  },
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const path = req.url.split('?')[0];
  if (req.method === 'GET' && (path === '/' || path === '/health')) return send(res, 200, { ok: true, service: 'wisteria-relay' });
  const h = routes[path];
  if (req.method !== 'POST' || !h) return send(res, 404, { ok: false });
  try { await h(await readBody(req), res); } catch { if (!res.headersSent) send(res, 400, { ok: false }); }
}).listen(PORT, () => console.log('Wisteria relay listening on :' + PORT));

setInterval(() => { for (const [n, u] of users) { prune(u); if (!u.box.length && Date.now() - u.lastSeen > TTL) users.delete(n); } }, 3600 * 1000);
