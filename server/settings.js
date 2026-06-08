// Admin-tunable runtime settings, persisted in the `settings` table. Changing
// `difficulty` applies a preset to the spawn/economy values, which the admin can
// then fine-tune individually.
import { CONFIG } from './config.js';
import { settingsQueries } from './db.js';

const DEFAULTS = {
  difficulty: 'normal',          // easy | normal | hard
  pickupCap: CONFIG.PICKUP_CAP,  // max simultaneous health/food pickups
  pickupIntervalMs: CONFIG.PICKUP_INTERVAL_MS,
  medkitEnabled: 1,              // objects to deploy: healing patches
  foodEnabled: 1,                // objects to deploy: food
  sellMultiplier: 1,             // multiplies material sell prices
  dropLifetimeMs: 24 * 60 * 60 * 1000, // loot despawns after a day
  inactiveDays: 30,              // accounts idle longer than this are purged
  mobEnabled: 1,                 // spawn monsters for solo training/PvE
  mobCap: 8,                     // hard ceiling on simultaneous monsters
  mobPerPlayer: 3,               // monsters scale with the number of online players
  mobIntervalMs: 9000,           // how often a monster spawns
  mobPower: 1,                   // scales monster health & damage
  chatMinIntervalMs: 1200,       // min gap between chat messages (anti-spam)
  wingsForAll: 0,                // 1 = every player can fly (wings); admins always can
  // Player / combat tuning (balanced defaults).
  spawnProtectSec: 5,            // invulnerable to fall + attacks on each spawn
  hungerDrainMult: 0.6,          // <1 = hunger drains slower
  staminaDrainSec: 5,            // seconds of sprint to deplete stamina
  staminaRefillSec: 7,           // seconds to refill stamina
  moveSpeedMult: 1,              // global movement-speed multiplier
  skillDmgMult: 1,               // global skill damage multiplier
  skillRangeMult: 1,             // global skill range/radius multiplier
  skillCdMult: 1,                // global skill cooldown multiplier
};

// Per-difficulty presets applied to spawn rate + economy when difficulty changes.
const PRESETS = {
  easy:   { pickupCap: 20, pickupIntervalMs: 5000,  sellMultiplier: 1.5, mobCap: 5,  mobIntervalMs: 12000, mobPower: 0.8 },
  normal: { pickupCap: 14, pickupIntervalMs: 7000,  sellMultiplier: 1,   mobCap: 8,  mobIntervalMs: 9000,  mobPower: 1 },
  hard:   { pickupCap: 8,  pickupIntervalMs: 12000, sellMultiplier: 0.7, mobCap: 14, mobIntervalMs: 6000,  mobPower: 1.4 },
};

const NUMERIC = new Set([
  'pickupCap', 'pickupIntervalMs', 'medkitEnabled', 'foodEnabled',
  'sellMultiplier', 'dropLifetimeMs', 'inactiveDays',
  'mobEnabled', 'mobCap', 'mobPerPlayer', 'mobIntervalMs', 'mobPower', 'chatMinIntervalMs', 'wingsForAll',
  'spawnProtectSec', 'hungerDrainMult', 'staminaDrainSec', 'staminaRefillSec',
  'moveSpeedMult', 'skillDmgMult', 'skillRangeMult', 'skillCdMult',
]);

// The subset of settings the client needs to apply locally (move/hunger/stamina/skills).
export function clientTuning() {
  return {
    moveSpeedMult: settings.moveSpeedMult,
    hungerDrainMult: settings.hungerDrainMult,
    staminaDrainSec: settings.staminaDrainSec,
    staminaRefillSec: settings.staminaRefillSec,
    skillRangeMult: settings.skillRangeMult,
    skillCdMult: settings.skillCdMult,
  };
}

const settings = { ...DEFAULTS };

// Load any persisted overrides on startup.
for (const row of settingsQueries.all.all()) {
  if (!(row.key in DEFAULTS)) continue;
  settings[row.key] = NUMERIC.has(row.key) ? Number(row.value) : row.value;
}

export function getSettings() {
  return { ...settings };
}

function persist(key, value) {
  settingsQueries.set.run(key, String(value));
}

// Apply a patch of settings, validating + persisting each. Returns the new set.
export function updateSettings(patch) {
  if (patch && typeof patch.difficulty === 'string' && PRESETS[patch.difficulty]) {
    settings.difficulty = patch.difficulty;
    persist('difficulty', patch.difficulty);
    for (const [k, v] of Object.entries(PRESETS[patch.difficulty])) {
      settings[k] = v;
      persist(k, v);
    }
  }
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'difficulty' || !(k in DEFAULTS)) continue;
    if (NUMERIC.has(k)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      settings[k] = n;
    } else {
      settings[k] = v;
    }
    persist(k, settings[k]);
  }
  return getSettings();
}
