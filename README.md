# Pattaya Run Weekend · RSVP site

The trip website (29–31 Jan 2027) with a live RSVP list. Friends pick their name, say if they're coming and whether they're running or cheering, and everyone sees the list update.

- `server.js`: the whole backend. Node 18+, no dependencies. Serves `public/` and a small JSON API.
- `seed.json`: the starting guest list, used only the first time (when there's no saved data yet).
- RSVPs are saved to `rsvps.json` in `DATA_DIR` (a Docker volume in production).

## Deploy on a Hetzner server (Docker)

You need a server with Docker installed, and a DNS **A record** pointing your chosen domain (e.g. `pattaya.samantics.space`) at the server's IP.

```bash
git clone <this repo> pattaya-rsvp && cd pattaya-rsvp
cp .env.example .env
# edit .env: set SITE_DOMAIN, and ADMIN_TOKEN to a long random string, e.g.
#   openssl rand -hex 24
docker compose up -d --build
```

Caddy gets an HTTPS certificate automatically. The site is live at `https://<SITE_DOMAIN>`.

### If the server already runs a web server on ports 80/443

Remove the `caddy` service from `docker-compose.yml`, publish the app's port instead (`ports: ["127.0.0.1:3000:3000"]` under `app`), and add a site to your existing Caddy/nginx that proxies to `127.0.0.1:3000`.

### Updating

```bash
git pull && docker compose up -d --build
```

RSVPs live in the `rsvp-data` volume, so they survive rebuilds.

### Auto-deploy from GitHub (optional)

`.github/workflows/deploy.yml` redeploys on every push to `main`. Add three repository secrets (Settings > Secrets and variables > Actions): `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY`. Do the first clone and `.env` on the server by hand, as above.

## Editing the vans, map pins and calendar

- **Vans:** edit `public/vans.json` (name, pickup point, time, map link, seats per van). The RSVP form and the van cards update from it, and the server enforces the seat limit.
- **Map pins:** the `places` list near the bottom of `public/index.html`.
- **Calendar files:** `public/pattaya-weekend.ics` and `public/pattaya-10k.ics`.

## Admin (fixing replies)

Open `https://<SITE_DOMAIN>/#admin-<ADMIN_TOKEN>` once on your phone or laptop. That device is remembered, and you can then tap any name in the RSVP list to change a reply, set someone back to "No reply" or remove them. Don't share that link.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/rsvps` | anyone | The full list |
| POST | `/api/rsvps` | anyone | `{name, status: going/maybe/no, role: running/cheering/"", note}`; updates by name or adds a new guest |
| PUT | `/api/rsvps/:name` | admin | Set any field, including `status: "none"` |
| DELETE | `/api/rsvps/:name` | admin | Remove a guest |

Admin calls send the token in an `X-Admin-Token` header. Writes are rate-limited to 20 per 10 minutes per IP, and the list is capped at 80 names.

Note: anyone with the link can reply for any name on the list. That's fine for a group of friends; it isn't a login system.

## Run locally

```bash
ADMIN_TOKEN=test node server.js   # http://localhost:3000
```

## Predictions, photo wall, weather, sunset

- **Predictions**: anyone can predict a runner's finish time until the race starts (`RACE_START`, default `2027-01-30T17:45:00+07:00`). From the start gun, runners can add their own chip time once; ask Sam (admin) to fix a wrong one. The board shows who was closest. Stored in `data/predictions.json`.
- **Photo wall**: photos are shrunk in the browser to about 1600px and saved under `data/photos/`. The Soi 6 album is hidden from everyone except the admin until `SOI6_REVEAL` (default `2027-01-31T16:30:00+07:00`, when the vans leave). Admins can delete a photo from the lightbox.
- **Weather**: shows typical late-January weather until 16 days out, then the live Open-Meteo forecast for 29–31 Jan.
- **Sunset**: the sun in the hero rises from 16 Nov 2026 until 9:30am on 29 Jan 2027.

To test the race-day features early, set `RACE_START` and `SOI6_REVEAL` in `.env` and restart.

## Live setup on dev-server (pm2 + nginx, no Docker)

The site runs at https://pattaya.samantics.space on the Hetzner server dev-server (46.224.147.132), alongside the other samantics.space apps.

- One-time: `ssh samantha@46.224.147.132 'bash ~/pattaya/deploy/setup-server.sh'` (clone first if ~/pattaya doesn't exist), then `sudo certbot --nginx -d pattaya.samantics.space --redirect` for HTTPS.
- Runs under pm2 as `pattaya` on port 3410; data in `~/pattaya-data`; admin token in `~/pattaya-data/admin-token`.
- Pushes to main deploy automatically via `.github/workflows/deploy.yml` (git pull + `pm2 restart pattaya`).
- Docker files are kept for anyone who wants the Docker route on a fresh server.
