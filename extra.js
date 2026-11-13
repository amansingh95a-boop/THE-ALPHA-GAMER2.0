'use strict';
// Events slider, notifications, admin histories, admin credit-by-mobile, editable pages, richer stats + leaderboard.
// (Routes defined here override older versions in game.js/server.js with the same path.)
const PAGE_DEFAULTS = {
  faq: 'Q: How do I join a match?\nA: Open a game, tap Join, pick your position, add your in-game name and ID, then press Join. The entry fee is taken from your wallet.\n\nQ: How do I add money?\nA: Wallet > Add money. Pay by UPI/QR, then enter the 12-digit UTR. Coins are added after we verify your payment.\n\nQ: When do I get Room ID and password?\nA: Only joined players see it, a few minutes before the match starts. Turn on Important Notice in Menu to get it as an alert.\n\nQ: How do I withdraw?\nA: Wallet > Withdraw. Only your Winning balance can be withdrawn.',
  about: 'THE ALPHA GAMER is a Free Fire tournament app. Join matches, play fair, win rewards. For help use Menu > Contact Us.',
  privacy: 'We collect your email, mobile number, Free Fire name and ID to run matches, wallet and support. We do not sell your data. Passwords are stored encrypted. Contact us to delete your account.\n\n(Admin: edit this text in Admin > Settings > Pages.)',
  terms: '• You must record your room entry and gameplay for every match.\n• Hackers, teaming up and abusing players or hosts will be banned and prizes may be withheld.\n• One account per person: one Gmail, one mobile number, one Free Fire ID.\n• Entry fees are non-refundable unless the match is cancelled by us.\n• Prizes and rules can be changed by THE ALPHA GAMER.\n\n(Admin: edit this text in Admin > Settings > Pages.)'
};
module.exports = function ({ db, tx, moveMoney, send, readJson, authUser, audit, routes, dyn, normMobile, setting, need, adminOnly, add, ok, q, num, text, bad, IMG_URL }) {
  db.exec(`CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, title TEXT NOT NULL, image TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);`);
  const set = (k, v) => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
  const pageOf = k => { const v = setting('page_' + k, ''); return v || PAGE_DEFAULTS[k]; };
  const period = p => p === 'weekly' ? Date.now() - 7 * 864e5 : p === 'monthly' ? Date.now() - 30 * 864e5 : p === 'yearly' ? Date.now() - 365 * 864e5 : 0;

  // ---- events slider (public read, admin edit)
  const evBody = b => {
    const e = { title: text(b.title, 2, 80), image: b.image == null || b.image === '' || IMG_URL.test(String(b.image)) ? String(b.image || '') : null, link: b.link === '' || /^https:\/\/\S{4,300}$/.test(String(b.link || '')) ? String(b.link || '') : null,
      description: typeof b.description === 'string' && b.description.length <= 600 ? b.description.trim() : '', sort_order: num(b.sortOrder ?? 0, -1000, 1000), active: b.active === false || b.active === 0 ? 0 : 1 };
    if (e.title === null) bad(400, 'Event title is required (2–80 characters).'); if (e.image === null) bad(400, 'Invalid event image. Use the upload button.');
    if (e.link === null) bad(400, 'Link must start with https:// (Telegram, Instagram, WhatsApp, website…).'); if (e.sort_order === null) bad(400, 'Order must be a whole number.'); return e;
  };
  routes['GET /api/events'] = async (req, res) => send(res, 200, { events: db.prepare('SELECT id,title,image,link,description FROM events WHERE active=1 ORDER BY sort_order,id DESC LIMIT 20').all() });
  routes['GET /api/admin/events'] = adminOnly(async (req, res) => send(res, 200, { rows: db.prepare('SELECT * FROM events ORDER BY sort_order,id DESC').all() }));
  routes['POST /api/admin/events'] = adminOnly(async (req, res, u) => { const e = evBody(await readJson(req));
    const r = db.prepare('INSERT INTO events(title,image,link,description,sort_order,active,created_at) VALUES(?,?,?,?,?,?,?)').run(e.title, e.image, e.link, e.description, e.sort_order, e.active, Date.now()); audit(u.id, 'event_create', e.title); send(res, 201, { id: Number(r.lastInsertRowid) }); });
  add('PUT', /^\/api\/admin\/events\/(\d+)$/, adminOnly(async (req, res, u, [id]) => { const e = evBody(await readJson(req));
    db.prepare('UPDATE events SET title=?,image=?,link=?,description=?,sort_order=?,active=? WHERE id=?').run(e.title, e.image, e.link, e.description, e.sort_order, e.active, id); audit(u.id, 'event_update', '#' + id); ok(res); }));
  add('DELETE', /^\/api\/admin\/events\/(\d+)$/, adminOnly(async (req, res, u, [id]) => { db.prepare('DELETE FROM events WHERE id=?').run(id); audit(u.id, 'event_delete', '#' + id); ok(res); }));

  // ---- notifications (room details are sent automatically to joined players only; admin can broadcast)
  routes['GET /api/notifications'] = need(async (req, res, u) => {
    const rows = db.prepare('SELECT id,title,body,kind,created_at FROM notifications WHERE user_id=? OR user_id IS NULL ORDER BY id DESC LIMIT 50').all(u.id);
    send(res, 200, { rows, unread: rows.filter(r => r.id > u.notif_seen).length, latest: rows.length ? rows[0].id : 0 });
  });
  routes['POST /api/notifications/seen'] = need(async (req, res, u) => { db.prepare('UPDATE users SET notif_seen=(SELECT COALESCE(MAX(id),0) FROM notifications WHERE user_id=? OR user_id IS NULL) WHERE id=?').run(u.id, u.id); ok(res); });
  routes['POST /api/admin/notify'] = adminOnly(async (req, res, u) => { const b = await readJson(req), t = text(b.title, 2, 80), m = text(b.body, 2, 500); if (!t || !m) bad(400, 'Enter title and message.');
    db.prepare('INSERT INTO notifications(user_id,title,body,kind,created_at) VALUES(NULL,?,?,?,?)').run(t, m, 'announcement', Date.now()); audit(u.id, 'broadcast', t); ok(res); });

  // ---- admin: users (with mobile), add money by mobile
  routes['GET /api/admin/users'] = adminOnly(async (req, res) => {
    const s = '%' + String(q(req).get('q') || '').trim() + '%';
    send(res, 200, { rows: db.prepare(`SELECT id,email,mobile,gamer_name,ff_uid,role,blocked,deposit_bal,win_bal,created_at,last_seen FROM users WHERE email LIKE ? OR gamer_name LIKE ? OR ff_uid LIKE ? OR mobile LIKE ? ORDER BY id DESC LIMIT 60`).all(s, s, s, s) });
  });
  routes['POST /api/admin/credit'] = adminOnly(async (req, res, u) => {
    const b = await readJson(req), m = normMobile(b.mobile), amount = num(b.amount, 1, 100000), note = String(b.note || '').trim().slice(0, 80);
    if (!m) bad(400, 'Enter a valid 10-digit mobile number.'); if (!amount) bad(400, 'Amount must be 1 to 100000.');
    const target = db.prepare('SELECT * FROM users WHERE mobile=?').get(m); if (!target) bad(404, 'No player found with this mobile number.'); if (target.blocked) bad(409, 'This player is blocked.');
    const bal = moveMoney(target.id, 'credit', 'deposit', amount, 'admin_credit', 'Added by admin' + (note ? ': ' + note : ''));
    audit(u.id, 'admin_credit', `${amount} to ${target.gamer_name} (${m})`); send(res, 200, { ok: true, gamerName: target.gamer_name, balance: bal });
  });

  // ---- admin: histories (separate deposit / withdrawal), filter by days, status, text
  const hist = (req, kind) => {
    const days = num(q(req).get('days') || 0, 0, 3650) || 0, since = days ? Date.now() - days * 864e5 : 0, st = q(req).get('status') || 'all', s = '%' + String(q(req).get('q') || '').trim() + '%';
    if (kind === 'deposits') {
      const rows = db.prepare(`SELECT d.id,d.amount,d.utr,d.status,d.created_at,d.reviewed_at,u.gamer_name,u.email,u.mobile,u.ff_uid,'upi' src FROM deposits d JOIN users u ON u.id=d.user_id
        WHERE d.created_at>=? AND (?='all' OR d.status=?) AND (u.gamer_name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ? OR d.utr LIKE ?)`).all(since, st, st, s, s, s, s);
      const adm = st === 'all' || st === 'approved' ? db.prepare(`SELECT l.id,l.amount,l.note utr,'approved' status,CAST(strftime('%s',l.created_at) AS INTEGER)*1000 created_at,NULL reviewed_at,u.gamer_name,u.email,u.mobile,u.ff_uid,'admin' src
        FROM ledger l JOIN users u ON u.id=l.user_id WHERE l.reason='admin_credit' AND CAST(strftime('%s',l.created_at) AS INTEGER)*1000>=? AND (u.gamer_name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ?)`).all(since, s, s, s) : [];
      const all = rows.concat(adm).sort((a, b) => b.created_at - a.created_at).slice(0, 300);
      return { rows: all, total: all.filter(r => r.status === 'approved').reduce((a, r) => a + r.amount, 0), count: all.length };
    }
    const rows = db.prepare(`SELECT w.id,w.amount,w.upi,w.status,w.payout_ref,w.created_at,w.updated_at,u.gamer_name,u.email,u.mobile,u.ff_uid FROM withdrawals w JOIN users u ON u.id=w.user_id
      WHERE w.created_at>=? AND (?='all' OR w.status=?) AND (u.gamer_name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ? OR w.upi LIKE ? OR COALESCE(w.payout_ref,'') LIKE ?) ORDER BY w.id DESC LIMIT 300`).all(since, st, st, s, s, s, s, s);
    return { rows, total: rows.filter(r => r.status === 'completed').reduce((a, r) => a + r.amount, 0), count: rows.length };
  };
  routes['GET /api/admin/history/deposits'] = adminOnly(async (req, res) => send(res, 200, hist(req, 'deposits')));
  routes['GET /api/admin/history/withdrawals'] = adminOnly(async (req, res) => send(res, 200, hist(req, 'withdrawals')));
  routes['GET /api/admin/summary'] = adminOnly(async (req, res) => {
    const day = Date.now() - 864e5, n = (sql, ...a) => db.prepare(sql).get(...a).n;
    send(res, 200, { users: n('SELECT COUNT(*) n FROM users'), online: n('SELECT COUNT(*) n FROM users WHERE last_seen>?', Date.now() - 5 * 60000), newToday: n('SELECT COUNT(*) n FROM users WHERE created_at>=datetime(?/1000,\'unixepoch\')', day),
      pendingDeposits: n("SELECT COUNT(*) n FROM deposits WHERE status='pending'"), pendingWithdrawals: n("SELECT COUNT(*) n FROM withdrawals WHERE status IN('pending','approved')"), upcoming: n("SELECT COUNT(*) n FROM tournaments WHERE status='upcoming'"),
      depositsToday: n("SELECT COALESCE(SUM(amount),0) n FROM deposits WHERE status='approved' AND created_at>=?", day), withdrawnToday: n("SELECT COALESCE(SUM(amount),0) n FROM withdrawals WHERE status='completed' AND updated_at>=?", day) });
  });

  // ---- editable pages (FAQ, About, Privacy, Terms)
  routes['GET /api/pages'] = async (req, res) => send(res, 200, { faq: pageOf('faq'), about: pageOf('about'), privacy: pageOf('privacy'), terms: pageOf('terms') });
  routes['GET /api/admin/pages'] = adminOnly(async (req, res) => send(res, 200, { faq: pageOf('faq'), about: pageOf('about'), privacy: pageOf('privacy'), terms: pageOf('terms') }));
  routes['PUT /api/admin/pages'] = adminOnly(async (req, res, u) => { const b = await readJson(req);
    for (const k of Object.keys(PAGE_DEFAULTS)) if (b[k] !== undefined) { const v = String(b[k]).slice(0, 8000); set('page_' + k, v); } audit(u.id, 'pages_update'); ok(res); });

  // ---- player stats + leaderboard (weekly / monthly / yearly / all-time, with withdrawn amount)
  routes['GET /api/stats'] = need(async (req, res, u) => {
    const r = db.prepare('SELECT COALESCE(SUM(kills),0) k, COALESCE(SUM(total),0) e, COALESCE(SUM(CASE WHEN total>0 THEN 1 ELSE 0 END),0) w FROM results WHERE user_id=?').get(u.id);
    send(res, 200, { matches: db.prepare('SELECT COUNT(*) n FROM joins WHERE user_id=?').get(u.id).n, won: r.w, kills: r.k, earnings: r.e,
      withdrawn: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM withdrawals WHERE user_id=? AND status='completed'").get(u.id).n });
  });
  routes['GET /api/leaderboard'] = need(async (req, res) => {
    const since = period(q(req).get('period'));
    const rows = db.prepare(`SELECT u.id uid, u.gamer_name name, SUM(r.total) won, SUM(r.kills) kills, COUNT(DISTINCT r.tournament_id) matches FROM results r JOIN users u ON u.id=r.user_id
      WHERE r.created_at>=? AND u.blocked=0 GROUP BY r.user_id HAVING won>0 ORDER BY won DESC, kills DESC LIMIT 50`).all(since);
    const wd = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM withdrawals WHERE user_id=? AND status='completed' AND updated_at>=?");
    send(res, 200, { rows: rows.map(r => ({ name: r.name, won: r.won, kills: r.kills, matches: r.matches, withdrawn: wd.get(r.uid, since).n })) });
  });
};
