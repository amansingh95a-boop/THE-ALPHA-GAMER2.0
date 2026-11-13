'use strict';
// THE ALPHA GAMER backend — zero npm dependencies (Node 22+). Auth, profile, referral codes, wallet ledger base.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const mail = require('./mail.js');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname; // on Render/VPS: point this to a PERSISTENT disk (database + uploaded images live here)
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'alpha.db');
const PROD = process.env.NODE_ENV === 'production';
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || 'ghatwindow@gmail.com').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
const UPLOADS = path.join(DATA_DIR, 'uploads'); fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_UPLOAD = 20 * 1024 * 1024; // 20 MB per image
const SESSION_DAYS = 30;

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  gamer_name TEXT NOT NULL, ff_uid TEXT NOT NULL UNIQUE, ref_code TEXT NOT NULL UNIQUE,
  referred_by INTEGER REFERENCES users(id), role TEXT NOT NULL DEFAULT 'user' CHECK(role IN('user','admin')),
  blocked INTEGER NOT NULL DEFAULT 0, deposit_bal INTEGER NOT NULL DEFAULT 0 CHECK(deposit_bal>=0),
  win_bal INTEGER NOT NULL DEFAULT 0 CHECK(win_bal>=0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN('credit','debit')),
  wallet TEXT NOT NULL CHECK(wallet IN('deposit','winning')), amount INTEGER NOT NULL CHECK(amount>0),
  balance_after INTEGER NOT NULL, reason TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS referrals(
  id INTEGER PRIMARY KEY, referrer_id INTEGER NOT NULL REFERENCES users(id), referee_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','rewarded')), reward INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS otps(id INTEGER PRIMARY KEY, email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
for (const sql of ['ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN mobile TEXT', 'ALTER TABLE users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN notif_seen INTEGER NOT NULL DEFAULT 0', 'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_mobile ON users(mobile) WHERE mobile IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_gname ON users(lower(gamer_name))']) { try { db.exec(sql); } catch {} }

// ---------- helpers ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
const DUMMY = hashPw('dummy-password');
const checkPw = (pw, stored) => {
  const [salt, h] = stored.split('$'); const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const makeCode = () => 'AG' + Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
const audit = (actor, action, detail) => db.prepare('INSERT INTO audit_log(actor_id,action,detail) VALUES(?,?,?)').run(actor, action, detail ? String(detail) : null);
let depth = 0; // nested calls use savepoints so wallet moves can run inside bigger transactions
const tx = fn => (...a) => {
  const sp = 'sp' + depth; db.exec(depth ? 'SAVEPOINT ' + sp : 'BEGIN IMMEDIATE'); depth++;
  try { const r = fn(...a); depth--; db.exec(depth ? 'RELEASE ' + sp : 'COMMIT'); return r; }
  catch (e) { depth--; db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK'); throw e; }
};

// wallet primitive: every balance change goes through here and writes the ledger. Never overdraws.
const moveMoney = tx((userId, kind, wallet, amount, reason, note) => {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('bad amount');
  const col = wallet === 'deposit' ? 'deposit_bal' : 'win_bal', sign = kind === 'credit' ? '+' : '-';
  const r = db.prepare(`UPDATE users SET ${col}=${col}${sign}? WHERE id=? AND (?='credit' OR ${col}>=?)`).run(amount, userId, kind, amount);
  if (!r.changes) throw new Error('insufficient balance');
  const bal = db.prepare(`SELECT ${col} b FROM users WHERE id=?`).get(userId).b;
  db.prepare('INSERT INTO ledger(user_id,kind,wallet,amount,balance_after,reason,note) VALUES(?,?,?,?,?,?,?)').run(userId, kind, wallet, amount, bal, reason, note || null);
  return bal;
});
const publicUser = u => ({
  id: u.id, email: u.email, mobile: u.mobile || '', gamerName: u.gamer_name, ffUid: u.ff_uid, refCode: u.ref_code, role: u.role,
  wallet: { deposit: u.deposit_bal, winning: u.win_bal, total: u.deposit_bal + u.win_bal },
  referrals: db.prepare('SELECT COUNT(*) c FROM referrals WHERE referrer_id=?').get(u.id).c
});

const normMobile = v => { let d = String(v == null ? '' : v).replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d[0] === '0') d = d.slice(1); return /^[6-9]\d{9}$/.test(d) ? d : null; };
const V = {
  mobile: m => normMobile(m) !== null,
  email: e => typeof e === 'string' && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e),
  password: p => typeof p === 'string' && p.length >= 8 && p.length <= 100,
  name: n => typeof n === 'string' && /^[A-Za-z0-9_. ]{3,20}$/.test(n.trim()),
  uid: u => typeof u === 'string' && /^\d{8,12}$/.test(u)
};

// login throttling: 5 failures / 15 min per ip+email
const fails = new Map();
const throttled = k => { const f = fails.get(k); return f && f.n >= 5 && Date.now() - f.t < 900000; };
const noteFail = k => { const f = fails.get(k); fails.set(k, f && Date.now() - f.t < 900000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${PROD ? '; Secure' : ''}`);
}
const clearCookie = res => res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${PROD ? '; Secure' : ''}`);
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
function authUser(req) {
  const t = cookie(req).sid; if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha(t));
  if (!s || s.expires_at < Date.now()) return null;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  if (u && !u.blocked && Date.now() - u.last_seen > 60000) { u.last_seen = Date.now(); db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(u.last_seen, u.id); }
  return u && !u.blocked ? u : null;
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readJson = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 61440) { no(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('bad json')); } });
});

// ---------- routes ----------
// ---------- OTP (6 digits, hashed, 10 min, 5 tries, 60s resend gap, 5 per hour) ----------
const OTP_MSG = c => `Your THE ALPHA GAMER OTP is ${c}. It is valid for 10 minutes. Never share it with anyone.`;
function issueOtp(email, purpose) {
  const now = Date.now();
  const last = db.prepare('SELECT created_at FROM otps WHERE email=? AND purpose=? ORDER BY id DESC LIMIT 1').get(email, purpose);
  if (last && now - last.created_at < 60000) return null;
  if (db.prepare('SELECT COUNT(*) n FROM otps WHERE email=? AND created_at>?').get(email, now - 3600e3).n >= 5) return null;
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare('UPDATE otps SET used=1 WHERE email=? AND purpose=?').run(email, purpose);
  db.prepare('INSERT INTO otps(email,purpose,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(email, purpose, sha(code + ':' + email + ':' + purpose), now + 600000, now);
  return code;
}
function checkOtp(email, purpose, code) {
  const r = db.prepare('SELECT * FROM otps WHERE email=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1').get(email, purpose);
  if (!r || r.expires_at < Date.now()) return false;
  if (r.attempts >= 5) { db.prepare('UPDATE otps SET used=1 WHERE id=?').run(r.id); return false; }
  db.prepare('UPDATE otps SET attempts=attempts+1 WHERE id=?').run(r.id);
  const a = Buffer.from(r.code_hash), b = Buffer.from(sha(String(code || '').trim() + ':' + email + ':' + purpose));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  db.prepare('UPDATE otps SET used=1 WHERE id=?').run(r.id); return true;
}
const sendOtp = async (email, code, what) => { try { await mail.send({ to: email, subject: 'THE ALPHA GAMER ' + what + ' OTP', text: OTP_MSG(code) }); } catch (e) { console.error('OTP mail failed:', e.message); } };

const routes = {
  'POST /api/register': async (req, res) => {
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.gamerName || '').trim(), uid = String(b.ffUid || '').trim();
    if (!V.email(email)) return send(res, 400, { error: 'Enter a valid email.' });
    if (!V.password(b.password)) return send(res, 400, { error: 'Password must be 8–100 characters.' });
    if (!V.name(name)) return send(res, 400, { error: 'Gamer name: 3–20 letters, numbers, space, _ or .' });
    if (!V.uid(uid)) return send(res, 400, { error: 'Free Fire UID must be 8–12 digits.' });
    const mobile = normMobile(b.mobile); if (!mobile) return send(res, 400, { error: 'Enter a valid 10-digit Indian mobile number.' });
    if (db.prepare('SELECT 1 FROM users WHERE lower(gamer_name)=lower(?)').get(name)) return send(res, 409, { error: 'This gamer name is already taken. Choose another.' });
    if (db.prepare('SELECT 1 FROM users WHERE mobile=?').get(mobile)) return send(res, 409, { error: 'This mobile number is already registered.' });
    let referrer = null;
    if (b.refCode) {
      referrer = db.prepare('SELECT id FROM users WHERE ref_code=? AND blocked=0').get(String(b.refCode).trim().toUpperCase());
      if (!referrer) return send(res, 400, { error: 'Referral code not found.' });
    }
    const pwHash = hashPw(b.password);
    for (let i = 0; i < 5; i++) {
      try {
        const id = tx(() => {
          const r = db.prepare('INSERT INTO users(email,pass_hash,gamer_name,ff_uid,ref_code,referred_by,mobile,notif_seen) VALUES(?,?,?,?,?,?,?,(SELECT COALESCE(MAX(id),0) FROM notifications))')
            .run(email, pwHash, name, uid, makeCode(), referrer ? referrer.id : null, mobile);
          if (referrer) db.prepare('INSERT INTO referrals(referrer_id,referee_id) VALUES(?,?)').run(referrer.id, r.lastInsertRowid);
          audit(r.lastInsertRowid, 'register');
          return Number(r.lastInsertRowid);
        })();
        createSession(res, id);
        return send(res, 201, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
      } catch (e) {
        const m = String(e.message);
        if (m.includes('users.email')) return send(res, 409, { error: 'This email is already registered.' });
        if (m.includes('users.ff_uid')) return send(res, 409, { error: 'This Free Fire UID is already registered.' });
        if (m.includes('mobile')) return send(res, 409, { error: 'This mobile number is already registered.' });
        if (m.includes('gname') || m.includes('gamer_name')) return send(res, 409, { error: 'This gamer name is already taken. Choose another.' });
        if (!m.includes('users.ref_code')) throw e; // ref code clash: retry with a new code
      }
    }
    send(res, 500, { error: 'Could not create account. Try again.' });
  },
  'POST /api/login': async (req, res) => {
    const b = await readJson(req), email = String(b.email || '').trim().toLowerCase();
    const key = req.socket.remoteAddress + '|' + email;
    if (throttled(key)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const ok = checkPw(String(b.password || ''), u ? u.pass_hash : DUMMY) && u;
    if (!ok) { noteFail(key); return send(res, 401, { error: 'Wrong email or password.' }); }
    if (u.blocked) return send(res, 403, { error: 'This account is blocked. Contact support.' });
    fails.delete(key); createSession(res, u.id); audit(u.id, 'login');
    send(res, 200, { user: publicUser(u) });
  },
  'POST /api/forgot': async (req, res) => {
    const email = String((await readJson(req)).email || '').trim().toLowerCase();
    const u = V.email(email) && db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (u && !u.blocked) { const code = issueOtp(email, 'reset'); if (code) await sendOtp(email, code, 'password reset'); }
    send(res, 200, { ok: true, message: 'If this email is registered, an OTP has been sent. Check your inbox (and spam). You can ask again after 60 seconds.' });
  },
  'POST /api/reset': async (req, res) => {
    const b = await readJson(req), email = String(b.email || '').trim().toLowerCase();
    if (!V.password(b.password)) return send(res, 400, { error: 'New password must be 8–100 characters.' });
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || u.blocked || !checkOtp(email, 'reset', b.otp)) return send(res, 400, { error: 'Wrong or expired OTP.' });
    db.prepare('UPDATE users SET pass_hash=?, email_verified=1 WHERE id=?').run(hashPw(b.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); audit(u.id, 'password_reset'); send(res, 200, { ok: true });
  },
  // Admin login: Gmail listed in ADMIN_EMAILS + its password. Others are refused.
  'POST /api/admin/login': async (req, res) => {
    const b = await readJson(req), email = String(b.email || '').trim().toLowerCase(), key = req.socket.remoteAddress + '|' + email;
    if (throttled(key)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!(checkPw(String(b.password || ''), u ? u.pass_hash : DUMMY) && u)) { noteFail(key); return send(res, 401, { error: 'Wrong email or password.' }); }
    if (u.blocked) return send(res, 403, { error: 'This account is blocked.' });
    fails.delete(key);
    if (u.role !== 'admin') { // listed Gmail + correct password => admin (first login promotes it)
      if (!ADMIN_EMAILS.has(email)) return send(res, 403, { error: 'This account is not an admin.' });
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(u.id); audit(u.id, 'admin_granted', email); u.role = 'admin';
    }
    createSession(res, u.id); audit(u.id, 'admin_login'); send(res, 200, { user: publicUser(u) });
  },
  'POST /api/logout': async (req, res) => {
    const t = cookie(req).sid; if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t));
    clearCookie(res); send(res, 200, { ok: true });
  },
  'GET /api/me': async (req, res) => {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Not logged in.' });
    send(res, 200, { user: publicUser(u) });
  },
  'PUT /api/profile': async (req, res) => {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Not logged in.' });
    const b = await readJson(req), name = String(b.gamerName ?? u.gamer_name).trim(), uid = String(b.ffUid ?? u.ff_uid).trim();
    if (!V.name(name)) return send(res, 400, { error: 'Gamer name: 3–20 letters, numbers, space, _ or .' });
    if (!V.uid(uid)) return send(res, 400, { error: 'Free Fire UID must be 8–12 digits.' });
    let mobile = u.mobile;
    if (b.mobile !== undefined && String(b.mobile).trim() !== '') {
      const m = normMobile(b.mobile); if (!m) return send(res, 400, { error: 'Enter a valid 10-digit Indian mobile number.' });
      if (u.mobile && u.mobile !== m) return send(res, 400, { error: 'Mobile number cannot be changed. Contact support.' }); mobile = m;
    }
    try { db.prepare('UPDATE users SET gamer_name=?, ff_uid=?, mobile=? WHERE id=?').run(name, uid, mobile, u.id); }
    catch (e) { const m = String(e.message);
      if (m.includes('ff_uid')) return send(res, 409, { error: 'This Free Fire UID is already registered.' });
      if (m.includes('mobile')) return send(res, 409, { error: 'This mobile number is already registered.' });
      if (m.includes('gname') || m.includes('gamer_name')) return send(res, 409, { error: 'This gamer name is already taken.' }); throw e; }
    audit(u.id, 'profile_update');
    send(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
  },
  'POST /api/password': async (req, res) => {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Not logged in.' });
    const b = await readJson(req);
    if (!checkPw(String(b.current || ''), u.pass_hash)) return send(res, 401, { error: 'Current password is wrong.' });
    if (!V.password(b.next)) return send(res, 400, { error: 'New password must be 8–100 characters.' });
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPw(b.next), u.id);
    const keep = sha(cookie(req).sid); db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id, keep);
    audit(u.id, 'password_change'); send(res, 200, { ok: true });
  },
  'GET /api/wallet': async (req, res) => {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'Not logged in.' });
    send(res, 200, { wallet: publicUser(u).wallet, history: db.prepare('SELECT id,kind,wallet,amount,balance_after,reason,note,created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id) });
  }
};

const dyn = [];
const game = require('./game.js')({ db, tx, moveMoney, send, readJson, authUser, audit, routes, dyn });
require('./extra.js')({ db, tx, moveMoney, send, readJson, authUser, audit, routes, dyn, normMobile, ...game });

const imgType = b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF ? 'jpg' : b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) ? 'png'
  : b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp' : null;
const readRaw = (req, max) => new Promise((ok, no) => {
  const tooBig = () => no(Object.assign(new Error('Image too large (max 20 MB).'), { http: 413 }));
  if ((+req.headers['content-length'] || 0) > max) return tooBig();
  const ch = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > max) { tooBig(); req.destroy(); } else ch.push(c); });
  req.on('end', () => ok(Buffer.concat(ch))); req.on('error', no);
});
const MIME = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PUB = path.join(__dirname, 'public');
// App pages live in ./public. If you can only upload files (not folders), index.html, admin.html and default-qr.png may sit next to server.js instead.
const ROOT_OK = new Set(['index.html', 'admin.html', 'default-qr.png']);
function pubFile(rel) {
  const a = path.normalize(path.join(PUB, rel));
  if (a.startsWith(PUB) && fs.existsSync(a) && fs.statSync(a).isFile()) return a;
  if (ROOT_OK.has(rel)) { const b = path.join(__dirname, rel); if (fs.existsSync(b)) return b; }
  return null;
}
if (!pubFile('index.html')) console.error('WARNING: index.html not found. Upload the "public" folder (or put index.html + admin.html next to server.js).');
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://x'), key = req.method + ' ' + url.pathname;
  try {
    if (url.pathname.startsWith('/api/')) {
      if (key === 'POST /api/admin/upload') { // raw image body (JPG/PNG/WEBP, up to 20 MB), admin only
        const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return send(res, 403, { error: 'Bad origin.' });
        const au = authUser(req); if (!au || au.role !== 'admin') return send(res, 403, { error: 'Admins only.' });
        const buf = await readRaw(req, MAX_UPLOAD), ext = imgType(buf);
        if (!buf.length || !ext) return send(res, 415, { error: 'Only JPG, PNG or WEBP images are allowed.' });
        const name = crypto.randomBytes(16).toString('hex') + '.' + ext; fs.writeFileSync(path.join(UPLOADS, name), buf);
        audit(au.id, 'image_upload', name + ' ' + buf.length + ' bytes'); return send(res, 201, { url: '/uploads/' + name });
      }
      if (req.method !== 'GET') { // CSRF: same-origin only + JSON only
        const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return send(res, 403, { error: 'Bad origin.' });
        if (!(req.headers['content-type'] || '').startsWith('application/json') && key !== 'POST /api/logout') return send(res, 415, { error: 'JSON only.' });
      }
      let h = routes[key], params = [];
      if (!h) for (const [m, re, fn] of dyn) { if (m === req.method) { const mm = re.exec(url.pathname); if (mm) { h = fn; params = mm.slice(1); break; } } }
      return h ? await h(req, res, params) : send(res, 404, { error: 'Not found.' });
    }
    const um = /^\/uploads\/([a-f0-9]{32}\.(jpg|png|webp))$/.exec(url.pathname);
    if (um) {
      const uf = path.join(UPLOADS, um[1]); if (!fs.existsSync(uf)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME['.' + um[2]], 'Cache-Control': 'public, max-age=31536000, immutable' }); return fs.createReadStream(uf).pipe(res);
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html' : url.pathname.replace(/^\/+/, '');
    const f = pubFile(rel) || pubFile('index.html');
    if (!f) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('App files missing on the server: upload the "public" folder (index.html, admin.html).'); }
    const st = fs.createReadStream(f); st.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); st.pipe(res);
  } catch (e) { if (e.http) { if (e.http === 413) res.setHeader('Connection', 'close'); return send(res, e.http, { error: e.message }); } console.error(e); if (!res.headersSent) send(res, e.message === 'bad json' ? 400 : 500, { error: e.message === 'bad json' ? 'Bad request.' : 'Server error.' }); }
});

if (process.argv[2] === '--make-admin') { // node server.js --make-admin you@gmail.com
  const r = db.prepare("UPDATE users SET role='admin' WHERE email=?").run(String(process.argv[3] || '').toLowerCase());
  console.log(r.changes ? 'Admin set.' : 'No user with that email. Register first.'); process.exit(0);
}
module.exports = { server, db, moveMoney, grantReferralReward: game.grantReferralReward, mail };
if (require.main === module) server.listen(PORT, () => console.log('THE ALPHA GAMER on http://localhost:' + PORT));
