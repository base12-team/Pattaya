// Pattaya Run Weekend: website + RSVP API.
// No dependencies: run with `node server.js` (Node 18+).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rsvps.json');
const SEED_FILE = path.join(__dirname, 'seed.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATUSES = ['going', 'maybe', 'no', 'none'];
const ROLES = ['running', 'cheering', ''];
const VANS = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'vans.json'), 'utf8'));
const VAN_IDS = VANS.vans.map((v) => v.id).concat(['own', '']);
const MAX_GUESTS = 80;

// ---------- storage ----------
function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const board = { updatedAt: new Date().toISOString(), guests: seed.guests.map(clean).filter(Boolean) };
    save(board);
    return board;
  }
}
function save(board) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic replace
}
function clean(g) {
  if (!g || typeof g.name !== 'string') return null;
  const name = g.name.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) return null;
  return {
    name,
    status: STATUSES.includes(g.status) ? g.status : 'none',
    role: ROLES.includes(g.role) ? g.role : '',
    note: typeof g.note === 'string' ? g.note.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
    van: VAN_IDS.includes(g.van) ? g.van : '',
    updatedAt: g.updatedAt || null,
  };
}
let board = load();

// ---------- helpers ----------
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
function send(res, code, body, headers) {
  const isObj = typeof body === 'object';
  res.writeHead(code, Object.assign({
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit) {
  limit = limit || 10000;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// simple per-IP rate limit: 20 writes per 10 minutes
const hits = new Map();
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 20;
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ics': 'text/calendar; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- API ----------
async function api(req, res, pathname) {
  // Everyone: read the board
  if (req.method === 'GET' && pathname === '/api/rsvps') {
    return send(res, 200, { updatedAt: board.updatedAt, guests: board.guests });
  }

  // Everyone: reply for yourself (create or update by name)
  if (req.method === 'POST' && pathname === '/api/rsvps') {
    if (rateLimited(req)) return send(res, 429, { error: 'Too many replies from here. Try again in a few minutes.' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
    const g = clean(Object.assign({}, body, { updatedAt: new Date().toISOString() }));
    if (!g) return send(res, 400, { error: 'Please enter your name.' });
    if (!['going', 'maybe', 'no'].includes(body.status)) return send(res, 400, { error: 'Pick going, maybe or can’t make it.' });
    if (g.status === 'no') { g.role = ''; g.van = ''; }
    if (g.van && g.van !== 'own') {
      const taken = board.guests.filter((x) => x.van === g.van && !sameName(x.name, g.name) && x.status !== 'no').length;
      if (taken >= VANS.seats) return send(res, 400, { error: 'That van is full. Pick another one.' });
    }
    const i = board.guests.findIndex((x) => sameName(x.name, g.name));
    if (i >= 0) {
      g.name = board.guests[i].name; // keep original spelling
      board.guests[i] = g;
    } else {
      if (board.guests.length >= MAX_GUESTS) return send(res, 400, { error: 'The guest list is full. Message Sam.' });
      board.guests.push(g);
    }
    board.updatedAt = g.updatedAt;
    save(board);
    return send(res, 200, { ok: true, guest: g });
  }

  // Admin: check token
  if (req.method === 'GET' && pathname === '/api/admin') {
    return send(res, isAdmin(req) ? 200 : 401, { admin: isAdmin(req) });
  }

  // Admin: change anyone's reply (including back to "none") or remove someone
  if ((req.method === 'PUT' || req.method === 'DELETE') && pathname.startsWith('/api/rsvps/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin only' });
    const name = decodeURIComponent(pathname.slice('/api/rsvps/'.length));
    const i = board.guests.findIndex((x) => sameName(x.name, name));
    if (req.method === 'DELETE') {
      if (i < 0) return send(res, 404, { error: 'Not found' });
      board.guests.splice(i, 1);
    } else {
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
      const g = clean(Object.assign({ name }, body, { name, updatedAt: new Date().toISOString() }));
      if (!g) return send(res, 400, { error: 'Bad request' });
      if (i >= 0) board.guests[i] = g; else board.guests.push(g);
    }
    board.updatedAt = new Date().toISOString();
    save(board);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}


// ---------- predictions & results ----------
const RACE_START = Date.parse(process.env.RACE_START || '2027-01-30T17:45:00+07:00');
const SOI6_REVEAL = Date.parse(process.env.SOI6_REVEAL || '2027-01-31T16:30:00+07:00');
const PRED_FILE = path.join(DATA_DIR, 'predictions.json');
const PHOTO_META = path.join(DATA_DIR, 'photos.json');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const ALBUMS = ['boat', 'race', 'soi6', 'other'];
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
let preds = readJson(PRED_FILE, { predictions: [], results: {} });
let photos = readJson(PHOTO_META, { photos: [] });
function parseTime(t) {
  // accepts "52:30", "1:02:30" or seconds
  if (typeof t === 'number' && t > 0 && t < 4 * 3600) return Math.round(t);
  const m = String(t || '').trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const secs = (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
  return secs > 0 && secs < 4 * 3600 && Number(m[3]) < 60 ? secs : null;
}
const cleanName = (n) => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, 40) : '');
const soi6Open = (req) => Date.now() >= SOI6_REVEAL || isAdmin(req);

async function api2(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/predictions') {
    return send(res, 200, { raceStart: new Date(RACE_START).toISOString(), locked: Date.now() >= RACE_START, predictions: preds.predictions, results: preds.results });
  }
  if (req.method === 'POST' && pathname === '/api/predictions') {
    if (Date.now() >= RACE_START && !isAdmin(req)) return send(res, 400, { error: 'Predictions closed when the race started.' });
    if (rateLimited(req)) return send(res, 429, { error: 'Too many from here. Try again in a few minutes.' });
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
    const by = cleanName(b.by), runner = cleanName(b.runner), secs = parseTime(b.time);
    if (!by || !runner) return send(res, 400, { error: 'Pick your name and a runner.' });
    if (!secs) return send(res, 400, { error: 'Enter a time like 52:30.' });
    const i = preds.predictions.findIndex((p) => sameName(p.by, by) && sameName(p.runner, runner));
    const rec = { by, runner, seconds: secs, at: new Date().toISOString() };
    if (i >= 0) preds.predictions[i] = rec; else {
      if (preds.predictions.length >= 2000) return send(res, 400, { error: 'Too many predictions.' });
      preds.predictions.push(rec);
    }
    writeJson(PRED_FILE, preds);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/results') {
    if (Date.now() < RACE_START && !isAdmin(req)) return send(res, 400, { error: 'Finish times open when the race starts.' });
    if (rateLimited(req)) return send(res, 429, { error: 'Too many from here. Try again in a few minutes.' });
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
    const runner = cleanName(b.runner);
    if (!runner) return send(res, 400, { error: 'Pick a runner.' });
    if (b.time === '' && isAdmin(req)) { delete preds.results[runner]; writeJson(PRED_FILE, preds); return send(res, 200, { ok: true }); }
    const secs = parseTime(b.time);
    if (!secs) return send(res, 400, { error: 'Enter a time like 52:30.' });
    const existing = Object.keys(preds.results).find((k) => sameName(k, runner));
    if (existing && !isAdmin(req)) return send(res, 400, { error: 'That time is already in. Ask Sam to change it.' });
    preds.results[existing || runner] = secs;
    writeJson(PRED_FILE, preds);
    return send(res, 200, { ok: true });
  }

  // ---------- photos ----------
  if (req.method === 'GET' && pathname === '/api/photos') {
    const open = soi6Open(req);
    return send(res, 200, {
      soi6Reveal: new Date(SOI6_REVEAL).toISOString(), soi6Open: open,
      soi6Count: photos.photos.filter((p) => p.album === 'soi6').length,
      photos: photos.photos.filter((p) => open || p.album !== 'soi6'),
    });
  }
  if (req.method === 'POST' && pathname === '/api/photos') {
    if (rateLimited(req)) return send(res, 429, { error: 'Too many uploads from here. Try again in a few minutes.' });
    let b; try { b = await readBody(req, 6 * 1024 * 1024); } catch (e) { return send(res, 413, { error: 'That photo is too big.' }); }
    const by = cleanName(b.by), album = ALBUMS.includes(b.album) ? b.album : 'other';
    const caption = typeof b.caption === 'string' ? b.caption.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const m = String(b.image || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!by) return send(res, 400, { error: 'Add your name.' });
    if (!m) return send(res, 400, { error: 'Upload a photo.' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: 'That doesn’t look like a photo.' });
    if (photos.photos.length >= 1000) return send(res, 400, { error: 'The photo wall is full.' });
    const id = crypto.randomBytes(9).toString('hex');
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(path.join(PHOTO_DIR, id + '.jpg'), buf);
    photos.photos.push({ id, by, album, caption, at: new Date().toISOString() });
    writeJson(PHOTO_META, photos);
    return send(res, 200, { ok: true, id, hidden: album === 'soi6' && !soi6Open(req) });
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/photos/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin only' });
    const id = pathname.slice('/api/photos/'.length);
    const i = photos.photos.findIndex((p) => p.id === id);
    if (i < 0) return send(res, 404, { error: 'Not found' });
    photos.photos.splice(i, 1);
    writeJson(PHOTO_META, photos);
    fs.rm(path.join(PHOTO_DIR, id + '.jpg'), () => {});
    return send(res, 200, { ok: true });
  }
  return null;
}

function servePhoto(req, res, pathname) {
  const m = pathname.match(/^\/photos\/([a-f0-9]{18})\.jpg$/);
  if (!m) return send(res, 404, 'Not found');
  const meta = photos.photos.find((p) => p.id === m[1]);
  if (!meta || (meta.album === 'soi6' && !soi6Open(req))) return send(res, 404, 'Not found');
  fs.stat(path.join(PHOTO_DIR, m[1] + '.jpg'), (err) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': meta.album === 'soi6' ? 'private, no-store' : 'public, max-age=86400' });
    fs.createReadStream(path.join(PHOTO_DIR, m[1] + '.jpg')).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') return send(res, 200, 'ok');
  if (pathname.startsWith('/photos/')) return servePhoto(req, res, pathname);
  if (pathname.startsWith('/api/')) {
    return api2(req, res, pathname).then((done) => done === null ? api(req, res, pathname) : done).catch((e) => { console.error(e); send(res, 500, { error: 'Server error' }); });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Pattaya RSVP listening on :${PORT}${ADMIN_TOKEN ? '' : ' (no ADMIN_TOKEN set: admin editing disabled)'}`);
});
