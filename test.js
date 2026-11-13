const fix = (p, b) => p === '/api/register' && b && !b.mobile && b.ffUid ? { ...b, mobile: '9' + String(b.ffUid).slice(-9) } : b;
process.env.DB_FILE = '/tmp/t' + Date.now() + '.db';
const { server, db, grantReferralReward } = require('./server.js');
const assert = require('node:assert');
server.listen(0, async () => {
  const base = 'http://localhost:' + server.address().port; let ck = '';
  const call = async (m, p, b, keep) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Cookie: keep ?? ck }, body: b ? JSON.stringify(fix(p, b)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc && keep === undefined) ck = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => ({})), sc };
  };
  const A = { email: 'Aman@Gmail.com', password: 'secret123', gamerName: 'amanbhai21', ffUid: '123456789' };
  let r = await call('POST', '/api/register', A); assert.equal(r.s, 201); assert(/^AG[A-Z2-9]{6}$/.test(r.j.user.refCode));
  assert(r.sc.includes('HttpOnly')); assert(!JSON.stringify(r.j).includes('secret123')); const code = r.j.user.refCode;
  assert.equal((await call('POST', '/api/register', { ...A, ffUid: '987654321' }, '')).s, 409);       // dup email
  assert.equal((await call('POST', '/api/register', { ...A, email: 'x@y.com' }, '')).s, 409);          // dup uid
  assert.equal((await call('POST', '/api/register', { ...A, email: 'z@y.com', ffUid: '1' }, '')).s, 400);
  assert.equal((await call('POST', '/api/register', { ...A, email: 'z@y.com', ffUid: '111111111', password: 'short' }, '')).s, 400);
  assert.equal((await call('GET', '/api/me')).j.user.gamerName, 'amanbhai21');
  assert.equal((await call('PUT', '/api/profile', { gamerName: 'AlphaAman' })).j.user.gamerName, 'AlphaAman');
  // referral
  assert.equal((await call('POST', '/api/register', { email: 'b@y.com', password: 'secret123', gamerName: 'friend1', ffUid: '222222222', refCode: 'AGBADBAD' }, '')).s, 400);
  r = await call('POST', '/api/register', { email: 'b@y.com', password: 'secret123', gamerName: 'friend1', ffUid: '222222222', refCode: code.toLowerCase() }, ''); assert.equal(r.s, 201);
  const bId = r.j.user.id;
  assert.equal(grantReferralReward(bId), true); assert.equal(grantReferralReward(bId), false);        // paid once only
  r = await call('GET', '/api/me'); assert.equal(r.j.user.wallet.deposit, 5); assert.equal(r.j.user.referrals, 1);
  assert.equal((await call('GET', '/api/wallet')).j.history.length, 1);
  // login / throttle / password
  assert.equal((await call('POST', '/api/login', { email: 'aman@gmail.com', password: 'nope' }, '')).s, 401);
  assert.equal((await call('POST', '/api/login', { email: 'aman@gmail.com', password: 'secret123' }, '')).s, 200);
  assert.equal((await call('POST', '/api/password', { current: 'secret123', next: 'newsecret99' })).s, 200);
  for (let i = 0; i < 5; i++) await call('POST', '/api/login', { email: 'ghost@y.com', password: 'x' }, '');
  assert.equal((await call('POST', '/api/login', { email: 'ghost@y.com', password: 'x' }, '')).s, 429);
  // blocked users lose access; logout works
  db.prepare('UPDATE users SET blocked=1 WHERE id=?').run(bId);
  assert.equal((await call('POST', '/api/login', { email: 'b@y.com', password: 'secret123' }, '')).s, 403);
  await call('POST', '/api/logout'); assert.equal((await call('GET', '/api/me')).s, 401);
  // CSRF + overdraw guard
  const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' }, body: '{}' }); assert.equal(bad.status, 403);
  const { moveMoney } = require('./server.js'); assert.throws(() => moveMoney(1, 'debit', 'deposit', 999, 'test'));
  console.log('ALL AUTH TESTS PASSED'); process.exit(0);
});
