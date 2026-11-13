# THE ALPHA GAMER — v0.4.1

Needs Node.js 22.13 or newer. No `npm install` needed (zero dependencies).

## Start
1. Edit `start.bat` (Windows) or `start.sh` (Mac/Linux): put your Gmail App Password (see below).
2. Run it. Open http://localhost:3000 (players) and http://localhost:3000/admin (admin, private).
3. `npm test` runs all automatic tests.

## Becoming admin (no command, no OTP)
- Your Gmail is listed in ADMIN_EMAILS (default: ghatwindow@gmail.com; add more with commas).
- Create an account in the app with that Gmail. Then open /admin and login with the same Gmail + password. That's it.
- IMPORTANT: create YOUR account with this Gmail FIRST, before you share the website link with anyone.
  (Whoever registers that Gmail first and logs in at /admin becomes admin.) After you are admin, nobody else can register it.
- Forgot the admin password? Use "Forgot password?" in the player app (OTP goes to your Gmail).

## Gmail OTP (forgot password only)
- Google Account > Security > turn on 2-Step Verification > App passwords > create one > 16 characters.
- Put it in SMTP_PASS (start.bat/start.sh). SMTP_USER = the Gmail that sends mails.
- If SMTP is NOT set, OTPs are printed only in the server console (nobody else can see them) — fine for testing, not for real players.
- OTP rules: 6 digits, valid 10 minutes, 5 wrong tries kill it, resend after 60 seconds, 5 per hour per email.

## Admin panel (/admin)
- Deposits: check payment in your bank/Jio app, then Approve (coins added once; UTR can't be reused).
- Withdrawals: pay the UPI yourself, then "Mark paid" with your payout UTR. Reject = refund.
- Tournaments: create/edit, upload banner (JPG/PNG/WEBP up to 20 MB), room ID/pass, publish results, cancel & refund.
- Settings: change UPI ID and QR image any time, category thumbnails (Home tiles), WhatsApp care number, announcement,
  min withdrawal, referral reward.
- Uploaded images are stored in the `uploads/` folder next to server.js — back it up with `alpha.db`.

## Referral rule
Friend registers with your code. When that friend's FIRST deposit (10 or more) is approved, you get 5 coins (once per friend).
Reward and minimum are editable in Admin > Settings.

## Customer care
Menu > Customer Care opens WhatsApp chat with +63 930 941 5509 (change in Admin > Settings).

## Before going public
HTTPS (Caddy/Nginx), NODE_ENV=production, daily backup of alpha.db + uploads/, Privacy Policy + Terms text, legal check for
real-money gaming in India, and test every payment with a small amount first.
Not built: rewarded ads/daily coins (need ad network keys), automatic gateway payments, push notifications, Android APK wrapper.

## New in v0.4
- Register needs a 10-digit Indian mobile number. One Gmail, one mobile, one Free Fire UID and one gamer name per account (name check ignores capital letters).
  Admin sees name, UID, mobile and Gmail for every player (Users tab, search by any of them).
- Admin > Users > "Add money by mobile number": find player by mobile, confirm, deposit balance is credited (logged + shown in deposit history).
- Admin > Deposits / Withdrawals each have their own History (filter by time, status, name/mobile/UTR) with totals. Dashboard shows today's numbers.
- Admin > Events: poster slider on player Home (auto-slides, tap opens Telegram/Instagram/WhatsApp/any https link). Quick-fill buttons use the helpline links.
- Admin > Settings > Helpline: WhatsApp number, Telegram link, Instagram link (Menu > Contact Us). Also editable FAQ / About / Privacy / Terms pages.
- Admin > Matches: pick game, entry fee, prize pool and start time only; mode, slots, map, title, rules are auto-filled. "How many matches / every N minutes" creates a series. Duplicate button.
- Duo/squad: player chooses "Just me" (1 seat, 1 fee) or "Me + friend(s)" (several seats at once, fee x players, friend name + UID added). Seats stay empty until real players book.
- Players: pull down (or tap the refresh button) to refresh the page they are on; reload keeps them on the same page.
- Room ID/password: saved by admin => only joined players get an alert (Menu > Important Notice ON = popup + sound while the app is open) and see it inside the match page.
- Leaderboard: weekly / monthly / yearly / all-time with won + withdrawn + kills. Profile/Menu show matches, wins, kills, earning.
- Player counts shown are REAL (online in last 5 minutes, players joined per game). No fake numbers.
- Real phone push notifications when the app is closed need the Android APK + Firebase; not included.

## Deploy on Render (or any server)
1. GitHub repo must contain: server.js, game.js, extra.js, mail.js, package.json AND the `public` folder (index.html, admin.html, default-qr.png).
   If you cannot upload a folder from your phone: upload index.html, admin.html and default-qr.png directly next to server.js — that works too.
2. Render > New Web Service. Build command: leave empty (or `yarn`). Start command: `node server.js` (or `yarn start`).
3. IMPORTANT — data must be on a persistent disk. Render's normal filesystem is wiped on every deploy/restart, which would DELETE all players, wallets and uploaded images.
   Add a Render Disk (paid plan), mount path `/var/data`, then set environment variable `DATA_DIR=/var/data`.
   (Without a disk, use it only for testing, never for real money.)
4. Environment variables: DATA_DIR, NODE_ENV=production, ADMIN_EMAILS, SMTP_USER, SMTP_PASS (Gmail App Password). Never put passwords in the code.
5. After deploy: create your account on the site, then open /admin with the same Gmail + password.
