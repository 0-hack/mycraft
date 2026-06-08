// Block palette + procedurally generated texture atlas (no external assets,
// so the game works fully offline once loaded).
import * as THREE from 'three';

// Block type ids (must stay in sync with the server's PLACEABLE set).
export const B = {
  AIR: 0, BEDROCK: 1, GRASS: 2, DIRT: 3, STONE: 4, WOOD: 5, LEAVES: 6,
  SAND: 7, PLANKS: 8, WATER: 9, COBBLE: 10, BRICK: 11, GLASS: 12, LAMP: 13,
  // Marina City materials.
  CONCRETE: 14, ASPHALT: 15, ROADLINE: 16, GLASST: 17, GLASSG: 18,
  STEEL: 19, MARBLE: 20, NEON: 21, NEONP: 22,
};

// Atlas tile indices.
const T = {
  grassTop: 0, grassSide: 1, dirt: 2, stone: 3, logSide: 4, logTop: 5,
  leaves: 6, sand: 7, planks: 8, water: 9, cobble: 10, brick: 11,
  glass: 12, lamp: 13, bedrock: 14,
  concrete: 15, asphalt: 16, roadline: 17, glassBlue: 18, glassGreen: 19,
  steel: 20, marble: 21, neon: 22, neonP: 23,
  // Cut-out decoration tiles (transparent background) for sub-block detail.
  grassTuft: 24, flower: 25, leafSprig: 26,
};
const TILE_COUNT = 27;

// Tile indices for the sub-block decoration billboards (used by world.js).
export const DTILE = { grassTuft: 24, flower: 25, leafSprig: 26 };

// Per block: [top, side, bottom] tile indices, plus rendering flags.
export const BLOCKS = {
  [B.BEDROCK]: { faces: [T.bedrock, T.bedrock, T.bedrock], solid: true },
  [B.GRASS]:   { faces: [T.grassTop, T.grassSide, T.dirt], solid: true },
  [B.DIRT]:    { faces: [T.dirt, T.dirt, T.dirt], solid: true },
  [B.STONE]:   { faces: [T.stone, T.stone, T.stone], solid: true },
  [B.WOOD]:    { faces: [T.logTop, T.logSide, T.logTop], solid: true },
  [B.LEAVES]:  { faces: [T.leaves, T.leaves, T.leaves], solid: true, transparent: true },
  [B.SAND]:    { faces: [T.sand, T.sand, T.sand], solid: true },
  [B.PLANKS]:  { faces: [T.planks, T.planks, T.planks], solid: true },
  [B.WATER]:   { faces: [T.water, T.water, T.water], solid: false, transparent: true, liquid: true },
  [B.COBBLE]:  { faces: [T.cobble, T.cobble, T.cobble], solid: true },
  [B.BRICK]:   { faces: [T.brick, T.brick, T.brick], solid: true },
  [B.GLASS]:   { faces: [T.glass, T.glass, T.glass], solid: true, transparent: true },
  [B.LAMP]:    { faces: [T.lamp, T.lamp, T.lamp], solid: true },
  [B.CONCRETE]:{ faces: [T.concrete, T.concrete, T.concrete], solid: true },
  [B.ASPHALT]: { faces: [T.asphalt, T.asphalt, T.asphalt], solid: true },
  [B.ROADLINE]:{ faces: [T.roadline, T.asphalt, T.asphalt], solid: true },
  [B.GLASST]:  { faces: [T.glassBlue, T.glassBlue, T.glassBlue], solid: true, transparent: true },
  [B.GLASSG]:  { faces: [T.glassGreen, T.glassGreen, T.glassGreen], solid: true, transparent: true },
  [B.STEEL]:   { faces: [T.steel, T.steel, T.steel], solid: true },
  [B.MARBLE]:  { faces: [T.marble, T.marble, T.marble], solid: true },
  [B.NEON]:    { faces: [T.neon, T.neon, T.neon], solid: true },
  [B.NEONP]:   { faces: [T.neonP, T.neonP, T.neonP], solid: true },
};

// Block hardness now lives in the shared worldgen module so the server can use
// the same values for authoritative mining; re-exported here for the client.
export { HARDNESS, blockHardness } from './worldgen.js';

// Human-readable names for materials (used by the inventory/sell UI).
export const BLOCK_NAMES = {
  [B.GRASS]: 'Grass', [B.DIRT]: 'Dirt', [B.STONE]: 'Stone', [B.WOOD]: 'Wood',
  [B.LEAVES]: 'Leaves', [B.SAND]: 'Sand', [B.PLANKS]: 'Planks', [B.COBBLE]: 'Cobble',
  [B.BRICK]: 'Brick', [B.GLASS]: 'Glass', [B.LAMP]: 'Lamp',
  [B.CONCRETE]: 'Concrete', [B.ASPHALT]: 'Asphalt', [B.ROADLINE]: 'Road',
  [B.GLASST]: 'Blue Glass', [B.GLASSG]: 'Green Glass', [B.STEEL]: 'Steel',
  [B.MARBLE]: 'Marble', [B.NEON]: 'Neon', [B.NEONP]: 'Pink Neon',
};

export function isSolid(type) {
  const b = BLOCKS[type];
  return !!(b && b.solid);
}
export function isTransparent(type) {
  if (type === B.AIR) return true;
  const b = BLOCKS[type];
  return !!(b && b.transparent);
}
export function isLiquid(type) {
  const b = BLOCKS[type];
  return !!(b && b.liquid);
}

// Returns the atlas UV rect for a tile index.
export function tileUV(tile) {
  const u0 = tile / TILE_COUNT;
  const u1 = (tile + 1) / TILE_COUNT;
  return { u0, u1, v0: 0, v1: 1 };
}

// face index: 0 top, 1 side, 2 bottom
export function faceTile(type, faceKind) {
  return BLOCKS[type].faces[faceKind];
}

// ---- Procedural texture atlas -------------------------------------------
function px(ctx, x, y, c) { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); }

function noisyFill(ctx, ox, base, variants) {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const c = Math.random() < 0.5 ? base : variants[(Math.random() * variants.length) | 0];
      px(ctx, ox + x, y, c);
    }
}

function drawTile(ctx, idx) {
  const ox = idx * 16;
  switch (idx) {
    case T.grassTop: noisyFill(ctx, ox, '#5fa544', ['#6cb84e', '#4f9039', '#74c156']); break;
    case T.grassSide:
      noisyFill(ctx, ox, '#8a6240', ['#7a5436', '#9a6e48']); // dirt base
      for (let y = 0; y < 5; y++) for (let x = 0; x < 16; x++)
        px(ctx, ox + x, y, Math.random() < 0.6 ? '#5fa544' : '#4f9039');
      break;
    case T.dirt: noisyFill(ctx, ox, '#8a6240', ['#7a5436', '#9a6e48', '#6f4d31']); break;
    case T.stone: noisyFill(ctx, ox, '#8c8c8c', ['#7e7e7e', '#9a9a9a', '#757575']); break;
    case T.logSide:
      noisyFill(ctx, ox, '#6b4f2a', ['#5d4424', '#79592f']);
      for (let y = 0; y < 16; y += 1) { px(ctx, ox + 3, y, '#4f3c20'); px(ctx, ox + 12, y, '#4f3c20'); }
      break;
    case T.logTop:
      noisyFill(ctx, ox, '#a07b46', ['#8c6c3d']);
      ctx.strokeStyle = '#6b4f2a';
      for (let r = 2; r < 8; r += 2) { ctx.beginPath(); ctx.arc(ox + 8, 8, r, 0, 7); ctx.stroke(); }
      break;
    case T.leaves: noisyFill(ctx, ox, '#3f8f33', ['#347a2a', '#4aa33b', '#2c6624']); break;
    case T.sand: noisyFill(ctx, ox, '#dcd29a', ['#d2c789', '#e6dcab']); break;
    case T.planks:
      noisyFill(ctx, ox, '#b08a4f', ['#a07d45', '#bd9658']);
      for (let y = 0; y < 16; y += 4) for (let x = 0; x < 16; x++) px(ctx, ox + x, y, '#7a5e34');
      break;
    case T.water: noisyFill(ctx, ox, '#3b6fd6', ['#3566c9', '#4378e0']); break;
    case T.cobble: noisyFill(ctx, ox, '#7d7d7d', ['#6a6a6a', '#909090', '#5c5c5c']); break;
    case T.brick:
      noisyFill(ctx, ox, '#9b4a3a', ['#8c4234']);
      for (let y = 0; y < 16; y += 4) for (let x = 0; x < 16; x++) px(ctx, ox + x, y, '#cfc5b8');
      for (let y = 0; y < 16; y++) { const off = (((y / 4) | 0) % 2) * 8; px(ctx, ox + ((off) % 16), y, '#cfc5b8'); px(ctx, ox + ((off + 8) % 16), y, '#cfc5b8'); }
      break;
    case T.glass:
      ctx.clearRect(ox, 0, 16, 16);
      ctx.fillStyle = 'rgba(180,220,235,0.25)'; ctx.fillRect(ox, 0, 16, 16);
      ctx.strokeStyle = '#bcd6e0'; ctx.strokeRect(ox + 0.5, 0.5, 15, 15);
      break;
    case T.lamp:
      noisyFill(ctx, ox, '#f4d35e', ['#ffe27a', '#e8c349']);
      ctx.strokeStyle = '#caa12f'; ctx.strokeRect(ox + 0.5, 0.5, 15, 15);
      break;
    case T.bedrock: noisyFill(ctx, ox, '#3a3a3a', ['#2b2b2b', '#4a4a4a', '#222']); break;
    case T.concrete: noisyFill(ctx, ox, '#b9bcc4', ['#aeb1b9', '#c4c7cf', '#a6a9b1']); break;
    case T.asphalt:
      noisyFill(ctx, ox, '#3c4049', ['#34373f', '#454952', '#2e313a']);
      for (let i = 0; i < 10; i++) px(ctx, ox + (Math.random() * 16 | 0), Math.random() * 16 | 0, '#5a5e66');
      break;
    case T.roadline:
      noisyFill(ctx, ox, '#3c4049', ['#34373f', '#454952']);
      for (let y = 5; y < 11; y++) for (let x = 6; x < 10; x++) px(ctx, ox + x, y, '#d9c24a');
      break;
    case T.glassBlue:
      ctx.clearRect(ox, 0, 16, 16);
      ctx.fillStyle = 'rgba(90,166,214,0.42)'; ctx.fillRect(ox, 0, 16, 16);
      ctx.strokeStyle = '#bfe2f4'; ctx.strokeRect(ox + 0.5, 0.5, 15, 15);
      ctx.fillStyle = 'rgba(220,245,255,0.5)'; ctx.fillRect(ox + 2, 2, 4, 12);
      break;
    case T.glassGreen:
      ctx.clearRect(ox, 0, 16, 16);
      ctx.fillStyle = 'rgba(127,214,192,0.42)'; ctx.fillRect(ox, 0, 16, 16);
      ctx.strokeStyle = '#cdf3e8'; ctx.strokeRect(ox + 0.5, 0.5, 15, 15);
      ctx.fillStyle = 'rgba(225,255,245,0.5)'; ctx.fillRect(ox + 2, 2, 4, 12);
      break;
    case T.steel:
      noisyFill(ctx, ox, '#8c97a8', ['#7f8a9b', '#9aa5b5']);
      for (let y = 0; y < 16; y++) { px(ctx, ox + 4, y, '#6b7686'); px(ctx, ox + 11, y, '#6b7686'); }
      break;
    case T.marble:
      noisyFill(ctx, ox, '#eef0f4', ['#e6e9ef', '#f6f8fb']);
      ctx.strokeStyle = '#cfd4dd'; ctx.beginPath();
      ctx.moveTo(ox + 2, 1); ctx.lineTo(ox + 9, 14); ctx.moveTo(ox + 12, 3); ctx.lineTo(ox + 15, 11); ctx.stroke();
      break;
    case T.neon:
      noisyFill(ctx, ox, '#34e0e0', ['#5bf0f0', '#22c8c8']);
      ctx.strokeStyle = '#d6ffff'; ctx.strokeRect(ox + 1.5, 1.5, 13, 13);
      break;
    case T.neonP:
      noisyFill(ctx, ox, '#ff5db1', ['#ff7fc4', '#e8479c']);
      ctx.strokeStyle = '#ffe0f2'; ctx.strokeRect(ox + 1.5, 1.5, 13, 13);
      break;
    case T.grassTuft: {
      ctx.clearRect(ox, 0, 16, 16); // transparent background
      const blades = [[3, 14, 1, '#4f9039'], [6, 15, 4, '#5fa544'], [8, 13, 2, '#6cb84e'],
                      [10, 15, 6, '#4f9039'], [12, 14, 9, '#74c156']];
      for (const [bx, by, top, col] of blades) {
        ctx.strokeStyle = col; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(ox + bx, by); ctx.lineTo(ox + bx + (bx < 8 ? -1.5 : 1.5), top); ctx.stroke();
      }
      break;
    }
    case T.flower: {
      ctx.clearRect(ox, 0, 16, 16);
      ctx.strokeStyle = '#4f9039'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(ox + 8, 15); ctx.lineTo(ox + 8, 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ox + 5, 15); ctx.lineTo(ox + 6, 9); ctx.stroke();
      const petals = ['#ff6fae', '#ffd23f', '#ff9b54'];
      const col = petals[(ox / 16) % petals.length | 0] || '#ffd23f';
      for (const [dx, dy] of [[0, -3], [-3, 0], [3, 0], [0, 3], [0, 0]]) {
        ctx.fillStyle = (dx === 0 && dy === 0) ? '#ffe08a' : col;
        ctx.fillRect(ox + 8 + dx - 1, 4 + dy - 1, 3, 3);
      }
      break;
    }
    case T.leafSprig: {
      ctx.clearRect(ox, 0, 16, 16);
      const leaves = [[4, 11], [8, 13], [11, 10], [6, 7], [9, 6], [7, 3]];
      for (const [lx, ly] of leaves) {
        ctx.fillStyle = (lx + ly) % 2 ? '#3f8f33' : '#56a843';
        ctx.beginPath(); ctx.ellipse(ox + lx, ly, 2.4, 1.6, 0.6, 0, 7); ctx.fill();
      }
      break;
    }
  }
}

export function buildAtlasTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_COUNT * 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < TILE_COUNT; i++) drawTile(ctx, i);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Returns a small data URL swatch for a block (used by the hotbar UI).
export function blockSwatch(type) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d');
  // draw the side tile of the block into a fresh tile origin
  const tmp = document.createElement('canvas');
  tmp.width = TILE_COUNT * 16; tmp.height = 16;
  const tctx = tmp.getContext('2d');
  const tile = BLOCKS[type].faces[1];
  drawTile(tctx, tile);
  ctx.drawImage(tmp, tile * 16, 0, 16, 16, 0, 0, 16, 16);
  return canvas.toDataURL();
}
