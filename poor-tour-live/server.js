'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'tournament.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 10 || !SESSION_SECRET || SESSION_SECRET.length < 24) {
  console.error('Set ADMIN_PASSWORD (10+ characters) and SESSION_SECRET (24+ characters) before starting. See README.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
let db;
if (fs.existsSync(DATA_FILE)) {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} else {
  db = {
    event: { title: 'Poor Tour', course: '', date: '', pars: Array(18).fill(4) },
    teams: [], scores: {}, nextId: 1, version: 1
  };
  persist();
}
function persist() {
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, DATA_FILE);
}
const publicData = () => ({ event: db.event, teams: db.teams.map(({ pinHash, ...t }) => t), scores: db.scores, version: db.version });
let listeners = new Set();
function publish() {
  db.version++;
  persist();
  const message = `event: update\ndata: ${JSON.stringify(publicData())}\n\n`;
  for (const response of listeners) { try { response.write(message); } catch { listeners.delete(response); } }
}
function json(res, status, object) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(object)); }
function error(res, code, message) { json(res, code, { error: message }); }
function sign(claims) {
  const body = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function verify(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest();
  let got;
  try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (claims.exp < Date.now()) return null;
    if (claims.role === 'team' && !db.teams.some(t => t.id === claims.teamId)) return null;
    return claims;
  } catch { return null; }
}
const pinHash = (pin) => crypto.createHash('sha256').update(`poor-tour-pin:${SESSION_SECRET}:${pin}`).digest('hex');
function secureEq(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function clean(s, length = 80) { return String(s ?? '').trim().slice(0, length); }
function getBody(req) { return new Promise((resolve, reject) => {
  let body = '';
  req.on('data', b => { body += b; if (body.length > 25000) { reject(new Error('Request too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
  req.on('error', reject);
}); }
const attempts = new Map();
function rateLimited(req, res) {
  const key = req.socket.remoteAddress || 'unknown', now = Date.now();
  const hits = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  hits.push(now); attempts.set(key, hits);
  if (hits.length > 40) { error(res, 429, 'Too many login attempts. Try again later.'); return true; }
  return false;
}
function authCheck(res, auth, admin = false) {
  if (!auth || (admin && auth.role !== 'admin')) { error(res, 403, 'Not authorized'); return false; }
  return true;
}
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, publicData());
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: update\ndata: ${JSON.stringify(publicData())}\n\n`);
    listeners.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(keepAlive); listeners.delete(res); });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body;
    try { body = await getBody(req); } catch (e) { return error(res, 400, e.message); }
    if (url.pathname === '/api/login') {
      if (rateLimited(req, res)) return;
      if (body.role === 'admin' && typeof body.password === 'string' && secureEq(body.password, ADMIN_PASSWORD)) return json(res, 200, { token: sign({ role: 'admin' }), role: 'admin' });
      if (body.role === 'team') {
        const team = db.teams.find(t => t.id === Number(body.teamId));
        if (team && /^\d{6}$/.test(String(body.pin ?? '')) && secureEq(team.pinHash, pinHash(String(body.pin)))) return json(res, 200, { token: sign({ role: 'team', teamId: team.id }), role: 'team', teamId: team.id });
      }
      return error(res, 401, 'Incorrect credentials');
    }
    const auth = verify(req);
    if (url.pathname === '/api/event') {
      if (!authCheck(res, auth, true)) return;
      const pars = body.pars;
      if (!Array.isArray(pars) || pars.length !== 18 || pars.some(n => !Number.isInteger(n) || n < 3 || n > 6)) return error(res, 400, 'Enter 18 hole pars between 3 and 6');
      db.event = { title: clean(body.title, 100) || 'Poor Tour', course: clean(body.course, 100), date: clean(body.date, 20), pars };
      publish(); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/team/create') {
      if (!authCheck(res, auth, true)) return;
      const name = clean(body.name), player1 = clean(body.player1), player2 = clean(body.player2), group = clean(body.group, 30);
      if (!name || !player1 || !player2) return error(res, 400, 'Team name and both player names are required');
      const id = db.nextId++;
      const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      db.teams.push({ id, name, player1, player2, group, pinHash: pinHash(pin) });
      db.scores[id] = {};
      publish(); return json(res, 200, { ok: true, pin, id });
    }
    if (url.pathname === '/api/team/update') {
      if (!authCheck(res, auth, true)) return;
      const team = db.teams.find(t => t.id === Number(body.id));
      if (!team) return error(res, 404, 'Team not found');
      const name = clean(body.name), player1 = clean(body.player1), player2 = clean(body.player2);
      if (!name || !player1 || !player2) return error(res, 400, 'Team name and players are required');
      Object.assign(team, { name, player1, player2, group: clean(body.group, 30) });
      publish(); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/team/reset-pin') {
      if (!authCheck(res, auth, true)) return;
      const team = db.teams.find(t => t.id === Number(body.id));
      if (!team) return error(res, 404, 'Team not found');
      const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      team.pinHash = pinHash(pin); publish(); return json(res, 200, { ok: true, pin });
    }
    if (url.pathname === '/api/team/delete') {
      if (!authCheck(res, auth, true)) return;
      const idx = db.teams.findIndex(t => t.id === Number(body.id));
      if (idx < 0) return error(res, 404, 'Team not found');
      db.teams.splice(idx, 1); delete db.scores[Number(body.id)];
      publish(); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/score') {
      if (!authCheck(res, auth)) return;
      const teamId = Number(body.teamId), hole = Number(body.hole);
      if (auth.role !== 'admin' && auth.teamId !== teamId) return error(res, 403, 'You can only edit your own team');
      if (!db.teams.some(t => t.id === teamId) || !Number.isInteger(hole) || hole < 1 || hole > 18) return error(res, 400, 'Invalid team or hole');
      if (body.clear === true) { delete db.scores[teamId][hole]; publish(); return json(res, 200, { ok: true }); }
      const valid = n => Number.isInteger(n) && n >= 1 && n <= 20;
      let score;
      if (hole <= 6) {
        if (!valid(body.a) || !valid(body.b)) return error(res, 400, 'Enter both golfers’ strokes (1–20)');
        score = { a: body.a, b: body.b };
      } else {
        if (!valid(body.score)) return error(res, 400, 'Enter strokes (1–20)');
        score = { score: body.score };
      }
      db.scores[teamId][hole] = score;
      publish(); return json(res, 200, { ok: true });
    }
    return error(res, 404, 'Unknown endpoint');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, 'Method not allowed');
  let filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!['index.html', 'styles.css', 'app.js', 'favicon.svg', 'pour-tour-logo.webp'].includes(filename)) return error(res, 404, 'Not found');
  const file = path.join(__dirname, 'public', filename);
  const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};
  res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
http.createServer((req, res) => Promise.resolve(route(req, res)).catch(e => { console.error(e); if (!res.headersSent) error(res, 500, 'Internal server error'); else res.end(); })).listen(PORT, HOST, () => console.log(`Poor Tour: http://localhost:${PORT}`));
