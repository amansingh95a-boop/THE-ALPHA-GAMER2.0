#!/bin/sh
# Fill these in, then run:  sh start.sh
export SMTP_USER="ghatwindow@gmail.com"      # Gmail that sends OTP mails
export SMTP_PASS="PASTE_16_CHAR_APP_PASSWORD"  # Google "App password" (NOT your normal Gmail password)
export ADMIN_EMAILS="ghatwindow@gmail.com"   # comma separated; these Gmails can become admin (after OTP)
export PORT=3000
# export NODE_ENV=production                  # turn on when you serve over HTTPS
node server.js
