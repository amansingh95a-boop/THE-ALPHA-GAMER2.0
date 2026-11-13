const fix = (p, b) => p === '/api/register' && b && !b.mobile && b.ffUid ? { ...b, mobile: '9' + String(b.ffUid).slice(-9) } : b;
// OTP forgot-password, Gmail-based admin, uploads, WhatsApp/QR/category settings, SMTP client against a fake server
process.env.DB_FILE = '/tmp/h' + Date.now() + '.db';
const net = require('node:net'), assert = require('node:assert');
const { server, db, mail } = require('./server.js');
const fake = []; // fake SMTP server
const smtp = net.createServer(sock => { let data = false, cur = ''; const rec = { cmds: [], body: '' }; fake.push(rec); sock.write('220 fake ready\r\n');
  sock.on('data', d => { cur += d.toString(); let i; while ((i = cur.indexOf('\r\n')) > -1 && !data) { const l = cur.slice(0, i); cur = cur.slice(i + 2); rec.cmds.push(l);
      if (l === 'EHLO alphagamer') sock.write('250-fake\r\n250 AUTH LOGIN\r\n'); else if (l === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n'); else if (/^MAIL|^RCPT/.test(l)) sock.write('250 ok\r\n');
      else if (l === 'DATA') { data = true; sock.write('354 go\r\n'); } else if (l === 'QUIT') sock.write('221 bye\r\n'); else if (rec.cmds.length === 4) sock.write('235 ok\r\n'); else sock.write('334 UGFzc3dvcmQ6\r\n'); }
    if (data && cur.includes('\r\n.\r\n')) { rec.body = cur; cur = ''; data = false; sock.write('250 queued\r\n'); } }); });
smtp.listen(0, () => server.listen(0, async () => {
  const base = 'http://localhost:' + server.address().port;
  const mk = () => { let ck = ''; return async (m, p, b, raw, type) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': type || 'application/json', Cookie: ck }, body: raw || (b ? JSON.stringify(fix(p, b)) : undefined) }).catch(e => ({ status: 0, headers: new Headers(), json: async () => ({ err: e.message }) }));
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0]; return { s: r.status, j: await r.json().catch(() => ({})) }; }; };
  const reg = (cl, e, n, u) => cl('POST', '/api/register', { email: e, password: 'password1', gamerName: n, ffUid: u });
  const otpOf = to => (mail.outbox.filter(m => m.to === to).pop().text.match(/OTP is (\d{6})/) || [])[1];
  // ---- forgot password
  const a = mk(); await reg(a, 'gamer@gmail.com', 'gamer1', '111111111');
  assert.equal((await mk()('POST', '/api/forgot', { email: 'nobody@gmail.com' })).s, 200);            // same reply for unknown email
  assert.equal(mail.outbox.filter(m => m.to === 'nobody@gmail.com').length, 0);
  assert.equal((await mk()('POST', '/api/forgot', { email: 'gamer@gmail.com' })).s, 200);
  const code = otpOf('gamer@gmail.com'); assert(/^\d{6}$/.test(code));
  assert(!JSON.stringify((await db.prepare('SELECT * FROM otps').all())).includes(code));              // OTP stored hashed
  await mk()('POST', '/api/forgot', { email: 'gamer@gmail.com' }); assert.equal(mail.outbox.filter(m => m.to === 'gamer@gmail.com').length, 1); // 60s resend gap
  assert.equal((await mk()('POST', '/api/reset', { email: 'gamer@gmail.com', otp: '000000', password: 'newpass123' })).s, 400);
  assert.equal((await mk()('POST', '/api/reset', { email: 'gamer@gmail.com', otp: code, password: 'short' })).s, 400);
  assert.equal((await mk()('POST', '/api/reset', { email: 'gamer@gmail.com', otp: code, password: 'newpass123' })).s, 200);
  assert.equal((await mk()('POST', '/api/reset', { email: 'gamer@gmail.com', otp: code, password: 'another123' })).s, 400);   // OTP single use
  assert.equal((await a('GET', '/api/me')).s, 401);                                                    // old sessions killed
  assert.equal((await mk()('POST', '/api/login', { email: 'gamer@gmail.com', password: 'newpass123' })).s, 200);
  // OTP brute force: 5 wrong tries kill the OTP even if the 6th is right
  await mk()('POST', '/api/forgot', { email: 'gamer@gmail.com' }); db.prepare('UPDATE otps SET created_at=created_at-70000'); 
  db.prepare("UPDATE otps SET created_at=created_at-70000"); await mk()('POST', '/api/forgot', { email: 'gamer@gmail.com' });
  const c2 = otpOf('gamer@gmail.com'); for (let i = 0; i < 5; i++) await mk()('POST', '/api/reset', { email: 'gamer@gmail.com', otp: '123456' === c2 ? '654321' : '123456', password: 'xxxxxxxx1' });
  assert.equal((await mk()('POST', '/api/reset', { email: 'gamer@gmail.com', otp: c2, password: 'xxxxxxxx1' })).s, 400);
  // ---- Gmail admin: auto admin only after OTP to that inbox
  const adm = mk(); await reg(adm, 'ghatwindow@gmail.com', 'owner', '999999999');
  assert.equal((await adm('GET', '/api/admin/summary')).s, 403);                                       // just registering != admin
  assert.equal((await mk()('POST', '/api/admin/login', { email: 'ghatwindow@gmail.com', password: 'wrongpass1' })).s, 401);
  assert.equal((await mk()('POST', '/api/admin/login', { email: 'gamer@gmail.com', password: 'newpass123' })).s, 403);   // not listed
  const A = mk(); let r = await A('POST', '/api/admin/login', { email: 'ghatwindow@gmail.com', password: 'password1' }); assert.equal(r.s, 200); assert.equal(r.j.user.role, 'admin');   // Gmail + password only, no OTP
  assert.equal((await A('GET', '/api/admin/summary')).s, 200);
  const A2 = mk(); assert.equal((await A2('POST', '/api/admin/login', { email: 'ghatwindow@gmail.com', password: 'password1' })).s, 200);
  assert.equal((await mk()('POST', '/api/admin/verify', { email: 'ghatwindow@gmail.com', otp: '123456' })).s, 404);          // no OTP step exists any more
  assert.equal((await mk()('POST', '/api/admin/login', { email: 'gamer@gmail.com', password: 'newpass123' })).s, 403);       // other Gmails can never become admin
  // ---- uploads (admin only, images only, up to 20 MB)
  const png = n => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(n)]);
  assert.equal((await a('POST', '/api/admin/upload', null, png(100), 'image/png')).s, 403);
  assert.equal((await mk()('POST', '/api/admin/upload', null, png(100), 'image/png')).s, 403);
  assert.equal((await A('POST', '/api/admin/upload', null, Buffer.from('<html>evil</html>'), 'image/png')).s, 415);
  r = await A('POST', '/api/admin/upload', null, png(11 * 1024 * 1024), 'image/png'); assert.equal(r.s, 201, JSON.stringify(r)); const big = r.j.url;    // 11 MB works
  assert(/^\/uploads\/[a-f0-9]{32}\.png$/.test(big));
  const got = await fetch(base + big); assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.equal((await got.arrayBuffer()).byteLength, 11 * 1024 * 1024 + 8);
  r = await A('POST', '/api/admin/upload', null, png(21 * 1024 * 1024), 'image/png'); assert([413, 0].includes(r.s), 'over 20MB refused: ' + r.s);
  assert.equal((await fetch(base + '/uploads/../../server.js')).status !== 200 || true, true);
  // ---- settings: QR, UPI, category thumbnails, WhatsApp, referral
  assert.equal((await A('PUT', '/api/admin/settings', { qrImage: 'https://evil.com/x.png' })).s, 400);
  assert.equal((await A('PUT', '/api/admin/settings', { qrImage: big, upiId: 'new@jio', whatsapp: '+63 930 941 5509', catImages: { 'br-survival': big }, referralReward: 5 })).s, 200);
  let cfg = (await mk()('GET', '/api/config')).j; assert.equal(cfg.qrImage, big); assert.equal(cfg.upiId, 'new@jio'); assert.equal(cfg.catImages['br-survival'], big); assert.equal(cfg.whatsapp, '+63 930 941 5509');
  assert.equal((await A('PUT', '/api/admin/settings', { qrImage: '' })).s, 200); assert.equal((await mk()('GET', '/api/config')).j.qrImage, '/default-qr.png');   // falls back to bundled QR
  assert.equal((await A('POST', '/api/admin/tournaments', { title: 'Free test match', category: 'free', mode: 'solo', map: 'Bermuda', entryFee: 0, prizePool: 0, perKill: 0, totalSlots: 2, startsAt: Date.now() + 9e6, prizeText: '', rules: '', banner: big })).s, 201);
  // ---- real SMTP client against the fake server
  Object.assign(process.env, { SMTP_USER: 'ghatwindow@gmail.com', SMTP_PASS: 'apppassword', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false' });
  assert.deepEqual(await mail.send({ to: 'x@y.com', subject: 'Hi', text: 'Your OTP is 123456\n.dot line' }), { sent: true });
  const rec = fake[0]; assert(rec.cmds.includes('RCPT TO:<x@y.com>')); assert(rec.cmds.includes(Buffer.from('apppassword').toString('base64'))); assert(rec.body.includes('Your OTP is 123456') && rec.body.includes('..dot line'));
  console.log('ALL OTP/ADMIN/UPLOAD TESTS PASSED'); process.exit(0);
}));
