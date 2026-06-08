// MyCraft server: serves the static client, exposes the auth REST API, the
// leaderboard, account management and an authenticated admin API, and hosts the
// multiplayer WebSocket game hub.
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { register, login, verifyToken, verifyAdmin } from './auth.js';
import { stateQueries, userQueries } from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { attachGame } from './game.js';
import { editCount } from './world.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const result = register(username, password);
  res.status(result.error ? 400 : 200).json(result);
});

app.post('/api/login', (req, res) => {
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

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const settings = updateSettings(req.body && req.body.settings);
  game.broadcastTuning(); // push client-side tunables live
  res.json({ ok: true, settings });
});

app.post('/api/admin/deploy', requireAdmin, (req, res) => {
  const { kind, n } = req.body || {};
  const count = game.deploy(kind, Math.max(1, Math.min(20, Number(n) || 1)));
  res.json({ ok: true, deployed: count });
});

app.post('/api/admin/user', requireAdmin, (req, res) => {
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
  console.log(`     Admin panel: http://localhost:${CONFIG.PORT}/admin.html (admin user: "${CONFIG.ADMIN_USERNAME}")\n`);
});
