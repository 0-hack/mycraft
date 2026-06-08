// Shared, deterministic Marina City terrain generation. No `three` or browser
// globals, so BOTH the client renderer and the Node server import it — the
// server uses it so monsters collide with the procedural city (walls/buildings),
// not just player-placed blocks. Block ids here MUST match blocks.js `B`.
import { hash2 } from './noise.js';

const B = {
  AIR: 0, BEDROCK: 1, GRASS: 2, DIRT: 3, STONE: 4, WOOD: 5, LEAVES: 6,
  SAND: 7, PLANKS: 8, WATER: 9, COBBLE: 10, BRICK: 11, GLASS: 12, LAMP: 13,
  CONCRETE: 14, ASPHALT: 15, ROADLINE: 16, GLASST: 17, GLASSG: 18,
  STEEL: 19, MARBLE: 20, NEON: 21, NEONP: 22,
};

// Marina City layout constants (kept in sync with world.js).
export const GEN = { GROUND: 22, WORLD_HEIGHT: 48, PERIOD: 16, ROAD: 4, FOOT0: 6, FOOT1: 13 };
const { GROUND, WORLD_HEIGHT, PERIOD, ROAD, FOOT0, FOOT1 } = GEN;
const imod = (n, m) => ((n % m) + m) % m;

export class WorldGen {
  constructor(seed) {
    this.seed = seed;
    this.cellCache = new Map();
  }

  // Per city cell (one grid square): what occupies it and how tall.
  cellAt(cx, cz) {
    const k = `${cx},${cz}`;
    let info = this.cellCache.get(k);
    if (info !== undefined) return info;
    // The spawn cell is always an open bayside plaza (lands players safely).
    if (cx === 0 && cz === 0) { info = { kind: 'plaza' }; this.cellCache.set(k, info); return info; }
    const r = hash2(cx, cz, this.seed);
    let kind;
    if (r < 0.10) kind = 'bay';        // Marina water
    else if (r < 0.26) kind = 'park';  // green plaza + supertree
    else kind = 'tower';
    const buildH = 6 + Math.floor(hash2(cx + 11, cz - 7, this.seed) * 16); // 6..21
    const treeH = 8 + Math.floor(hash2(cx - 5, cz + 13, this.seed) * 5);   // 8..12
    const glass = hash2(cx + 3, cz + 3, this.seed) < 0.5 ? B.GLASST : B.GLASSG;
    const neon = hash2(cx - 9, cz + 1, this.seed) < 0.5 ? B.NEON : B.NEONP;
    info = { kind, buildH, treeH, glass, neon };
    this.cellCache.set(k, info);
    return info;
  }

  baseBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return B.AIR;
    if (y === 0) return B.BEDROCK;

    const lx = imod(x, PERIOD), lz = imod(z, PERIOD);
    const isRoad = lx < ROAD || lz < ROAD;
    const cell = this.cellAt(Math.floor(x / PERIOD), Math.floor(z / PERIOD));

    // Bay cells are a sunken pool of Marina water.
    if (!isRoad && cell.kind === 'bay') {
      if (y < GROUND - 3) return B.STONE;
      if (y <= GROUND) return B.WATER;
      return B.AIR;
    }

    // Solid ground fill below the street surface.
    if (y < GROUND) return B.STONE;

    // The street/plaza surface.
    if (y === GROUND) {
      if (isRoad) {
        const inter = lx < ROAD && lz < ROAD; // intersection
        const line = !inter && ((lx === 2 && lz >= ROAD) || (lz === 2 && lx >= ROAD));
        return line ? B.ROADLINE : B.ASPHALT;
      }
      const sidewalk = lx < FOOT0 || lx > FOOT1 || lz < FOOT0 || lz > FOOT1;
      if (sidewalk) return B.CONCRETE;
      if (cell.kind === 'park') return B.GRASS;
      return B.CONCRETE; // tower lobby floor / plaza
    }

    // Above the surface: buildings, lamps, supertrees, landmarks.
    return this.cityFeature(x, y, z, lx, lz, cell, isRoad);
  }

  cityFeature(x, y, z, lx, lz, cell, isRoad) {
    // Street lamps: one neon post per cell, by the road corner.
    if (lx === 1 && lz === 1) {
      if (y <= GROUND + 2) return B.STEEL;
      if (y === GROUND + 3) return cell.neon || B.NEON;
    }
    if (isRoad) return B.AIR;

    // Merlion landmark in the spawn plaza.
    if (cell.kind === 'plaza') {
      const m = this.merlion(x, y, z, lx, lz);
      if (m !== B.AIR) return m;
      return B.AIR;
    }

    // Supertrees (can overhang into neighbouring columns).
    if (cell.kind === 'park' || this.nearPark(x, z)) {
      const t = this.supertreeFeature(x, y, z);
      if (t !== B.AIR) return t;
    }
    if (cell.kind !== 'tower') return B.AIR;

    // Glass tower: hollow shell with a steel frame, periodic floors, a door,
    // and a glowing neon crown. Inhabitable for defensive bases.
    const h = cell.buildH;
    const onFoot = lx >= FOOT0 && lx <= FOOT1 && lz >= FOOT0 && lz <= FOOT1;
    if (!onFoot) return B.AIR;
    const border = lx === FOOT0 || lx === FOOT1 || lz === FOOT0 || lz === FOOT1;
    const corner = (lx === FOOT0 || lx === FOOT1) && (lz === FOOT0 || lz === FOOT1);

    if (y === GROUND + h + 1) return border ? (cell.neon || B.NEON) : B.AIR; // crown
    if (y > GROUND + h) return B.AIR;

    if (border) {
      // Entrance: a 2-wide door on the +lz face at ground level.
      const door = lz === FOOT1 && (lx === 9 || lx === 10) && (y === GROUND + 1 || y === GROUND + 2);
      if (door) return B.AIR;
      return corner ? B.STEEL : cell.glass;
    }
    // Interior: a concrete floor slab every 4 levels, otherwise open.
    if ((y - GROUND) % 4 === 0) return B.CONCRETE;
    return B.AIR;
  }

  // Is any neighbouring cell a park (so a supertree canopy can reach here)?
  nearPark(x, z) {
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const c = this.cellAt(Math.floor((x + dx) / PERIOD), Math.floor((z + dz) / PERIOD));
        if (c.kind === 'park') return true;
      }
    return false;
  }

  // A supertree sits at the centre of each park cell: tall trunk + glowing disc.
  supertreeFeature(x, y, z) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const cx = Math.floor((x + dx) / PERIOD), cz = Math.floor((z + dz) / PERIOD);
        const cell = this.cellAt(cx, cz);
        if (cell.kind !== 'park') continue;
        // Trunk only at the park cell centre column.
        const tx = cx * PERIOD + 9, tz = cz * PERIOD + 9;
        if (x + dx !== tx || z + dz !== tz) continue;
        const top = GROUND + cell.treeH;
        if (dx === 0 && dz === 0 && y > GROUND && y <= top) return B.STEEL; // trunk
        const dist = Math.abs(dx) + Math.abs(dz);
        if (y >= top && y <= top + 1) {
          const rad = (y === top + 1) ? 1 : 2;
          if (dist <= rad && !(dx === 0 && dz === 0 && y <= top))
            return (y === top + 1) ? (cell.neon || B.NEONP) : B.LEAVES;
        }
      }
    }
    return B.AIR;
  }

  // A simple marble Merlion statue + reflecting pool in the spawn plaza.
  merlion(x, y, z, lx, lz) {
    if (lx === 10 && lz === 10) {            // body column
      if (y <= GROUND + 4) return B.MARBLE;
      if (y === GROUND + 5) return B.MARBLE; // head
    }
    if (lx === 10 && lz === 11 && y === GROUND + 4) return B.WATER; // spout
    if (lx === 10 && lz === 12 && y === GROUND + 3) return B.WATER;
    return B.AIR;
  }

  // Solid for entity collision: anything that isn't air or water.
  isSolidBase(x, y, z) {
    const t = this.baseBlock(x, y, z);
    return t !== B.AIR && t !== B.WATER;
  }
}
