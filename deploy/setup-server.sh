#!/usr/bin/env bash
# One-time setup on the server (run as samantha). Safe to re-run.
set -euo pipefail
cd ~
[ -d pattaya/.git ] || git clone https://github.com/base12-team/Pattaya.git pattaya
cd ~/pattaya && git pull --ff-only
mkdir -p ~/pattaya-data && chmod 700 ~/pattaya-data
[ -s ~/pattaya-data/admin-token ] || openssl rand -hex 16 > ~/pattaya-data/admin-token
chmod 600 ~/pattaya-data/admin-token
if ss -ltn | grep -q ':3410 ' && ! pm2 describe pattaya >/dev/null 2>&1; then echo 'Port 3410 is already in use. Stopping without changes.'; exit 1; fi
cat > ~/pattaya/ecosystem.config.js <<JS
module.exports = { apps: [{ name: 'pattaya', script: 'server.js', cwd: '$HOME/pattaya',
  max_memory_restart: '200M',
  env: { PORT: '3410', DATA_DIR: '$HOME/pattaya-data', ADMIN_TOKEN: '$(cat ~/pattaya-data/admin-token)' } }] };
JS
chmod 600 ~/pattaya/ecosystem.config.js
pm2 describe pattaya >/dev/null 2>&1 && pm2 reload ~/pattaya/ecosystem.config.js --update-env || pm2 start ~/pattaya/ecosystem.config.js
pm2 save
sleep 2; curl -fsS -o /dev/null -w "app answers locally: %{http_code}\n" http://127.0.0.1:3410/
sudo cp ~/pattaya/deploy/nginx-pattaya.conf /etc/nginx/sites-available/pattaya.samantics.space
sudo ln -sf /etc/nginx/sites-available/pattaya.samantics.space /etc/nginx/sites-enabled/pattaya.samantics.space
sudo nginx -t && sudo systemctl reload nginx
echo "nginx updated. Admin link: https://pattaya.samantics.space/#admin-$(cat ~/pattaya-data/admin-token)"
