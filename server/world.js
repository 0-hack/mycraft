// In-memory cache of the centralised world's block edits, backed by SQLite.
// The procedural base terrain is generated client-side from CONFIG.WORLD_SEED;
// here we only track and persist deviations from it.
import { worldQueries } from './db.js';

const edits = new Map(); // "x,y,z" -> type (0 = air/removed)

// Load all persisted edits into memory on startup.
for (const row of worldQueries.all.all()) {
  edits.set(`${row.x},${row.y},${row.z}`, row.type);
}

export function getAllEdits() {
  const out = [];
  for (const [key, type] of edits) {
    const [x, y, z] = key.split(',').map(Number);
    out.push({ x, y, z, t: type });
  }
  return out;
}

export function setBlock(x, y, z, type) {
  x = Math.round(x); y = Math.round(y); z = Math.round(z);
  edits.set(`${x},${y},${z}`, type);
  worldQueries.set.run(x, y, z, type, Date.now());
  return { x, y, z, t: type };
}

// The player-edited block at an integer cell, or undefined if untouched (the
// base procedural terrain is generated client-side and not known here).
export function getEditBlock(x, y, z) {
  return edits.get(`${x},${y},${z}`);
}

// A player-placed block counts as solid for mob collision. type 0 = removed
// (air); 9 = water. Everything else players can place is a solid obstacle.
export function isSolidEditType(t) {
  return t != null && t !== 0 && t !== 9;
}

export function editCount() {
  return edits.size;
}
