// MyCraft server: serves the static client, exposes the auth REST API, the
// leaderboard, account management and an authenticated admin API, and hosts the
// multiplayer WebSocket game hub.
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { register, login, verifyToken, verifyAdmin } from './auth.js';
import { stateQueries, userQueries } from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { attachGame } from './game.js';
import { editCount } from './world.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
// When running behind a reverse proxy, set TRUST_PROXY (e.g. =1) so the client's
// real IP (X-Forwarded-For) is used for rate limiting instead of the proxy's.
app.set('trust proxy', process.env.TRUST_PROXY ? (Number(process.env.TRUST_PROXY) || 1) : false);

// Small JSON body limit for normal API calls (auth/settings); only the admin
// music-upload route gets a large limit. This prevents anyone from flooding the
// unauthenticated endpoints with huge payloads.
const smallJson = express.json({ limit: '32kb' });
const bigJson = express.json({ limit: '14mb' });
app.use((req, res, next) =>
  (req.path === '/api/admin/music' ? bigJson : smallJson)(req, res, next));
app.use(express.static(PUBLIC_DIR));

// Lightweight per-IP rate limiter (in-memory). Keyed on the socket address so it
// can't be bypassed by spoofing X-Forwarded-For. Protects against brute-force
// logins and request floods.
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, reset }
  // Drop expired entries so a flood of distinct IPs can't grow the map forever.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of hits) if (now > e.reset) hits.delete(ip);
  }, windowMs).unref?.();
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; hits.set(ip, e); }
    e.count += 1;
    if (e.count > max) {
      res.set('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
    }
    next();
  };
}
// Periodically drop stale entries so the map can't grow unbounded.
// Generous enough not to disrupt legitimate (possibly proxy-shared) traffic,
// but low enough to stop password brute-forcing and request floods.
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });

app.post('/api/register', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const result = register(username, password);
  res.status(result.error ? 400 : 200).json(result);
});

app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password);
  res.status(result.error ? 401 : 200).json(result);
});

app.get('/api/leaderboard', (_req, res) => {
  res.json({ leaders: stateQueries.leaderboard.all() });
});

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, edits: editCount(), seed: CONFIG.WORLD_SEED });
});

// ---- token helpers -------------------------------------------------------
function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return (req.body && req.body.token) || null;
}

// A logged-in player deletes their own account.
app.delete('/api/account', (req, res) => {
  const payload = verifyToken(tokenFrom(req));
  if (!payload) return res.status(401).json({ error: 'Not authenticated.' });
  game.deleteUser(payload.id);
  res.json({ ok: true });
});

// ---- admin API -----------------------------------------------------------
function requireAdmin(req, res, next) {
  const admin = verifyAdmin(tokenFrom(req));
  if (!admin) return res.status(403).json({ error: 'Admin access required.' });
  req.admin = admin;
  next();
}

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  res.json({
    settings: getSettings(),
    prices: CONFIG.MATERIAL_PRICES,
    users: userQueries.all.all(),
    online: game.onlinePlayers(),
    ground: game.groundItems(),
    mobs: game.mobList(),
    chat: game.recentChat(),
  });
});

app.post('/api/admin/settings', adminLimiter, requireAdmin, (req, res) => {
  const settings = updateSettings(req.body && req.body.settings);
  game.broadcastTuning(); // push client-side tunables live
  game.refreshFly();      // wingsForAll may have changed — update fly permission
  res.json({ ok: true, settings });
});

// Upload a looping background-music track (admin). Body: { dataUrl } where
// dataUrl is a base64 data URL of an audio file. Replaces the procedural music
// for everyone; the file is served statically from /uploads.
// Extension is always taken from this whitelist (defaulting to mp3), so the
// stored filename can never be attacker-controlled (no path traversal / no
// executable extensions). The file is also always served with an audio/*
// content-type, so even a mislabelled file is inert in the browser.
const MUSIC_EXT = ['mp3', 'ogg', 'wav', 'webm', 'm4a', 'aac'];
function clearMusicFiles() {
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (f.startsWith('bgmusic.')) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch { /* ignore */ } }
  }
}
// Reject content that is clearly web markup/script (defence-in-depth so an
// uploaded file can never be abused to serve HTML/JS from our origin).
function looksLikeMarkup(buf) {
  const head = buf.slice(0, 64).toString('latin1').trim().toLowerCase();
  return head.startsWith('<') || head.includes('<script') || head.includes('<!doctype') || head.includes('<html');
}
app.post('/api/admin/music', adminLimiter, requireAdmin, (req, res) => {
  const dataUrl = req.body && req.body.dataUrl;
  if (typeof dataUrl !== 'string' || dataUrl.length > 18 * 1024 * 1024) {
    return res.status(400).json({ error: 'No file provided (or too large).' });
  }
  const m = /^data:audio\/([\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Please choose a valid audio file.' });
  let ext = m[1].toLowerCase().replace('mpeg', 'mp3').replace('x-', '');
  if (!MUSIC_EXT.includes(ext)) ext = 'mp3'; // never trust the supplied subtype for the filename
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return res.status(400).json({ error: 'Empty file.' });
  if (buf.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max ~12 MB).' });
  if (looksLikeMarkup(buf)) return res.status(400).json({ error: "That doesn't look like an audio file." });
  clearMusicFiles();
  const fname = `bgmusic.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  const url = `/uploads/${fname}?v=${Date.now()}`;
  updateSettings({ musicUrl: url });
  game.broadcastMusic(url);
  res.json({ ok: true, url });
});
app.post('/api/admin/music/reset', adminLimiter, requireAdmin, (_req, res) => {
  clearMusicFiles();
  updateSettings({ musicUrl: '' });
  game.broadcastMusic('');
  res.json({ ok: true });
});

app.post('/api/admin/deploy', adminLimiter, requireAdmin, (req, res) => {
  const { kind, n } = req.body || {};
  const count = game.deploy(kind, Math.max(1, Math.min(20, Number(n) || 1)));
  res.json({ ok: true, deployed: count });
});

app.post('/api/admin/user', adminLimiter, requireAdmin, (req, res) => {
  const { action, id } = req.body || {};
  const userId = Number(id);
  const target = userQueries.byId.get(userId);
  if (!target) return res.status(404).json({ error: 'No such user.' });
  switch (action) {
    case 'delete':
      if (userId === req.admin.id) return res.status(400).json({ error: 'You cannot delete yourself here.' });
      game.deleteUser(userId);
      break;
    case 'reset': game.resetUser(userId); break;
    case 'kick': game.kick(userId); break;
    case 'ban':
      if (userId === req.admin.id) return res.status(400).json({ error: 'You cannot ban yourself.' });
      game.setBanned(userId, true); break;
    case 'unban': game.setBanned(userId, false); break;
    case 'mute': game.setMuted(userId, true); break;
    case 'unmute': game.setMuted(userId, false); break;
    case 'wings': game.setWings(userId, true); break;
    case 'unwings': game.setWings(userId, false); break;
    case 'promote': userQueries.setAdmin.run(1, userId); break;
    case 'demote':
      if (userId === req.admin.id) return res.status(400).json({ error: 'You cannot demote yourself.' });
      userQueries.setAdmin.run(0, userId);
      break;
    default: return res.status(400).json({ error: 'Unknown action.' });
  }
  res.json({ ok: true });
});

const server = http.createServer(app);
const game = attachGame(server);

server.listen(CONFIG.PORT, () => {
  console.log(`\n  ⛏  MyCraft running at http://localhost:${CONFIG.PORT}`);
  console.log(`     World seed: ${CONFIG.WORLD_SEED} | stored edits: ${editCount()}`);
  const adminNote = CONFIG.ADMIN_USERNAME_FROM_ENV
    ? `designated admin: "${CONFIG.ADMIN_USERNAME}"`
    : 'the first account to register becomes admin';
  console.log(`     Admin panel: http://localhost:${CONFIG.PORT}/admin.html (${adminNote})`);
  if (!CONFIG.JWT_SECRET_FROM_ENV) {
    console.warn('  ⚠  JWT_SECRET is not set — using a random secret for this run.');
    console.warn('     Set the JWT_SECRET env var in production so sessions survive restarts.');
  }
  console.log('');
});
