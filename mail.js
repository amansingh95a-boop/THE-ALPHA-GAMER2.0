'use strict';
// Minimal SMTP client (no dependencies). For Gmail: SMTP_USER=you@gmail.com, SMTP_PASS=<16-char Google App Password>.
// If SMTP is not configured, the mail is printed in the SERVER console only (safe: users never see it).
const net = require('node:net'), tls = require('node:tls');
const outbox = [];
const configured = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);
const clean = s => String(s).replace(/[\r\n]+/g, ' ');

function send({ to, subject, text }) {
  to = clean(to); subject = clean(subject);
  if (!configured()) { outbox.push({ to, subject, text }); console.log(`[MAIL NOT CONFIGURED] To: ${to} | ${subject} | ${text}`); return Promise.resolve({ logged: true }); }
  const c = { host: process.env.SMTP_HOST || 'smtp.gmail.com', port: +process.env.SMTP_PORT || 465, secure: process.env.SMTP_SECURE !== 'false', user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  const from = process.env.SMTP_FROM || c.user, b64 = s => Buffer.from(s).toString('base64');
  const msg = ['From: THE ALPHA GAMER <' + clean(from) + '>', 'To: ' + to, 'Subject: ' + subject, 'Date: ' + new Date().toUTCString(), 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')].join('\r\n') + '\r\n.';
  const steps = [[null, '220'], ['EHLO alphagamer', '250'], ['AUTH LOGIN', '334'], [b64(c.user), '334'], [b64(c.pass), '235'],
    ['MAIL FROM:<' + clean(from) + '>', '250'], ['RCPT TO:<' + to + '>', '250'], ['DATA', '354'], [msg, '250'], ['QUIT', '221']];
  return new Promise((resolve, reject) => {
    const sock = c.secure ? tls.connect({ host: c.host, port: c.port, servername: c.host }) : net.connect({ host: c.host, port: c.port });
    let buf = '', acc = '', i = 0, done = false;
    const fail = e => { if (!done) { done = true; sock.destroy(); reject(e); } };
    sock.setTimeout(20000, () => fail(new Error('SMTP timeout'))); sock.on('error', fail);
    sock.on('data', d => {
      buf += d.toString('utf8'); const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) {
        acc += l + '\n'; if (!/^\d{3}( |$)/.test(l)) continue;           // multi-line reply continues with "250-"
        const reply = acc; acc = '';
        if (!reply.startsWith(steps[i][1])) return fail(new Error('SMTP error: ' + reply.trim().slice(0, 120)));
        if (++i >= steps.length) { done = true; sock.end(); return resolve({ sent: true }); }
        sock.write(steps[i][0] + '\r\n');
      }
    });
  });
}
module.exports = { send, outbox, configured };
