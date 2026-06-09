// SQLite persistence layer. Stores accounts, per-player state, the centralised
// world (block edits), dropped loot on the ground, and admin-tunable settings.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
const dbPath = path.join(CONFIG.DATA_DIR, 'mycraft.sqlite');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    pass_hash  TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_active INTEGER
  );

  CREATE TABLE IF NOT EXISTS player_state (
    user_id    INTEGER PRIMARY KEY,
    x REAL, y REAL, z REAL,
    yaw REAL, pitch REAL,
    health REAL DEFAULT 20,
    hunger REAL DEFAULT 20,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    score INTEGER DEFAULT 0,
    cash INTEGER DEFAULT 0,
    blocks_mined INTEGER DEFAULT 0,
    blocks_placed INTEGER DEFAULT 0,
    inventory  TEXT,
    achievements TEXT,
    appearance TEXT,
    equipment TEXT,
    progress TEXT,
    updated_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- The centralised, shared world. Only edits to the procedural terrain are
  -- stored. type = 0 means the block was removed (air).
  CREATE TABLE IF NOT EXISTS world_blocks (
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    z INTEGER NOT NULL,
    type INTEGER NOT NULL,
    updated_at INTEGER,
    PRIMARY KEY (x, y, z)
  );

  -- Loot dropped on death. Anyone alive can pick it up; it despawns after a day.
  CREATE TABLE IF NOT EXISTS ground_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    x REAL, y REAL, z REAL,
    cash       INTEGER NOT NULL DEFAULT 0,
    materials  TEXT,
    owner_name TEXT,
    dropped_at INTEGER NOT NULL
  );

  -- Admin-tunable key/value settings (difficulty, spawn rates, lifecycle…).
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---- Lightweight migrations for pre-existing databases --------------------
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}
ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'last_active', 'INTEGER');
ensureColumn('users', 'banned', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'muted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'can_fly', 'INTEGER NOT NULL DEFAULT 0'); // admin-granted wings
ensureColumn('users', 'guide_seen', 'INTEGER NOT NULL DEFAULT 0'); // new-player guide shown once
ensureColumn('player_state', 'cash', 'INTEGER DEFAULT 0');
ensureColumn('player_state', 'appearance', 'TEXT');
ensureColumn('player_state', 'equipment', 'TEXT');
ensureColumn('player_state', 'progress', 'TEXT');
ensureColumn('player_state', 'consumables', 'TEXT');
// Custom respawn point ("Set spawn here"). NULL = use the world default spawn.
ensureColumn('player_state', 'spawn_x', 'REAL');
ensureColumn('player_state', 'spawn_y', 'REAL');
ensureColumn('player_state', 'spawn_z', 'REAL');

// ---- Users ---------------------------------------------------------------
export const userQueries = {
  create: db.prepare(
    'INSERT INTO users (username, pass_hash, is_admin, created_at, last_active) VALUES (?, ?, ?, ?, ?)'
  ),
  byUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM users'),
  all: db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.banned, u.muted, u.can_fly, u.created_at, u.last_active,
           s.score, s.level, s.cash, s.blocks_mined
    FROM users u LEFT JOIN player_state s ON s.user_id = u.id
    ORDER BY u.last_active DESC NULLS LAST, u.created_at DESC
  `),
  touch: db.prepare('UPDATE users SET last_active = ? WHERE id = ?'),
  setGuideSeen: db.prepare('UPDATE users SET guide_seen = 1 WHERE id = ?'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  setBanned: db.prepare('UPDATE users SET banned = ? WHERE id = ?'),
  setMuted: db.prepare('UPDATE users SET muted = ? WHERE id = ?'),
  setWings: db.prepare('UPDATE users SET can_fly = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM users WHERE id = ?'),
  inactiveBefore: db.prepare('SELECT id, username FROM users WHERE COALESCE(last_active, created_at) < ? AND is_admin = 0'),
};

// ---- Player state --------------------------------------------------------
export const stateQueries = {
  get: db.prepare('SELECT * FROM player_state WHERE user_id = ?'),
  upsert: db.prepare(`
    INSERT INTO player_state
      (user_id, x, y, z, yaw, pitch, health, hunger, xp, level, score, cash,
       blocks_mined, blocks_placed, inventory, achievements, appearance, equipment, progress, consumables,
       spawn_x, spawn_y, spawn_z, updated_at)
    VALUES
      (@user_id, @x, @y, @z, @yaw, @pitch, @health, @hunger, @xp, @level,
       @score, @cash, @blocks_mined, @blocks_placed, @inventory, @achievements, @appearance, @equipment, @progress, @consumables,
       @spawn_x, @spawn_y, @spawn_z, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      x=@x, y=@y, z=@z, yaw=@yaw, pitch=@pitch, health=@health, hunger=@hunger,
      xp=@xp, level=@level, score=@score, cash=@cash, blocks_mined=@blocks_mined,
      blocks_placed=@blocks_placed, inventory=@inventory,
      achievements=@achievements, appearance=@appearance, equipment=@equipment, progress=@progress, consumables=@consumables,
      spawn_x=@spawn_x, spawn_y=@spawn_y, spawn_z=@spawn_z, updated_at=@updated_at
  `),
  delete: db.prepare('DELETE FROM player_state WHERE user_id = ?'),
  leaderboard: db.prepare(`
    SELECT u.username, s.score, s.level, s.cash, s.blocks_mined
    FROM player_state s JOIN users u ON u.id = s.user_id
    ORDER BY s.score DESC LIMIT 10
  `),
};

// ---- World ---------------------------------------------------------------
export const worldQueries = {
  all: db.prepare('SELECT x, y, z, type FROM world_blocks'),
  set: db.prepare(`
    INSERT INTO world_blocks (x, y, z, type, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(x, y, z) DO UPDATE SET type=excluded.type, updated_at=excluded.updated_at
  `),
};

// ---- Ground items (dropped loot) -----------------------------------------
export const groundQueries = {
  all: db.prepare('SELECT * FROM ground_items'),
  insert: db.prepare(`
    INSERT INTO ground_items (x, y, z, cash, materials, owner_name, dropped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  delete: db.prepare('DELETE FROM ground_items WHERE id = ?'),
  deleteOlderThan: db.prepare('DELETE FROM ground_items WHERE dropped_at < ?'),
};

// ---- Settings ------------------------------------------------------------
export const settingsQueries = {
  all: db.prepare('SELECT key, value FROM settings'),
  set: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `),
};
