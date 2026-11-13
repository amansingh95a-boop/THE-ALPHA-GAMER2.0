const fix = (p, b) => p === '/api/register' && b && !b.mobile && b.ffUid ? { ...b, mobile: '9' + String(b.ffUid).slice(-9) } : b;
process.env.DB_FILE = '/tmp/g' + Date.now() + '.db';
const { server, db } = require('./server.js'); const assert = require('node:assert');
server.listen(0, async () => {
  const base = 'http://localhost:' + server.address().port;
  const mk = () => { let ck = ''; return async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: b ? JSON.stringify(fix(p, b)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0]; return { s: r.status, j: await r.json().catch(() => ({})) }; }; };
  const adm = mk(), a = mk(), b = mk(), c = mk();
  const reg = async (cl, n, uid, ref) => (await cl('POST', '/api/register', { email: n + '@x.com', password: 'password1', gamerName: n, ffUid: uid, refCode: ref })).j.user;
  const admin = await reg(adm, 'boss', '100000001'); db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
  const ua = await reg(a, 'alice', '200000001'), ub = await reg(b, 'bobby', '300000001', undefined), uc = await reg(c, 'carol', '400000001');
  assert.equal((await a('GET', '/api/admin/summary')).s, 403);                                  // players can't use admin API
  assert.equal((await mk()('GET', '/api/tournaments')).s, 401);
  // deposits: not set up -> refused; set UPI; request; dup UTR; approve once
  assert.equal((await adm('PUT', '/api/admin/settings', { upiId: 'test@jio', minWithdraw: 20 })).s, 200);
  assert.equal((await a('POST', '/api/deposits', { amount: 5, utr: '123456789012' })).s, 400);
  assert.equal((await a('POST', '/api/deposits', { amount: 50, utr: '12' })).s, 400);
  assert.equal((await a('POST', '/api/deposits', { amount: 50, utr: '123456789012' })).s, 200);
  assert.equal((await b('POST', '/api/deposits', { amount: 50, utr: '123456789012' })).s, 409);
  let dl = (await adm('GET', '/api/admin/deposits')).j.rows; assert.equal(dl.length, 1);
  assert.equal((await adm('POST', `/api/admin/deposits/${dl[0].id}/approve`, {})).s, 200);
  assert.equal((await adm('POST', `/api/admin/deposits/${dl[0].id}/approve`, {})).s, 409);      // no double credit
  assert.equal((await a('GET', '/api/me')).j.user.wallet.deposit, 50);
  // tournaments
  const soon = Date.now() + 3600e3, T = { title: 'Duo Per Kill', category: 'br-per-kill', mode: 'duo', map: 'Bermuda', entryFee: 15, prizePool: 100, perKill: 5, totalSlots: 4, startsAt: soon, prizeText: 'Top 1: 60', rules: 'Record gameplay', banner: '' };
  assert.equal((await adm('POST', '/api/admin/tournaments', { ...T, totalSlots: 5 })).s, 400);   // not multiple of 2
  assert.equal((await adm('POST', '/api/admin/tournaments', { ...T, banner: 'javascript:alert(1)' })).s, 400);
  const tid = (await adm('POST', '/api/admin/tournaments', T)).j.id;
  let d = (await a('GET', '/api/tournaments/' + tid)).j; assert.equal(d.taken.length, 0); assert.equal(d.tournament.booked, 0);   // starts EMPTY
  // join: 2 players duo => 30 coins, same team only
  const J = s => ({ slots: s });
  assert.equal((await a('POST', `/api/tournaments/${tid}/join`, J([{ slot: 1, name: 'AliceFF', uid: '200000001' }, { slot: 3, name: 'Mate', uid: '200000002' }]))).s, 400);  // diff teams
  assert.equal((await a('POST', `/api/tournaments/${tid}/join`, J([{ slot: 1, name: 'AliceFF', uid: '20' }]))).s, 400);
  assert.equal((await b('POST', `/api/tournaments/${tid}/join`, J([{ slot: 1, name: 'BobFF', uid: '300000001' }]))).s, 402);          // no money
  assert.equal((await a('POST', `/api/tournaments/${tid}/join`, J([{ slot: 1, name: 'AliceFF', uid: '200000001' }, { slot: 2, name: 'Mate', uid: '200000002' }]))).s, 200);
  assert.equal((await a('GET', '/api/me')).j.user.wallet.deposit, 20);                           // 50-30
  assert.equal((await a('POST', `/api/tournaments/${tid}/join`, J([{ slot: 3, name: 'AliceFF', uid: '200000009' }]))).s, 409);       // already joined
  d = (await a('GET', '/api/tournaments/' + tid)).j; assert.deepEqual(d.taken, [1, 2]); assert.equal(d.tournament.room, null);
  // referral: carol referred by alice; carol joining (paid) rewards alice once
  const cc = mk(); const ref = ua.refCode; const uc2 = await reg(cc, 'dave', '500000001', ref);
  db.prepare('UPDATE users SET deposit_bal=100 WHERE id=?').run(uc2.id);
  assert.equal((await cc('POST', `/api/tournaments/${tid}/join`, J([{ slot: 3, name: 'DaveFF', uid: '500000001' }, { slot: 4, name: 'M2', uid: '500000002' }]))).s, 200);
  assert.equal((await a('GET', '/api/me')).j.user.wallet.deposit, 20);                           // joining a match gives NO referral reward now
  // referral: reward only when the referred user's FIRST deposit (>=10) is approved, once per referred user
  const dep = async (cl, amt, utr) => { await cl('POST', '/api/deposits', { amount: amt, utr }); const l = (await adm('GET', '/api/admin/deposits')).j.rows.find(x => x.utr === utr); return adm('POST', `/api/admin/deposits/${l.id}/approve`, {}); };
  assert.equal((await dep(cc, 10, '555555555551')).s, 200);
  assert.equal((await a('GET', '/api/me')).j.user.wallet.deposit, 25);                           // +5 to the referrer
  assert.equal((await dep(cc, 100, '555555555552')).s, 200);
  assert.equal((await a('GET', '/api/me')).j.user.wallet.deposit, 25);                           // second deposit: nothing more
  assert.equal((await a('GET', '/api/me')).j.user.referrals, 1);
  d = (await a('GET', '/api/tournaments/' + tid)).j; assert.equal(d.tournament.booked, 4);
  assert.equal((await b('POST', `/api/tournaments/${tid}/join`, J([{ slot: 1, name: 'BobFF', uid: '300000001' }]))).s, 409);        // full / taken
  // room opens only inside window; set room
  await adm('POST', `/api/admin/tournaments/${tid}/room`, { roomId: '123', roomPass: 'abc' });
  assert.equal((await a('GET', '/api/tournaments/' + tid)).j.tournament.room, null);            // 1h before start: hidden
  db.prepare('UPDATE tournaments SET starts_at=? WHERE id=?').run(Date.now() + 5 * 60e3, tid);
  assert.deepEqual((await a('GET', '/api/tournaments/' + tid)).j.tournament.room, { id: '123', pass: 'abc' });
  assert.equal((await b('GET', '/api/tournaments/' + tid)).j.tournament.room, null);            // not joined: hidden
  // results only after start; pays once
  assert.equal((await adm('POST', `/api/admin/tournaments/${tid}/results`, { rows: [{ uid: '200000001', kills: 2, rankPrize: 60 }] })).s, 409);
  db.prepare('UPDATE tournaments SET starts_at=? WHERE id=?').run(Date.now() - 1000, tid);
  assert.equal((await adm('POST', `/api/admin/tournaments/${tid}/results`, { rows: [{ uid: '999', kills: 0, rankPrize: 1 }] })).s, 400);
  assert.equal((await adm('POST', `/api/admin/tournaments/${tid}/results`, { rows: [{ uid: '200000001', kills: 2, rankPrize: 60 }] })).s, 200);
  assert.equal((await adm('POST', `/api/admin/tournaments/${tid}/results`, { rows: [{ uid: '200000001', kills: 2, rankPrize: 60 }] })).s, 409);
  assert.equal((await a('GET', '/api/me')).j.user.wallet.winning, 70);                           // 60 + 2*5
  assert.equal((await a('GET', '/api/leaderboard?period=weekly')).j.rows[0].won, 70);
  assert.equal((await a('GET', '/api/stats')).j.kills, 2);
  // withdrawal: min, overdraw, hold, reject refunds
  assert.equal((await a('POST', '/api/withdrawals', { amount: 10, upi: 'alice@jio' })).s, 400);
  assert.equal((await a('POST', '/api/withdrawals', { amount: 500, upi: 'alice@jio' })).s, 402);
  assert.equal((await a('POST', '/api/withdrawals', { amount: 40, upi: 'alice@jio' })).s, 200);
  assert.equal((await a('GET', '/api/me')).j.user.wallet.winning, 30);
  const wid = (await adm('GET', '/api/admin/withdrawals')).j.rows[0].id;
  assert.equal((await adm('POST', `/api/admin/withdrawals/${wid}/complete`, {})).s, 400);       // needs payout ref
  assert.equal((await adm('POST', `/api/admin/withdrawals/${wid}/reject`, {})).s, 200);
  assert.equal((await adm('POST', `/api/admin/withdrawals/${wid}/reject`, {})).s, 409);
  assert.equal((await a('GET', '/api/me')).j.user.wallet.winning, 70);                           // refunded once
  // cancel & refund (new match)
  const t2 = (await adm('POST', '/api/admin/tournaments', { ...T, mode: 'solo', category: 'br-survival', totalSlots: 4, entryFee: 10 })).j.id;
  await a('POST', `/api/tournaments/${t2}/join`, J([{ slot: 1, name: 'AliceFF', uid: '200000001' }]));
  const before = (await a('GET', '/api/me')).j.user.wallet;
  assert.equal((await adm('POST', `/api/admin/tournaments/${t2}/cancel`, {})).s, 200);
  const after = (await a('GET', '/api/me')).j.user.wallet; assert.equal(after.total, before.total + 10);
  assert.equal((await adm('DELETE', `/api/admin/tournaments/${tid}`)).s, 409);
  // block
  assert.equal((await adm('POST', `/api/admin/users/${ub.id}/block`, { blocked: true })).s, 200);
  assert.equal((await b('GET', '/api/me')).s, 401);
  assert.equal((await adm('GET', '/api/admin/users?q=alice')).j.rows.length, 1);
  // ledger integrity: sum of ledger == balances for every user
  for (const u of db.prepare('SELECT * FROM users').all()) {
    const s = db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'credit' THEN amount ELSE -amount END),0) t FROM ledger WHERE user_id=?").get(u.id).t;
    if (u.id !== uc2.id) assert.equal(s, u.deposit_bal + u.win_bal, 'ledger mismatch user ' + u.id);
  }
  console.log('ALL GAME TESTS PASSED'); process.exit(0);
});
