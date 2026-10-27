// Web settings page (/settings) and admin site (/admin): login, per-session settings API, admin tools.
import crypto from 'node:crypto';
import path from 'node:path';
import { BOT_NAME, MAX_SESSIONS, ROOT_DIR, safeId, sessions, sha, sleep, state } from './config.js';
import { destroySession } from './session.js';
import { getMode, getSetting, setSetting } from './storage.js';
import { syncCallbot } from './callbot.js';
import { checkWebPassword, hasWebPassword, sendWebPassword, webPasswordVersion } from './webpass.js';

const SECRET = process.env.WEB_SECRET || crypto.randomBytes(32).toString('hex'); // set WEB_SECRET so logins survive a restart
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_ENABLED = ADMIN_PASSWORD.length >= 10;
const USER_TTL_S = 12 * 3600, ADMIN_TTL_S = 4 * 3600;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ---------- signed cookies ---------- */
const hmac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
const sign = (p) => { const body = Buffer.from(JSON.stringify(p)).toString('base64url'); return `${body}.${hmac(body)}`; };
function verify(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(hmac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function readCookie(req, name) {
  const hit = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
function putCookie(req, res, name, value, maxAge) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);
}

/* ---------- login throttling: 5 wrong attempts block a key for 10 minutes ---------- */
const fails = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.until <= now) fails.delete(k); }, 60000).unref();
const blockedFor = (key) => { const e = fails.get(key); return e && e.n >= 5 && e.until > Date.now() ? Math.ceil((e.until - Date.now()) / 1000) : 0; };
function addFail(key) {
  const now = Date.now(); let e = fails.get(key);
  if (!e || e.until <= now) e = { n: 0, until: now + 10 * 60 * 1000 };
  e.n++; fails.set(key, e);
}

/* ---------- settings: only these keys can be read or changed from the web ---------- */
const BOOLS = ['statusSeen', 'statusReact', 'statusSave', 'viewOnce', 'callReject', 'autoAnswer', 'callLoop', 'callStream'];
export function readSettings(sid) {
  const s = { mode: getMode(sid) };
  for (const k of BOOLS) s[k] = !!getSetting(sid, k, false);
  s.statusEmojis = (getSetting(sid, 'statusEmojis', null) || []).join(' ');
  s.callMsg = getSetting(sid, 'callMsg', null) || '';
  return s;
}
function applySettings(sid, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Nothing to change.');
  const writes = [];
  for (const [k, v] of Object.entries(patch)) {
    if (BOOLS.includes(k)) {
      if (typeof v !== 'boolean') throw new HttpError(400, 'Invalid value.');
      if (k === 'callStream' && v) throw new HttpError(400, 'Real call answering needs a one-time device link. Send .callstream on in WhatsApp to turn it on.');
      writes.push([k, v]);
    } else if (k === 'mode') {
      if (v !== 'public' && v !== 'private') throw new HttpError(400, 'Mode must be public or private.');
      writes.push([k, v]);
    } else if (k === 'statusEmojis') {
      if (typeof v !== 'string') throw new HttpError(400, 'Invalid value.');
      const list = v.split(/\s+/).filter(Boolean).slice(0, 20).map((e) => e.slice(0, 8));
      writes.push([k, list.length ? list : null]);
    } else if (k === 'callMsg') {
      if (typeof v !== 'string') throw new HttpError(400, 'Invalid value.');
      writes.push([k, v.trim().slice(0, 500) || null]);
    } else throw new HttpError(400, `Unknown setting: ${String(k).slice(0, 30)}`);
  }
  if (!writes.length) throw new HttpError(400, 'Nothing to change.');
  for (const [k, v] of writes) setSetting(sid, k, v);
  const rec = sessions.get(sid);
  if (writes.some(([k]) => k === 'callStream' || k === 'callLoop') && state.callbotAvailable && rec?.sock) syncCallbot(sid, rec.sock).catch(() => {});
}

async function unlink(sid) {
  const rec = sessions.get(sid);
  try { await Promise.race([rec?.sock?.logout(), sleep(5000)]); } catch {}
  destroySession(sid);
}
const mask = (p) => (p && p.length > 6 ? `${p.slice(0, 4)}${'•'.repeat(p.length - 6)}${p.slice(-2)}` : p || '');
const isLinked = (r) => r.status === 'connected' || !!r.state?.creds?.registered;

const auditLog = [];
function audit(action, detail = '') {
  auditLog.unshift({ at: new Date().toISOString(), action, detail });
  auditLog.length = Math.min(auditLog.length, 100);
  console.log(`[admin] ${action} ${detail}`);
}

export function mountWeb(app) {
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('Web route error:', err?.message || err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  });
  // Browsers cannot add a custom header cross-site without a CORS preflight, so this blocks cross-site form posts.
  const guard = (req, res, next) => (req.method !== 'GET' && req.get('x-rio') !== '1' ? res.status(403).json({ error: 'Bad request.' }) : next());

  app.use(['/settings', '/admin', '/api/web', '/api/me', '/api/admin'], (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.get('/settings', (_q, res) => res.sendFile(path.join(ROOT_DIR, 'views', 'settings.html')));
  app.get('/admin', (_q, res) => res.sendFile(path.join(ROOT_DIR, 'views', 'admin.html')));

  /* ----- user: login and own settings ----- */
  const userAuth = (req, res, next) => {
    const p = verify(readCookie(req, 'rio_u'));
    const rec = p?.t === 'u' ? sessions.get(p.sid) : null;
    if (!rec || !hasWebPassword(p.sid) || webPasswordVersion(p.sid) !== p.pv) return res.status(401).json({ error: 'Please log in again.' });
    req.sid = p.sid; req.rec = rec; next();
  };

  app.post('/api/web/login', guard, wrap((req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '').slice(0, 20);
    const password = String(req.body?.password || '');
    const keys = [`ip:${req.ip}`, `num:${phone}`];
    const wait = Math.max(...keys.map(blockedFor));
    if (wait) { res.set('Retry-After', String(wait)); throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`); }
    let sid = null;
    for (const [id, r] of sessions) if (phone && r.phone === phone && isLinked(r)) sid = id;
    if (!sid || !checkWebPassword(sid, password)) { keys.forEach(addFail); throw new HttpError(401, 'The number or password is not right.'); }
    fails.delete(keys[1]);
    putCookie(req, res, 'rio_u', sign({ t: 'u', sid, pv: webPasswordVersion(sid), exp: Date.now() + USER_TTL_S * 1000 }), USER_TTL_S);
    res.json({ ok: true });
  }));
  app.post('/api/web/logout', guard, (req, res) => { putCookie(req, res, 'rio_u', '', 0); res.json({ ok: true }); });

  app.get('/api/me', userAuth, (req, res) => res.json({ phone: req.rec.phone, status: req.rec.status, callService: !!state.callbotAvailable, settings: readSettings(req.sid) }));
  app.patch('/api/me/settings', guard, userAuth, wrap((req, res) => { applySettings(req.sid, req.body); res.json({ ok: true, settings: readSettings(req.sid) }); }));
  app.post('/api/me/password', guard, userAuth, wrap(async (req, res) => {
    if (!req.rec.sock) throw new HttpError(409, 'Your bot is offline right now, so the password cannot be sent. Try again in a minute.');
    await sendWebPassword(req.rec.sock, req.sid);
    putCookie(req, res, 'rio_u', '', 0); // the old password is gone, so this login ends too
    res.json({ ok: true });
  }));
  app.post('/api/me/unlink', guard, userAuth, wrap(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirmation is missing.');
    await unlink(req.sid);
    putCookie(req, res, 'rio_u', '', 0);
    res.json({ ok: true });
  }));

  /* ----- admin ----- */
  const adminAuth = (req, res, next) => {
    const p = ADMIN_ENABLED ? verify(readCookie(req, 'rio_a')) : null;
    if (p?.t !== 'a') return res.status(401).json({ error: 'Please log in again.' });
    next();
  };
  const target = (req) => {
    if (!safeId(req.params.id) || !sessions.get(req.params.id)) throw new HttpError(404, 'Session not found.');
    return sessions.get(req.params.id);
  };

  app.post('/api/admin/login', guard, wrap((req, res) => {
    if (!ADMIN_ENABLED) throw new HttpError(503, 'The admin site is off. Set ADMIN_PASSWORD (10+ characters) on the server.');
    const key = `admin:${req.ip}`;
    const wait = blockedFor(key);
    if (wait) { res.set('Retry-After', String(wait)); throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`); }
    const okUser = crypto.timingSafeEqual(sha(String(req.body?.user || '')), sha(ADMIN_USER));
    const okPass = crypto.timingSafeEqual(sha(String(req.body?.password || '')), sha(ADMIN_PASSWORD));
    if (!(okUser && okPass)) { addFail(key); audit('failed login', req.ip); throw new HttpError(401, 'The username or password is not right.'); }
    fails.delete(key);
    putCookie(req, res, 'rio_a', sign({ t: 'a', exp: Date.now() + ADMIN_TTL_S * 1000 }), ADMIN_TTL_S);
    audit('login', req.ip);
    res.json({ ok: true });
  }));
  app.post('/api/admin/logout', guard, (req, res) => { putCookie(req, res, 'rio_a', '', 0); res.json({ ok: true }); });

  app.get('/api/admin/overview', adminAuth, (_req, res) => {
    const list = [...sessions].map(([id, r]) => ({ id, phone: mask(r.phone), linked: isLinked(r), status: r.status, mode: getMode(id), webPassword: hasWebPassword(id) }));
    res.json({
      bot: BOT_NAME, uptimeSeconds: Math.round(process.uptime()), maxSessions: MAX_SESSIONS, storage: state.mongoCol ? 'MongoDB' : 'Files',
      callService: !!state.callbotAvailable, connected: list.filter((s) => s.status === 'connected').length,
      sessions: list.sort((a, b) => Number(b.linked) - Number(a.linked)), audit: auditLog.slice(0, 40),
    });
  });
  app.get('/api/admin/session/:id', adminAuth, wrap((req, res) => { const r = target(req); res.json({ phone: mask(r.phone), status: r.status, settings: readSettings(req.params.id) }); }));
  app.patch('/api/admin/session/:id/settings', guard, adminAuth, wrap((req, res) => {
    target(req); applySettings(req.params.id, req.body);
    audit('changed settings', `${mask(sessions.get(req.params.id)?.phone)}: ${Object.keys(req.body).join(', ')}`);
    res.json({ ok: true, settings: readSettings(req.params.id) });
  }));
  app.post('/api/admin/session/:id/restart', guard, adminAuth, wrap((req, res) => {
    const r = target(req);
    try { r.sock?.end(undefined); } catch {} // the normal reconnect logic brings it back
    audit('restarted', mask(r.phone)); res.json({ ok: true });
  }));
  app.post('/api/admin/session/:id/password', guard, adminAuth, wrap(async (req, res) => {
    const r = target(req);
    if (!r.sock) throw new HttpError(409, 'This session is offline, so the password cannot be sent.');
    await sendWebPassword(r.sock, req.params.id);
    audit('reset web password', mask(r.phone)); res.json({ ok: true });
  }));
  app.post('/api/admin/session/:id/delete', guard, adminAuth, wrap(async (req, res) => {
    const r = target(req);
    audit('deleted session', mask(r.phone));
    await unlink(req.params.id);
    res.json({ ok: true });
  }));
  if (!ADMIN_ENABLED) console.log('Admin site is off (set ADMIN_PASSWORD with 10+ characters to turn it on).');
  if (!process.env.WEB_SECRET) console.warn('WEB_SECRET is not set: web logins will end on every restart. Set a long random value.');
}
