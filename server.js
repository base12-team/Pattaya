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
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) { reject(new Error('too big')); req.destroy(); } });
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
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
    if (g.status === 'no') g.role = '';
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

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') return send(res, 200, 'ok');
  if (pathname.startsWith('/api/')) {
    return api(req, res, pathname).catch((e) => { console.error(e); send(res, 500, { error: 'Server error' }); });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Pattaya RSVP listening on :${PORT}${ADMIN_TOKEN ? '' : ' (no ADMIN_TOKEN set: admin editing disabled)'}`);
});
