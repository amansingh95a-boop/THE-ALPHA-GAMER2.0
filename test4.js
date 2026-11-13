// New features: mobile + unique names, admin credit by mobile, histories, events, notifications, pages, leaderboard, helpline, auto-fill
process.env.DB_FILE = '/tmp/f' + Date.now() + '.db';
const assert = require('node:assert'); const { server, db } = require('./server.js');
server.listen(0, async () => {
  const base = 'http://localhost:' + server.address().port;
  const mk = () => { let ck = ''; return async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0]; return { s: r.status, j: await r.json().catch(() => ({})) }; }; };
  const R = (n, uid, mob, em) => ({ email: em || n + '@gmail.com', password: 'password1', gamerName: n, ffUid: uid, mobile: mob });
  const A = mk(), P = mk(), P2 = mk();
  // --- mobile / unique rules
  assert.equal((await mk()('POST', '/api/register', { ...R('noMob', '111111111'), mobile: undefined })).s, 400);
  assert.equal((await mk()('POST', '/api/register', R('badMob', '111111112', '1234567890'))).s, 400);      // must start 6-9
  assert.equal((await mk()('POST', '/api/register', R('shortM', '111111113', '98765'))).s, 400);
  assert.equal((await P('POST', '/api/register', R('Rahul', '222222222', '+91 98765 43210'))).s, 201);     // +91 and spaces accepted
  assert.equal((await P('GET', '/api/me')).j.user.mobile, '9876543210');
  assert.equal((await mk()('POST', '/api/register', R('Other1', '222222223', '09876543210'))).s, 409);     // same number (0 prefix) => one number, one id
  assert.equal((await mk()('POST', '/api/register', R('rahul', '222222224', '9876543211'))).s, 409);       // same username, any case
  assert.equal((await mk()('POST', '/api/register', R('Other2', '222222225', '9876543212', 'rahul@gmail.com'))).s, 409);   // same Gmail
  assert.equal((await mk()('POST', '/api/register', R('Other3', '222222222', '9876543213'))).s, 409);      // same FF UID
  assert.equal((await P2('POST', '/api/register', R('Sita', '333333333', '9123456780'))).s, 201);
  assert.equal((await P2('PUT', '/api/profile', { gamerName: 'RAHUL' })).s, 409);
  assert.equal((await P2('PUT', '/api/profile', { mobile: '9876543210' })).s, 400);                        // mobile can't be changed once set
  // --- admin (Gmail + password)
  await A('POST', '/api/register', R('Boss', '444444444', '9000000001', 'ghatwindow@gmail.com')); assert.equal((await A('POST', '/api/admin/login', { email: 'ghatwindow@gmail.com', password: 'password1' })).s, 200);
  let r = (await A('GET', '/api/admin/users?q=9876543210')).j.rows; assert.equal(r.length, 1); assert.equal(r[0].gamer_name, 'Rahul'); assert.equal(r[0].mobile, '9876543210'); assert.equal(r[0].ff_uid, '222222222');
  // --- add money by mobile
  assert.equal((await P('POST', '/api/admin/credit', { mobile: '9876543210', amount: 50 })).s, 403);
  assert.equal((await A('POST', '/api/admin/credit', { mobile: '9999999999', amount: 50 })).s, 404);
  assert.equal((await A('POST', '/api/admin/credit', { mobile: '9876543210', amount: 0 })).s, 400);
  r = await A('POST', '/api/admin/credit', { mobile: '98765 43210', amount: 120, note: 'bonus' }); assert.equal(r.s, 200); assert.equal(r.j.gamerName, 'Rahul'); assert.equal(r.j.balance, 120);
  assert.equal((await P('GET', '/api/me')).j.user.wallet.deposit, 120);
  // --- separate histories
  await P('POST', '/api/deposits', { amount: 50, utr: '100000000001' }); await P2('POST', '/api/deposits', { amount: 30, utr: '100000000002' });
  const pend = (await A('GET', '/api/admin/deposits')).j.rows; assert.equal(pend.length, 2); await A('POST', `/api/admin/deposits/${pend.find(x => x.utr === '100000000001').id}/approve`, {});
  let h = (await A('GET', '/api/admin/history/deposits')).j; assert.equal(h.count, 3); assert.equal(h.total, 170); assert(h.rows.some(x => x.src === 'admin' && x.amount === 120) && h.rows.every(x => x.mobile));
  assert.equal((await A('GET', '/api/admin/history/deposits?status=pending')).j.count, 1);
  assert.equal((await A('GET', '/api/admin/history/deposits?q=9123456780')).j.count, 1);
  assert.equal((await A('GET', '/api/admin/history/deposits?days=1')).j.count, 3);
  db.prepare('UPDATE users SET win_bal=100 WHERE id=1'); db.prepare("UPDATE users SET win_bal=100 WHERE mobile='9876543210'").run();
  await A('PUT', '/api/admin/settings', { upiId: 'x@jio', minWithdraw: 20 }); assert.equal((await P('POST', '/api/withdrawals', { amount: 60, upi: 'rahul@jio' })).s, 200);
  const wd = (await A('GET', '/api/admin/history/withdrawals')).j; assert.equal(wd.count, 1); assert.equal(wd.rows[0].mobile, '9876543210'); assert.equal(wd.rows[0].upi, 'rahul@jio');
  await A('POST', `/api/admin/withdrawals/${wd.rows[0].id}/complete`, { ref: 'UTR999' }); assert.equal((await A('GET', '/api/admin/history/withdrawals?status=completed')).j.total, 60);
  assert.equal((await P('GET', '/api/admin/history/deposits')).s, 403);
  // --- matches auto-fill: only category, fee, prize, time are needed
  const soon = Date.now() + 3600e3; r = await A('POST', '/api/admin/tournaments', { category: 'lw-2v2', entryFee: 20, prizePool: 100, startsAt: soon }); assert.equal(r.s, 201, JSON.stringify(r.j));
  let t = (await A('GET', '/api/admin/tournaments')).j.rows[0]; assert.equal(t.mode, 'duo'); assert.equal(t.totalSlots, 4); assert.equal(t.map, 'Iron cage'); assert.equal(t.title, 'LONE WOLF 2V2'); assert(t.rules.includes('Record')); assert(t.prizeText.includes('100'));
  assert.equal((await A('POST', '/api/admin/tournaments', { category: 'cs-1v1', entryFee: 10, prizePool: 15, startsAt: soon })).s, 201);
  t = (await A('GET', '/api/admin/tournaments')).j.rows.find(x => x.category === 'cs-1v1'); assert.equal(t.totalSlots, 2);
  assert.equal((await A('POST', '/api/admin/tournaments', { category: 'cs-1v1', prizePool: 15, startsAt: soon })).s, 400);   // fee missing
  // --- notifications: room details reach ONLY joined players; broadcast reaches all
  const lw = (await A('GET', '/api/admin/tournaments')).j.rows.find(x => x.category === 'lw-2v2'); db.prepare('UPDATE users SET deposit_bal=500 WHERE id IN (2,3)').run();
  assert.equal((await P('POST', `/api/tournaments/${lw.id}/join`, { slots: [{ slot: 1, name: 'RahulFF', uid: '222222222' }, { slot: 2, name: 'Mate', uid: '555555555' }] })).s, 200);
  let n0 = (await P2('GET', '/api/notifications')).j; const before = n0.unread;
  await A('POST', `/api/admin/tournaments/${lw.id}/room`, { roomId: '777', roomPass: 'pw9' });
  let np = (await P('GET', '/api/notifications')).j; assert(np.rows[0].body.includes('777') && np.rows[0].body.includes('pw9')); assert(np.unread >= 1);
  assert.equal((await P2('GET', '/api/notifications')).j.unread, before);                                    // not joined => nothing
  assert.equal((await A('POST', '/api/admin/notify', { title: 'Big match tonight', body: 'Join now!' })).s, 200); assert.equal((await P2('GET', '/api/notifications')).j.unread, before + 1);
  await P2('POST', '/api/notifications/seen'); assert.equal((await P2('GET', '/api/notifications')).j.unread, 0);
  const late = mk(); await late('POST', '/api/register', R('Late', '666666666', '9111111111')); assert.equal((await late('GET', '/api/notifications')).j.unread, 0);   // old broadcasts not "unread" for new users
  // --- events slider
  assert.equal((await P('POST', '/api/admin/events', { title: 'Join Telegram', link: 'https://t.me/x' })).s, 403);
  assert.equal((await A('POST', '/api/admin/events', { title: 'Join Telegram', link: 'javascript:alert(1)' })).s, 400);
  assert.equal((await A('POST', '/api/admin/events', { title: 'Join Telegram', link: 'https://t.me/alphagamer', sortOrder: 1 })).s, 201);
  const ev2 = (await A('POST', '/api/admin/events', { title: 'Follow Instagram', link: 'https://instagram.com/alphagamer', description: 'Daily updates', sortOrder: 2 })).j.id;
  assert.equal((await mk()('GET', '/api/events')).j.events.length, 2);
  await A('PUT', `/api/admin/events/${ev2}`, { title: 'Follow Instagram', link: 'https://instagram.com/alphagamer', active: false }); assert.equal((await mk()('GET', '/api/events')).j.events.length, 1);
  await A('DELETE', `/api/admin/events/${ev2}`); assert.equal((await A('GET', '/api/admin/events')).j.rows.length, 1);
  // --- helpline + pages
  assert.equal((await A('PUT', '/api/admin/settings', { telegramUrl: 'http://bad', whatsapp: '+63 930 941 5509' })).s, 400);
  assert.equal((await A('PUT', '/api/admin/settings', { telegramUrl: 'https://t.me/alphagamer', instagramUrl: 'https://instagram.com/alphagamer', whatsapp: '+91 98765 43210' })).s, 200);
  let cfg = (await mk()('GET', '/api/config')).j; assert.equal(cfg.telegramUrl, 'https://t.me/alphagamer'); assert.equal(cfg.instagramUrl, 'https://instagram.com/alphagamer'); assert.equal(cfg.whatsapp, '+91 98765 43210'); assert(cfg.online >= 1);
  assert(cfg.categories.find(c => c.id === 'cs-4v4').slots === 8);
  assert((await mk()('GET', '/api/pages')).j.faq.includes('Join')); await A('PUT', '/api/admin/pages', { terms: 'My custom terms' }); assert.equal((await mk()('GET', '/api/pages')).j.terms, 'My custom terms');
  // --- results -> stats, leaderboard (weekly/monthly/yearly/all, withdrawn shown)
  db.prepare('UPDATE tournaments SET starts_at=? WHERE id=?').run(Date.now() - 1000, lw.id);
  assert.equal((await A('POST', `/api/admin/tournaments/${lw.id}/results`, { rows: [{ uid: '222222222', kills: 3, rankPrize: 60 }] })).s, 200);
  const st = (await P('GET', '/api/stats')).j; assert.deepEqual([st.matches, st.won, st.kills, st.earnings, st.withdrawn], [1, 1, 3, 60 + 3 * 0, 60]);
  for (const per of ['weekly', 'monthly', 'yearly', 'all']) { const lb = (await P('GET', '/api/leaderboard?period=' + per)).j.rows; assert.equal(lb[0].name, 'Rahul'); assert.equal(lb[0].won, 60); assert.equal(lb[0].withdrawn, 60); assert.equal(lb[0].kills, 3); }
  console.log('ALL NEW-FEATURE TESTS PASSED'); process.exit(0);
});
