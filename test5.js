const { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert');
const here = __dirname;
function run(dir, env, ports) { return new Promise(res => { const p = spawn('node', ['server.js'], { cwd: dir, env: { ...process.env, ...env } }); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); setTimeout(() => res({ p, get out() { return out; } }), 1200); }); }
(async () => {
  const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
  const copy = (to, files) => files.forEach(f => fs.cpSync(path.join(here, f), path.join(to, f), { recursive: true }));
  // 1) public folder missing entirely: server must NOT crash, must explain
  let d = mkdir(); copy(d, ['server.js', 'game.js', 'extra.js', 'mail.js']);
  let r = await run(d, { PORT: '3811', DATA_DIR: d }); let x = await fetch('http://localhost:3811/'); assert.equal(x.status, 500); assert((await x.text()).includes('public')); assert.equal(r.p.exitCode, null, 'server still alive'); assert(r.out.includes('WARNING')); r.p.kill();
  // 2) only files uploaded flat next to server.js (no folder): app works
  d = mkdir(); copy(d, ['server.js', 'game.js', 'extra.js', 'mail.js']); ['index.html', 'admin.html', 'default-qr.png'].forEach(f => fs.copyFileSync(path.join(here, 'public', f), path.join(d, f)));
  r = await run(d, { PORT: '3812', DATA_DIR: d }); for (const [u, t] of [['/', 'text/html'], ['/admin', 'text/html'], ['/default-qr.png', 'image/png']]) { x = await fetch('http://localhost:3812' + u); assert.equal(x.status, 200, u); assert(x.headers.get('content-type').startsWith(t), u); }
  assert.equal((await fetch('http://localhost:3812/server.js')).headers.get('content-type').startsWith('text/html'), true, 'source files are never served'); r.p.kill();
  // 3) DATA_DIR on a separate (persistent) disk: DB + uploads go there, survive restart
  const disk = mkdir(); d = mkdir(); copy(d, ['server.js', 'game.js', 'extra.js', 'mail.js', 'public']);
  r = await run(d, { PORT: '3813', DATA_DIR: disk }); const body = JSON.stringify({ email: 'a@b.com', password: 'password1', gamerName: 'Persist', ffUid: '123456789', mobile: '9876543210' });
  x = await fetch('http://localhost:3813/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); assert.equal(x.status, 201); r.p.kill(); await new Promise(z => setTimeout(z, 300));
  assert(fs.existsSync(path.join(disk, 'alpha.db')) && fs.existsSync(path.join(disk, 'uploads')) && !fs.existsSync(path.join(d, 'alpha.db')));
  r = await run(d, { PORT: '3814', DATA_DIR: disk }); x = await fetch('http://localhost:3814/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com', password: 'password1' }) }); assert.equal(x.status, 200); r.p.kill();
  console.log('ALL DEPLOY TESTS PASSED'); process.exit(0);
})();
