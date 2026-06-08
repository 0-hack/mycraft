// Client-side voxel world: deterministic procedural terrain, server edit
// overlay, and chunk meshing into Three.js geometry.
import * as THREE from 'three';
import { Noise, hash2 } from './noise.js';
import {
  B, isSolid, isTransparent, faceTile, tileUV, buildAtlasTexture, DTILE,
} from './blocks.js';

export const CHUNK = 16;
export const WORLD_HEIGHT = 48;
export const WATER_LEVEL = 20;

// ---- Marina City layout constants ----
const GROUND = 22;       // flat street/plaza surface height
const PERIOD = 16;       // city grid period (one block + one road)
const ROAD = 4;          // road width in blocks (local 0..3)
const FOOT0 = 6, FOOT1 = 13; // building footprint (local 6..13 = 8x8)
function imod(n, m) { return ((n % m) + m) % m; }

// Cube face definitions (unit cube), CCW outward. faceKind: 0 top,1 side,2 bottom.
const FACES = [
  { dir: [0, 1, 0], kind: 0, shade: 1.00,
    corners: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]] },
  { dir: [0, -1, 0], kind: 2, shade: 0.50,
    corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]] },
  { dir: [1, 0, 0], kind: 1, shade: 0.62,
    corners: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]] },
  { dir: [-1, 0, 0], kind: 1, shade: 0.62,
    corners: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]] },
  { dir: [0, 0, 1], kind: 1, shade: 0.82,
    corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]] },
  { dir: [0, 0, -1], kind: 1, shade: 0.72,
    corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]] },
];
const UV = [[0,0],[1,0],[1,1],[0,1]];

export class World {
  constructor(scene, seed) {
    this.scene = scene;
    this.seed = seed;
    this.noise = new Noise(seed);
    this.edits = new Map();          // "x,y,z" -> type
    this.heightCache = new Map();    // "x,z" -> height
    this.chunks = new Map();         // "cx,cz" -> { opaque, transparent }
    this.atlas = buildAtlasTexture();
    this.matOpaque = new THREE.MeshBasicMaterial({
      map: this.atlas, vertexColors: true, side: THREE.FrontSide,
    });
    this.matTransparent = new THREE.MeshBasicMaterial({
      map: this.atlas, vertexColors: true, transparent: true,
      side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.05,
    });
    // Sub-block decorations (grass tufts, flowers, leafy sprigs): cut-out
    // cross-billboards rendered in the opaque pass via alphaTest so they sort
    // cleanly and still write depth.
    this.matDecor = new THREE.MeshBasicMaterial({
      map: this.atlas, vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5,
    });
  }

  key(x, y, z) { return `${x},${y},${z}`; }

  // ---- Marina City generation ----
  // Per city cell (one grid square): what occupies it and how tall.
  cellAt(cx, cz) {
    const k = `c${cx},${cz}`;
    let info = this.heightCache.get(k);
    if (info !== undefined) return info;
    // The spawn cell is always an open bayside plaza (lands players safely).
    if (cx === 0 && cz === 0) { info = { kind: 'plaza' }; this.heightCache.set(k, info); return info; }
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
    this.heightCache.set(k, info);
    return info;
  }

  // Compatibility shim: a few systems ask for a column's surface height.
  columnHeight() { return GROUND; }

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

  getBlock(x, y, z) {
    const e = this.edits.get(this.key(x, y, z));
    if (e !== undefined) return e;
    return this.baseBlock(x, y, z);
  }

  // Apply a server edit; returns affected chunk keys to remesh.
  applyEdit(x, y, z, type) {
    this.edits.set(this.key(x, y, z), type);
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const affected = new Set([`${cx},${cz}`]);
    if (((x % CHUNK) + CHUNK) % CHUNK === 0) affected.add(`${cx - 1},${cz}`);
    if (((x % CHUNK) + CHUNK) % CHUNK === CHUNK - 1) affected.add(`${cx + 1},${cz}`);
    if (((z % CHUNK) + CHUNK) % CHUNK === 0) affected.add(`${cx},${cz - 1}`);
    if (((z % CHUNK) + CHUNK) % CHUNK === CHUNK - 1) affected.add(`${cx},${cz + 1}`);
    return affected;
  }

  loadEdits(list) {
    for (const e of list) this.edits.set(this.key(e.x, e.y, e.z), e.t);
  }

  // ---- Meshing ----
  buildChunk(cx, cz) {
    const opaque = { pos: [], col: [], uv: [], idx: [] };
    const trans = { pos: [], col: [], uv: [], idx: [] };
    const decor = { pos: [], col: [], uv: [], idx: [] };
    const baseX = cx * CHUNK, baseZ = cz * CHUNK;

    for (let lx = 0; lx < CHUNK; lx++) {
      for (let lz = 0; lz < CHUNK; lz++) {
        const wx = baseX + lx, wz = baseZ + lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const type = this.getBlock(wx, y, wz);
          if (type === B.AIR) continue;
          const selfTrans = isTransparent(type);
          const bucket = selfTrans ? trans : opaque;
          for (const f of FACES) {
            const nx = wx + f.dir[0], ny = y + f.dir[1], nz = wz + f.dir[2];
            const nb = this.getBlock(nx, ny, nz);
            // draw face if neighbour is see-through and not the same type
            const draw = isTransparent(nb) && nb !== type;
            if (!draw) continue;
            this.pushFace(bucket, wx, y, wz, f, type);
          }
          // Sub-block decorations grow out of the top of exposed surfaces.
          if ((type === B.GRASS || type === B.LEAVES) &&
              this.getBlock(wx, y + 1, wz) === B.AIR) {
            this.pushDecor(decor, wx, y, wz, type);
          }
        }
      }
    }
    this.commitChunk(cx, cz, opaque, trans, decor);
  }

  // Scatter cross-billboard detail on top of a surface block. Deterministic so
  // every client sees the same meadow.
  pushDecor(bucket, x, y, z, type) {
    const baseY = y + 1;
    const r = hash2(x, z, this.seed + 17);
    if (type === B.LEAVES) {
      const n = 1 + ((r * 3) | 0);
      for (let i = 0; i < n; i++) {
        const h = hash2(x * 3 + i, z * 5 - i, this.seed + 41);
        const ox = 0.2 + hash2(x + i, z - i, this.seed + 7) * 0.6;
        const oz = 0.2 + hash2(x - i, z + i, this.seed + 9) * 0.6;
        this.pushCross(bucket, x + ox, baseY - 0.2, z + oz, 0.7, 0.5 + h * 0.3,
                       DTILE.leafSprig, 0.82 + h * 0.18);
      }
      return;
    }
    // Grass: a few blade tufts, with the occasional flower for colour.
    const n = 2 + ((r * 3) | 0);
    for (let i = 0; i < n; i++) {
      const h = hash2(x * 7 + i, z * 11 + i, this.seed + 23);
      const ox = 0.18 + hash2(x + i * 2, z, this.seed + 3) * 0.64;
      const oz = 0.18 + hash2(x, z + i * 2, this.seed + 5) * 0.64;
      const flower = hash2(x + i, z + i, this.seed + 99) < 0.08;
      const tile = flower ? DTILE.flower : DTILE.grassTuft;
      this.pushCross(bucket, x + ox, baseY, z + oz, 0.5,
                     flower ? 0.55 : 0.34 + h * 0.34, tile, 0.8 + h * 0.2);
    }
  }

  // Two crossed vertical quads (an "X" from above), centred at (cx,cz).
  pushCross(bucket, cx, baseY, cz, w, h, tile, shade) {
    const { u0, u1 } = tileUV(tile);
    const d = w / 2;
    const quads = [
      [[cx - d, cz - d], [cx + d, cz + d]],
      [[cx - d, cz + d], [cx + d, cz - d]],
    ];
    for (const [a, b] of quads) {
      const start = bucket.pos.length / 3;
      // bottom-left, bottom-right, top-right, top-left
      bucket.pos.push(a[0], baseY, a[1], b[0], baseY, b[1],
                      b[0], baseY + h, b[1], a[0], baseY + h, a[1]);
      for (let i = 0; i < 4; i++) bucket.col.push(shade, shade, shade);
      bucket.uv.push(u0, 0, u1, 0, u1, 1, u0, 1);
      bucket.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }

  pushFace(bucket, x, y, z, f, type) {
    const start = bucket.pos.length / 3;
    const tile = faceTile(type, f.kind);
    const { u0, u1 } = tileUV(tile);
    const sh = f.shade;
    for (let i = 0; i < 4; i++) {
      const c = f.corners[i];
      bucket.pos.push(x + c[0], y + c[1], z + c[2]);
      bucket.col.push(sh, sh, sh);
      const uv = UV[i];
      bucket.uv.push(u0 + uv[0] * (u1 - u0), uv[1]);
    }
    bucket.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  commitChunk(cx, cz, opaque, trans, decor) {
    const key = `${cx},${cz}`;
    this.disposeChunk(key);
    const entry = {};
    if (opaque.idx.length) entry.opaque = this.makeMesh(opaque, this.matOpaque);
    if (trans.idx.length) entry.transparent = this.makeMesh(trans, this.matTransparent);
    if (decor && decor.idx.length) entry.decor = this.makeMesh(decor, this.matDecor);
    if (entry.opaque) this.scene.add(entry.opaque);
    if (entry.transparent) this.scene.add(entry.transparent);
    if (entry.decor) this.scene.add(entry.decor);
    this.chunks.set(key, entry);
  }

  makeMesh(data, material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(data.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(data.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
    g.setIndex(data.idx);
    g.computeBoundingSphere();
    return new THREE.Mesh(g, material);
  }

  disposeChunk(key) {
    const e = this.chunks.get(key);
    if (!e) return;
    for (const m of [e.opaque, e.transparent, e.decor]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); }
    }
    this.chunks.delete(key);
  }

  remeshChunks(keys) {
    for (const key of keys) {
      const [cx, cz] = key.split(',').map(Number);
      if (this.chunks.has(key)) this.buildChunk(cx, cz);
    }
  }

  // Keep chunks within `radius` of the player loaded; build a few per call.
  update(playerX, playerZ, radius, budget = 2) {
    const pcx = Math.floor(playerX / CHUNK);
    const pcz = Math.floor(playerZ / CHUNK);
    let built = 0;
    // build needed chunks (closest first)
    const needed = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dz = -radius; dz <= radius; dz++)
        needed.push([pcx + dx, pcz + dz, dx * dx + dz * dz]);
    needed.sort((a, b) => a[2] - b[2]);
    for (const [cx, cz] of needed) {
      const key = `${cx},${cz}`;
      if (!this.chunks.has(key)) {
        this.buildChunk(cx, cz);
        if (++built >= budget) break;
      }
    }
    // unload far chunks
    for (const key of [...this.chunks.keys()]) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - pcx) > radius + 1 || Math.abs(cz - pcz) > radius + 1) {
        this.disposeChunk(key);
      }
    }
  }
}
