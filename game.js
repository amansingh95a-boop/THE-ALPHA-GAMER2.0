'use strict';
// Tournaments, slot booking, manual UPI deposits, withdrawals, results, leaderboard, admin API.
const CATS = [['br-survival','BR Survival','solo',48,'Bermuda'],['br-per-kill','BR Per Kill','solo',48,'Bermuda'],['cs-1v1','Clash Squad 1v1','solo',2,'Bermuda'],['cs-4v4','Clash Squad 4v4','squad',8,'Bermuda'],
  ['lw-1v1','Lone Wolf 1v1','solo',2,'Iron cage'],['lw-2v2','Lone Wolf 2v2','duo',4,'Iron cage'],['cs-headshot','CS Headshot','solo',2,'Bermuda'],['only-ump','Only UMP 1v1','solo',2,'Bermuda'],
  ['cs-challenges','CS Challenges','solo',2,'Bermuda'],['free','Free Matches','solo',48,'Bermuda']].map(([id, name, mode, slots, map]) => ({ id, name, mode, slots, map }));
const DEFAULT_RULES = '• Record your room entry and full gameplay\n• Hackers, teaming up and abusing players/host = ban\n• Enter correct in-game name and ID\n• Raise issues with customer care within 2 hours of match end';
const TEAM = { solo: 1, duo: 2, squad: 4 };
class HttpError extends Error { constructor(http, m) { super(m); this.http = http; } }
const bad = (c, m) => { throw new HttpError(c, m); };

const fs = require('node:fs'), path = require('node:path');
const IMG_URL = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/;
module.exports = function ({ db, tx, moveMoney, send, readJson, authUser, audit, routes, dyn }) {
  db.exec(`
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tournaments(id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN('solo','duo','squad')),
 map TEXT NOT NULL, entry_fee INTEGER NOT NULL CHECK(entry_fee>=0), prize_pool INTEGER NOT NULL DEFAULT 0, per_kill INTEGER NOT NULL DEFAULT 0,
 prize_text TEXT NOT NULL DEFAULT '', rules TEXT NOT NULL DEFAULT '', banner TEXT NOT NULL DEFAULT '', total_slots INTEGER NOT NULL CHECK(total_slots>0),
 starts_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN('upcoming','completed','cancelled')),
 room_id TEXT NOT NULL DEFAULT '', room_pass TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS joins(id INTEGER PRIMARY KEY, tournament_id INTEGER NOT NULL REFERENCES tournaments(id), user_id INTEGER NOT NULL REFERENCES users(id),
 paid_dep INTEGER NOT NULL, paid_win INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(tournament_id,user_id));
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, join_id INTEGER NOT NULL REFERENCES joins(id), tournament_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 slot INTEGER NOT NULL, player_name TEXT NOT NULL, player_uid TEXT NOT NULL, UNIQUE(tournament_id,slot), UNIQUE(tournament_id,player_uid));
CREATE TABLE IF NOT EXISTS deposits(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL CHECK(amount>0), utr TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')), reviewed_by INTEGER, created_at INTEGER NOT NULL, reviewed_at INTEGER);
CREATE TABLE IF NOT EXISTS withdrawals(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL CHECK(amount>0), upi TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','completed','rejected')), payout_ref TEXT, reviewed_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS results(id INTEGER PRIMARY KEY, tournament_id INTEGER NOT NULL REFERENCES tournaments(id), user_id INTEGER NOT NULL, player_uid TEXT NOT NULL,
 player_name TEXT NOT NULL, kills INTEGER NOT NULL, rank_prize INTEGER NOT NULL, total INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(tournament_id,player_uid));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'info', created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO settings VALUES('telegram_url',''),('instagram_url',''),('min_withdraw','50'),('room_mins','15'),('notice',''),('upi_id',''),('upi_name','THE ALPHA GAMER'),('qr_image',''),('whatsapp','+63 930 941 5509'),('referral_reward','5'),('referral_min_deposit','10');`);

  const setting = (k, d = '') => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? r.v : d; };
  // Referrer gets the reward ONCE per referred user, when that user's first qualifying deposit is approved.
  const grantReferralReward = tx(refereeId => {
    const r = db.prepare("SELECT * FROM referrals WHERE referee_id=? AND status='pending'").get(refereeId), amt = +setting('referral_reward', '5');
    if (!r || !(amt > 0)) return false;
    db.prepare("UPDATE referrals SET status='rewarded', reward=? WHERE id=?").run(amt, r.id);
    moveMoney(r.referrer_id, 'credit', 'deposit', amt, 'referral', 'Referral reward: friend #' + refereeId + ' made first deposit');
    return true;
  });
  const qrImage = () => setting('qr_image') || (fs.existsSync(path.join(__dirname, 'public', 'default-qr.png')) || fs.existsSync(path.join(__dirname, 'default-qr.png')) ? '/default-qr.png' : '');
  const num = (v, min, max) => { const n = Number(v); return v !== '' && v !== null && Number.isInteger(n) && n >= min && n <= max ? n : null; };
  const text = (v, min, max) => { const s = typeof v === 'string' ? v.trim() : ''; return s.length >= min && s.length <= max ? s : null; };
  const stateOf = t => t.status !== 'upcoming' ? 'completed' : Date.now() >= t.starts_at ? 'ongoing' : 'upcoming';
  const SEL = 'SELECT t.*,(SELECT COUNT(*) FROM bookings b WHERE b.tournament_id=t.id) booked FROM tournaments t';
  const card = (t, x) => ({ id: t.id, title: t.title, category: t.category, mode: t.mode, map: t.map, entryFee: t.entry_fee, prizePool: t.prize_pool, perKill: t.per_kill,
    banner: t.banner, totalSlots: t.total_slots, booked: t.booked, startsAt: t.starts_at, status: t.status, state: stateOf(t), teamSize: TEAM[t.mode], ...x });
  const need = fn => async (req, res, p) => { const u = authUser(req); if (!u) return send(res, 401, { error: 'Not logged in.' }); return fn(req, res, u, p); };
  const adminOnly = fn => need((req, res, u, p) => u.role === 'admin' ? fn(req, res, u, p) : send(res, 403, { error: 'Admins only.' }));
  const add = (m, re, fn) => dyn.push([m, re, fn]);
  const ok = res => send(res, 200, { ok: true });
  const q = req => new URL(req.url, 'http://x').searchParams;

  // ---------- public / player ----------
  routes['GET /api/config'] = async (req, res) => {
    const counts = {}; db.prepare("SELECT category c, COUNT(*) n FROM tournaments WHERE status='upcoming' AND starts_at>? GROUP BY category").all(Date.now()).forEach(r => counts[r.c] = r.n);
    const catImages = {}; CATS.forEach(c => { const v = setting('cat_img_' + c.id); if (v) catImages[c.id] = v; });
    const joined = {}; db.prepare("SELECT t.category c, COUNT(b.id) n FROM tournaments t JOIN bookings b ON b.tournament_id=t.id WHERE t.status='upcoming' GROUP BY t.category").all().forEach(r => joined[r.c] = r.n);
    const online = db.prepare('SELECT COUNT(*) n FROM users WHERE last_seen>?').get(Date.now() - 5 * 60000).n;
    send(res, 200, { categories: CATS, counts, joined, online, telegramUrl: setting('telegram_url'), instagramUrl: setting('instagram_url'), catImages, upiId: setting('upi_id'), upiName: setting('upi_name'), qrImage: qrImage(), whatsapp: setting('whatsapp'), notice: setting('notice'),
      minWithdraw: +setting('min_withdraw', '50'), referral: { reward: +setting('referral_reward', '5'), minDeposit: +setting('referral_min_deposit', '10') } });
  };
  routes['GET /api/tournaments'] = need(async (req, res, u) => {
    const cat = q(req).get('cat'), st = q(req).get('state');
    let rows = db.prepare(SEL + ' ORDER BY t.starts_at ' + (st === 'completed' ? 'DESC' : 'ASC') + ' LIMIT 300').all();
    rows = rows.filter(t => (!cat || t.category === cat) && (!st || stateOf(t) === st)).slice(0, 60);
    const joined = new Set(db.prepare('SELECT tournament_id FROM joins WHERE user_id=?').all(u.id).map(r => r.tournament_id));
    send(res, 200, { tournaments: rows.map(t => card(t, { joined: joined.has(t.id) })) });
  });
  add('GET', /^\/api\/tournaments\/(\d+)$/, need(async (req, res, u, [id]) => {
    const t = db.prepare(SEL + ' WHERE t.id=?').get(id); if (!t) return send(res, 404, { error: 'Match not found.' });
    const bk = db.prepare('SELECT slot,player_name,user_id FROM bookings WHERE tournament_id=? ORDER BY slot').all(t.id);
    const mine = bk.filter(b => b.user_id === u.id).map(b => b.slot), mins = +setting('room_mins', '15');
    const open = mine.length && t.status === 'upcoming' && t.room_id && Date.now() >= t.starts_at - mins * 60000;
    const results = t.status === 'completed' ? db.prepare('SELECT player_name name,kills,total FROM results WHERE tournament_id=? ORDER BY total DESC,kills DESC').all(t.id) : [];
    send(res, 200, { tournament: card(t, { joined: mine.length > 0, prizeText: t.prize_text, rules: t.rules, mySlots: mine, roomOpensAt: t.starts_at - mins * 60000,
      room: open ? { id: t.room_id, pass: t.room_pass } : null }), taken: bk.map(b => b.slot), players: bk.map(b => ({ slot: b.slot, name: b.player_name })), results });
  }));
  add('POST', /^\/api\/tournaments\/(\d+)\/join$/, need(async (req, res, u, [id]) => {
    const b = await readJson(req);
    try {
      const paid = tx(() => {
        const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(id); if (!t) bad(404, 'Match not found.');
        if (stateOf(t) !== 'upcoming') bad(409, 'Joining is closed for this match.');
        const ts = TEAM[t.mode], list = b.slots;
        if (!Array.isArray(list) || list.length < 1 || list.length > ts) bad(400, `Select 1 to ${ts} position(s).`);
        const seen = new Set(), seenUid = new Set(); let team = null;
        for (const s of list) {
          const slot = num(s && s.slot, 1, t.total_slots), name = text(s && s.name, 2, 24), uid = s && typeof s.uid === 'string' && /^\d{8,12}$/.test(s.uid.trim()) ? s.uid.trim() : null;
          if (!slot) bad(400, 'Invalid position.'); if (!name) bad(400, 'Enter a valid in-game name for every player.'); if (!uid) bad(400, 'In-game ID must be 8–12 digits.');
          if (seen.has(slot) || seenUid.has(uid)) bad(400, 'Duplicate position or ID.');
          const tm = Math.ceil(slot / ts); if (team !== null && tm !== team) bad(400, 'Pick positions from the same team.'); team = tm;
          seen.add(slot); seenUid.add(uid); s.slot = slot; s.name = name; s.uid = uid;
        }
        if (db.prepare('SELECT 1 FROM joins WHERE tournament_id=? AND user_id=?').get(t.id, u.id)) bad(409, 'You have already joined this match.');
        for (const s of list) if (db.prepare('SELECT 1 FROM bookings WHERE tournament_id=? AND slot=?').get(t.id, s.slot)) bad(409, 'Position ' + s.slot + ' is already taken. Pick another.');
        const cost = t.entry_fee * list.length, cur = db.prepare('SELECT deposit_bal d,win_bal w FROM users WHERE id=?').get(u.id);
        if (cur.d + cur.w < cost) bad(402, 'Not enough coins. Add money first.');
        const dep = Math.min(cur.d, cost), win = cost - dep;
        if (dep) moveMoney(u.id, 'debit', 'deposit', dep, 'entry', 'Joined match #' + t.id);
        if (win) moveMoney(u.id, 'debit', 'winning', win, 'entry', 'Joined match #' + t.id);
        const j = db.prepare('INSERT INTO joins(tournament_id,user_id,paid_dep,paid_win,created_at) VALUES(?,?,?,?,?)').run(t.id, u.id, dep, win, Date.now());
        for (const s of list) db.prepare('INSERT INTO bookings(join_id,tournament_id,user_id,slot,player_name,player_uid) VALUES(?,?,?,?,?,?)').run(j.lastInsertRowid, t.id, u.id, s.slot, s.name, s.uid);
        return cost;
      })();
      send(res, 200, { ok: true, paid });
    } catch (e) { if (!e.http && /UNIQUE/.test(e.message)) return send(res, 409, { error: 'That position or ID was just taken. Pick another.' }); throw e; }
  }));
  routes['GET /api/my-matches'] = need(async (req, res, u) => {
    const st = q(req).get('state');
    const rows = db.prepare(SEL + ' WHERE t.id IN (SELECT tournament_id FROM joins WHERE user_id=?) ORDER BY t.starts_at DESC').all(u.id);
    send(res, 200, { tournaments: rows.filter(t => !st || stateOf(t) === st).map(t => card(t, { joined: true })) });
  });
  routes['GET /api/leaderboard'] = need(async (req, res) => {
    const p = q(req).get('period'), since = p === 'weekly' ? Date.now() - 7 * 864e5 : p === 'monthly' ? Date.now() - 30 * 864e5 : 0;
    send(res, 200, { rows: db.prepare(`SELECT u.gamer_name name, SUM(r.total) won, COUNT(DISTINCT r.tournament_id) matches FROM results r JOIN users u ON u.id=r.user_id
      WHERE r.created_at>=? AND u.blocked=0 GROUP BY r.user_id HAVING won>0 ORDER BY won DESC LIMIT 50`).all(since) });
  });
  routes['GET /api/stats'] = need(async (req, res, u) => {
    const m = db.prepare('SELECT COUNT(*) n FROM joins WHERE user_id=?').get(u.id).n, r = db.prepare('SELECT COALESCE(SUM(kills),0) k, COALESCE(SUM(total),0) e FROM results WHERE user_id=?').get(u.id);
    send(res, 200, { matches: m, kills: r.k, earnings: r.e });
  });

  // ---------- deposits (manual UPI, admin approves) ----------
  routes['POST /api/deposits'] = need(async (req, res, u) => {
    const b = await readJson(req), amount = num(b.amount, 10, 10000), utr = String(b.utr || '').trim();
    if (!amount) bad(400, 'Amount must be between 10 and 10000.'); if (!/^\d{12}$/.test(utr)) bad(400, 'UTR / reference must be 12 digits.');
    if (!setting('upi_id') && !qrImage()) bad(503, 'Payments are not set up yet. Try later.');
    if (db.prepare("SELECT COUNT(*) n FROM deposits WHERE user_id=? AND status='pending'").get(u.id).n >= 5) bad(429, 'You have 5 pending requests. Wait for approval.');
    try { db.prepare('INSERT INTO deposits(user_id,amount,utr,created_at) VALUES(?,?,?,?)').run(u.id, amount, utr, Date.now()); }
    catch (e) { if (/UNIQUE/.test(e.message)) bad(409, 'This UTR was already submitted.'); throw e; }
    audit(u.id, 'deposit_request', amount + ' UTR ' + utr); ok(res);
  });
  routes['GET /api/deposits'] = need(async (req, res, u) => send(res, 200, { rows: db.prepare('SELECT id,amount,utr,status,created_at FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 20').all(u.id) }));

  // ---------- withdrawals ----------
  routes['POST /api/withdrawals'] = need(async (req, res, u) => {
    const b = await readJson(req), min = +setting('min_withdraw', '50'), amount = num(b.amount, min, 100000), upi = String(b.upi || '').trim();
    if (!amount) bad(400, `Minimum withdrawal is ${min}.`); if (!/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi)) bad(400, 'Enter a valid UPI ID.');
    if (db.prepare("SELECT COUNT(*) n FROM withdrawals WHERE user_id=? AND status IN('pending','approved')").get(u.id).n >= 3) bad(429, 'You already have pending withdrawals.');
    try {
      tx(() => { moveMoney(u.id, 'debit', 'winning', amount, 'withdraw', 'Withdrawal request'); db.prepare('INSERT INTO withdrawals(user_id,amount,upi,created_at) VALUES(?,?,?,?)').run(u.id, amount, upi, Date.now()); })();
    } catch (e) { if (!e.http && /insufficient/.test(e.message)) bad(402, 'Not enough winning balance.'); throw e; }
    audit(u.id, 'withdraw_request', amount); ok(res);
  });
  routes['GET /api/withdrawals'] = need(async (req, res, u) => send(res, 200, { rows: db.prepare('SELECT id,amount,upi,status,payout_ref,created_at FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 20').all(u.id) }));

  // ---------- admin ----------
  const parseT = (b0, old) => {
    const cat = CATS.find(c => c.id === b0.category) || {}, given = Object.fromEntries(Object.entries(b0).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const b = { title: cat.name && cat.name.toUpperCase(), mode: cat.mode, map: cat.map, totalSlots: cat.slots, perKill: 0, prizePool: 0, prizeText: '', rules: DEFAULT_RULES, banner: '', ...given };
    if (!given.prizeText && b.prizePool > 0) b.prizeText = 'Total prize pool: ' + b.prizePool;
    const t = { title: text(b.title, 3, 80), category: CATS.some(c => c.id === b.category) ? b.category : null, mode: TEAM[b.mode] ? b.mode : null, map: text(b.map, 2, 30),
      entry_fee: num(b.entryFee, 0, 10000), prize_pool: num(b.prizePool, 0, 1000000), per_kill: num(b.perKill, 0, 10000), total_slots: num(b.totalSlots, 1, 100), starts_at: num(b.startsAt, 1, 4e12),
      prize_text: typeof b.prizeText === 'string' && b.prizeText.length <= 600 ? b.prizeText.trim() : null, rules: typeof b.rules === 'string' && b.rules.length <= 3000 ? b.rules.trim() : null,
      banner: typeof b.banner === 'string' && b.banner.length <= 300 && (b.banner === '' || IMG_URL.test(b.banner.trim()) || /^\/img\/[\w.\-]+$/.test(b.banner.trim()) || /^https:\/\/\S+$/.test(b.banner.trim())) ? b.banner.trim() : null };
    for (const k in t) if (t[k] === null) bad(400, 'Check field: ' + k.replace(/_/g, ' '));
    if (t.total_slots % TEAM[t.mode]) bad(400, `Total slots must be a multiple of ${TEAM[t.mode]} for ${t.mode}.`);
    if (!old && t.starts_at < Date.now()) bad(400, 'Start time must be in the future.');
    return t;
  };
  routes['GET /api/admin/summary'] = adminOnly(async (req, res) => send(res, 200, {
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n, pendingDeposits: db.prepare("SELECT COUNT(*) n FROM deposits WHERE status='pending'").get().n,
    pendingWithdrawals: db.prepare("SELECT COUNT(*) n FROM withdrawals WHERE status IN('pending','approved')").get().n, upcoming: db.prepare("SELECT COUNT(*) n FROM tournaments WHERE status='upcoming'").get().n }));
  routes['GET /api/admin/deposits'] = adminOnly(async (req, res) => {
    const st = q(req).get('status') || 'pending';
    send(res, 200, { rows: db.prepare(`SELECT d.id,d.amount,d.utr,d.status,d.created_at,u.email,u.gamer_name FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.status=? ORDER BY d.id DESC LIMIT 100`).all(st) });
  });
  add('POST', /^\/api\/admin\/deposits\/(\d+)\/(approve|reject)$/, adminOnly(async (req, res, u, [id, act]) => {
    tx(() => {
      const d = db.prepare('SELECT * FROM deposits WHERE id=?').get(id); if (!d || d.status !== 'pending') bad(409, 'Already reviewed.');
      db.prepare('UPDATE deposits SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(act === 'approve' ? 'approved' : 'rejected', u.id, Date.now(), d.id);
      if (act === 'approve') { moveMoney(d.user_id, 'credit', 'deposit', d.amount, 'deposit', 'UTR ' + d.utr); if (d.amount >= +setting('referral_min_deposit', '10')) grantReferralReward(d.user_id); }
      audit(u.id, 'deposit_' + act, '#' + d.id + ' amount ' + d.amount);
    })(); ok(res);
  }));
  routes['GET /api/admin/withdrawals'] = adminOnly(async (req, res) => {
    const st = q(req).get('status') || 'open', where = st === 'open' ? "w.status IN('pending','approved')" : 'w.status=?';
    const rows = db.prepare(`SELECT w.id,w.amount,w.upi,w.status,w.payout_ref,w.created_at,u.email,u.gamer_name FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE ${where} ORDER BY w.id DESC LIMIT 100`).all(...(st === 'open' ? [] : [st]));
    send(res, 200, { rows });
  });
  add('POST', /^\/api\/admin\/withdrawals\/(\d+)\/(approve|complete|reject)$/, adminOnly(async (req, res, u, [id, act]) => {
    const b = await readJson(req), ref = typeof b.ref === 'string' ? b.ref.trim().slice(0, 60) : '';
    tx(() => {
      const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(id); if (!w) bad(404, 'Not found.');
      const from = { approve: ['pending'], complete: ['pending', 'approved'], reject: ['pending', 'approved'] }[act];
      if (!from.includes(w.status)) bad(409, 'Cannot do this now (status: ' + w.status + ').');
      if (act === 'complete' && !ref) bad(400, 'Enter the payout reference / UTR.');
      db.prepare('UPDATE withdrawals SET status=?,payout_ref=?,reviewed_by=?,updated_at=? WHERE id=?').run({ approve: 'approved', complete: 'completed', reject: 'rejected' }[act], ref || w.payout_ref, u.id, Date.now(), w.id);
      if (act === 'reject') moveMoney(w.user_id, 'credit', 'winning', w.amount, 'withdraw_refund', 'Withdrawal #' + w.id + ' rejected');
      audit(u.id, 'withdraw_' + act, '#' + w.id + ' amount ' + w.amount);
    })(); ok(res);
  }));
  routes['GET /api/admin/users'] = adminOnly(async (req, res) => {
    const s = '%' + String(q(req).get('q') || '').trim() + '%';
    send(res, 200, { rows: db.prepare(`SELECT id,email,gamer_name,ff_uid,role,blocked,deposit_bal,win_bal,created_at FROM users WHERE email LIKE ? OR gamer_name LIKE ? OR ff_uid LIKE ? ORDER BY id DESC LIMIT 50`).all(s, s, s) });
  });
  add('POST', /^\/api\/admin\/users\/(\d+)\/block$/, adminOnly(async (req, res, u, [id]) => {
    const b = await readJson(req), target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!target) bad(404, 'User not found.'); if (target.role === 'admin') bad(400, 'Admins cannot be blocked.');
    const v = b.blocked ? 1 : 0; db.prepare('UPDATE users SET blocked=? WHERE id=?').run(v, target.id);
    if (v) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    audit(u.id, v ? 'user_block' : 'user_unblock', '#' + target.id); ok(res);
  }));
  add('GET', /^\/api\/admin\/users\/(\d+)\/ledger$/, adminOnly(async (req, res, u, [id]) =>
    send(res, 200, { rows: db.prepare('SELECT kind,wallet,amount,balance_after,reason,note,created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100').all(id) })));
  routes['GET /api/admin/tournaments'] = adminOnly(async (req, res) => send(res, 200, { rows: db.prepare(SEL + ' ORDER BY t.starts_at DESC LIMIT 200').all()
    .map(t => card(t, { prizeText: t.prize_text, rules: t.rules, roomId: t.room_id, roomPass: t.room_pass })) }));
  routes['POST /api/admin/tournaments'] = adminOnly(async (req, res, u) => {
    const t = parseT(await readJson(req), false);
    const r = db.prepare(`INSERT INTO tournaments(title,category,mode,map,entry_fee,prize_pool,per_kill,prize_text,rules,banner,total_slots,starts_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.title, t.category, t.mode, t.map, t.entry_fee, t.prize_pool, t.per_kill, t.prize_text, t.rules, t.banner, t.total_slots, t.starts_at, Date.now());
    audit(u.id, 'tournament_create', '#' + r.lastInsertRowid); send(res, 201, { id: Number(r.lastInsertRowid) });
  });
  add('PUT', /^\/api\/admin\/tournaments\/(\d+)$/, adminOnly(async (req, res, u, [id]) => {
    const old = db.prepare(SEL + ' WHERE t.id=?').get(id); if (!old) bad(404, 'Not found.'); if (old.status !== 'upcoming') bad(409, 'This match is finished.');
    const t = parseT(await readJson(req), true);
    if (old.booked > 0 && (t.mode !== old.mode || t.entry_fee !== old.entry_fee || t.total_slots !== old.total_slots)) bad(409, 'Players already joined: mode, entry fee and slots are locked.');
    db.prepare(`UPDATE tournaments SET title=?,category=?,mode=?,map=?,entry_fee=?,prize_pool=?,per_kill=?,prize_text=?,rules=?,banner=?,total_slots=?,starts_at=? WHERE id=?`)
      .run(t.title, t.category, t.mode, t.map, t.entry_fee, t.prize_pool, t.per_kill, t.prize_text, t.rules, t.banner, t.total_slots, t.starts_at, old.id);
    audit(u.id, 'tournament_update', '#' + old.id); ok(res);
  }));
  add('DELETE', /^\/api\/admin\/tournaments\/(\d+)$/, adminOnly(async (req, res, u, [id]) => {
    const n = db.prepare('SELECT COUNT(*) n FROM joins WHERE tournament_id=?').get(id).n;
    if (n) bad(409, 'Players have joined. Use Cancel & refund instead.');
    db.prepare('DELETE FROM tournaments WHERE id=?').run(id); audit(u.id, 'tournament_delete', '#' + id); ok(res);
  }));
  add('POST', /^\/api\/admin\/tournaments\/(\d+)\/room$/, adminOnly(async (req, res, u, [id]) => {
    const b = await readJson(req), rid = text(b.roomId, 1, 30), rp = text(b.roomPass, 1, 30); if (!rid || !rp) bad(400, 'Enter Room ID and Password.');
    const r = db.prepare('UPDATE tournaments SET room_id=?,room_pass=? WHERE id=? AND status=?').run(rid, rp, id, 'upcoming'); audit(u.id, 'room_set', '#' + id);
    if (r.changes) { const t = db.prepare('SELECT title FROM tournaments WHERE id=?').get(id), mins = +setting('room_mins', '15');
      for (const j of db.prepare('SELECT user_id FROM joins WHERE tournament_id=?').all(id)) db.prepare('INSERT INTO notifications(user_id,title,body,kind,created_at) VALUES(?,?,?,?,?)')
        .run(j.user_id, 'Room details · ' + t.title + ' #' + id, `Room ID: ${rid}\nPassword: ${rp}\n(Also shown inside the match page ${mins} min before start.)`, 'room', Date.now()); }
    ok(res);
  }));
  add('GET', /^\/api\/admin\/tournaments\/(\d+)\/players$/, adminOnly(async (req, res, u, [id]) => send(res, 200, { rows:
    db.prepare(`SELECT b.slot,b.player_name,b.player_uid,u.email,u.gamer_name,u.mobile FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.tournament_id=? ORDER BY b.slot`).all(id) })));
  add('POST', /^\/api\/admin\/tournaments\/(\d+)\/cancel$/, adminOnly(async (req, res, u, [id]) => {
    tx(() => {
      const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(id); if (!t || t.status !== 'upcoming') bad(409, 'Cannot cancel this match.');
      for (const j of db.prepare('SELECT * FROM joins WHERE tournament_id=?').all(t.id)) {
        if (j.paid_dep) moveMoney(j.user_id, 'credit', 'deposit', j.paid_dep, 'refund', 'Match #' + t.id + ' cancelled');
        if (j.paid_win) moveMoney(j.user_id, 'credit', 'winning', j.paid_win, 'refund', 'Match #' + t.id + ' cancelled');
      }
      db.prepare("UPDATE tournaments SET status='cancelled' WHERE id=?").run(t.id); audit(u.id, 'tournament_cancel', '#' + t.id);
    })(); ok(res);
  }));
  add('POST', /^\/api\/admin\/tournaments\/(\d+)\/results$/, adminOnly(async (req, res, u, [id]) => {
    const b = await readJson(req);
    const paid = tx(() => {
      const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(id); if (!t) bad(404, 'Not found.');
      if (t.status !== 'upcoming') bad(409, 'Results already published or match cancelled.'); if (Date.now() < t.starts_at) bad(409, 'Match has not started yet.');
      if (!Array.isArray(b.rows) || !b.rows.length) bad(400, 'Add at least one result row.');
      const seen = new Set(); let sum = 0;
      for (const r of b.rows) {
        const uid = String(r.uid || ''), kills = num(r.kills, 0, 100), rp = num(r.rankPrize, 0, 1000000); if (kills === null || rp === null) bad(400, 'Kills and prize must be whole numbers.');
        if (seen.has(uid)) bad(400, 'Duplicate player in results.'); seen.add(uid);
        const bk = db.prepare('SELECT * FROM bookings WHERE tournament_id=? AND player_uid=?').get(t.id, uid); if (!bk) bad(400, 'UID ' + uid + ' did not join this match.');
        const total = rp + kills * t.per_kill;
        db.prepare('INSERT INTO results(tournament_id,user_id,player_uid,player_name,kills,rank_prize,total,created_at) VALUES(?,?,?,?,?,?,?,?)').run(t.id, bk.user_id, uid, bk.player_name, kills, rp, total, Date.now());
        if (total > 0) moveMoney(bk.user_id, 'credit', 'winning', total, 'prize', 'Match #' + t.id + ' · ' + bk.player_name); sum += total;
      }
      db.prepare("UPDATE tournaments SET status='completed' WHERE id=?").run(t.id); audit(u.id, 'results_publish', '#' + t.id + ' paid ' + sum); return sum;
    })();
    send(res, 200, { ok: true, paid });
  }));
  routes['GET /api/admin/settings'] = adminOnly(async (req, res) => {
    const catImages = {}; CATS.forEach(c => { const v = setting('cat_img_' + c.id); if (v) catImages[c.id] = v; });
    send(res, 200, { upiId: setting('upi_id'), upiName: setting('upi_name'), qrImage: qrImage(), catImages, categories: CATS, whatsapp: setting('whatsapp'), telegramUrl: setting('telegram_url'), instagramUrl: setting('instagram_url'), notice: setting('notice'),
      minWithdraw: +setting('min_withdraw'), roomMins: +setting('room_mins'), referralReward: +setting('referral_reward'), referralMinDeposit: +setting('referral_min_deposit') });
  });
  routes['PUT /api/admin/settings'] = adminOnly(async (req, res, u) => {
    const b = await readJson(req), set = (k, v) => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
    if (b.upiId !== undefined) { const v = String(b.upiId).trim(); if (v && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(v)) bad(400, 'Invalid UPI ID.'); set('upi_id', v); }
    if (b.upiName !== undefined) set('upi_name', String(b.upiName).trim().slice(0, 40));
    if (b.notice !== undefined) set('notice', String(b.notice).trim().slice(0, 300));
    if (b.minWithdraw !== undefined) { const n = num(b.minWithdraw, 10, 100000); if (!n) bad(400, 'Minimum withdrawal: 10–100000.'); set('min_withdraw', n); }
    if (b.roomMins !== undefined) { const n = num(b.roomMins, 0, 120); if (n === null) bad(400, 'Room minutes: 0–120.'); set('room_mins', n); }
    if (b.qrImage !== undefined) { if (b.qrImage !== '' && !IMG_URL.test(b.qrImage)) bad(400, 'Invalid QR image.'); set('qr_image', b.qrImage); }
    if (b.catImages && typeof b.catImages === 'object') for (const [id, v] of Object.entries(b.catImages)) { if (!CATS.some(c => c.id === id) || (v !== '' && !IMG_URL.test(v))) bad(400, 'Invalid category image.'); set('cat_img_' + id, v); }
    for (const [k, col] of [['telegramUrl', 'telegram_url'], ['instagramUrl', 'instagram_url']]) if (b[k] !== undefined) { const v = String(b[k]).trim(); if (v && !/^https:\/\/\S{4,200}$/.test(v)) bad(400, 'Link must start with https://'); set(col, v); }
    if (b.whatsapp !== undefined) { const v = String(b.whatsapp).trim(); if (!/^\+?[\d ]{8,20}$/.test(v)) bad(400, 'WhatsApp number: digits with country code, e.g. +63 930 941 5509'); set('whatsapp', v); }
    if (b.referralReward !== undefined) { const n = num(b.referralReward, 0, 1000); if (n === null) bad(400, 'Referral reward: 0–1000.'); set('referral_reward', n); }
    if (b.referralMinDeposit !== undefined) { const n = num(b.referralMinDeposit, 1, 10000); if (!n) bad(400, 'Referral minimum deposit: 1–10000.'); set('referral_min_deposit', n); }
    audit(u.id, 'settings_update', Object.keys(b).join(',')); ok(res);
  });
  routes['GET /api/admin/logs'] = adminOnly(async (req, res) => send(res, 200, { rows: db.prepare('SELECT a.id,a.action,a.detail,a.created_at,u.email FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 150').all() }));
  return { grantReferralReward, setting, need, adminOnly, add, ok, q, num, text, CATS, TEAM, HttpError, bad, IMG_URL, stateOf, SEL, card };
};
