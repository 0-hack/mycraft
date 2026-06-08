// Central configuration for the MyCraft server.
// Values can be overridden with environment variables.
import crypto from 'crypto';

// Token-signing secret. NEVER ship a hardcoded default — a known secret lets
// anyone forge admin tokens. If JWT_SECRET isn't provided we generate a random
// per-process secret (so tokens are unforgeable; everyone is logged out on
// restart until the operator sets a persistent JWT_SECRET).
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  JWT_SECRET,
  JWT_SECRET_FROM_ENV: !!process.env.JWT_SECRET,
  TOKEN_TTL: '30d',
  // Deterministic world seed shared by every client so the base terrain
  // generated in the browser is identical for everyone. Only player edits
  // (placed / removed blocks) are stored on the server.
  WORLD_SEED: parseInt(process.env.WORLD_SEED || '1337', 10),
  // How often (ms) a full game day passes. 20 minutes like Minecraft.
  DAY_LENGTH_MS: 20 * 60 * 1000,
  // How often player state is flushed to disk while connected.
  AUTOSAVE_INTERVAL_MS: 15 * 1000,
  DATA_DIR: process.env.DATA_DIR || 'data',
  // Collectible healing/food pickups scattered around players (defaults; the
  // live values are admin-tunable via the settings table).
  PICKUP_CAP: 14,
  PICKUP_INTERVAL_MS: 7 * 1000,
  // Bootstrap admin: the very first registered account becomes admin. A specific
  // admin username is honoured ONLY when explicitly set via the env var (so the
  // default name can't be claimed by anyone to escalate privileges).
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_USERNAME_FROM_ENV: !!process.env.ADMIN_USERNAME,
  // Sell value (cash) per unit for each mined material, by block id.
  MATERIAL_PRICES: {
    2: 1,   // grass
    3: 1,   // dirt
    4: 3,   // stone
    5: 5,   // wood
    6: 1,   // leaves
    7: 2,   // sand
    8: 4,   // planks
    10: 3,  // cobble
    11: 6,  // brick
    12: 8,  // glass
    13: 10, // lamp
    14: 4,  // concrete
    15: 3,  // asphalt
    16: 3,  // road line
    17: 9,  // blue tower glass
    18: 9,  // green tower glass
    19: 12, // steel
    20: 14, // marble
    21: 11, // neon
    22: 11, // pink neon
  },
};
