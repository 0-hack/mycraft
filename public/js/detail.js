// Shared sub-model detail helpers: cut-out "billboard" accents (crossed quads)
// that layer organic granularity onto the box-built characters and monsters —
// slime drips, cloth tatters, fur/spikes, glow wisps, embers. Textures are
// procedurally generated (no assets) and cached; materials are created per
// instance so per-mob hit-flashing stays isolated.
import * as THREE from 'three';

const texCache = new Map();
const geoCache = new Map();

function px(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

// All accents are drawn into a 16x16 canvas with a transparent background and
// their *base* at the bottom (canvas y=15), growing upward to the tip (y=0).
function drawAccent(ctx, kind) {
  ctx.clearRect(0, 0, 16, 16);
  switch (kind) {
    case 'spike': // a sharp triangular shard
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(2, 16); ctx.lineTo(8, 0); ctx.lineTo(14, 16); ctx.closePath(); ctx.fill();
      break;
    case 'frill': { // a fan of three narrow spikes (fur / fins)
      ctx.fillStyle = '#ffffff';
      for (const [bx, tx] of [[1, 3], [6, 8], [11, 13]]) {
        ctx.beginPath(); ctx.moveTo(bx, 16); ctx.lineTo(tx, 2); ctx.lineTo(bx + 4, 16); ctx.closePath(); ctx.fill();
      }
      break;
    }
    case 'tatter': // ragged hanging cloth strips
      ctx.fillStyle = '#ffffff';
      px(ctx, 2, 0, 3, 13);
      px(ctx, 6, 0, 4, 16);
      px(ctx, 11, 0, 3, 11);
      // torn bottom edge
      ctx.clearRect(2, 12, 3, 1); ctx.clearRect(7, 15, 1, 1); ctx.clearRect(11, 10, 1, 2);
      break;
    case 'drip': // a teardrop bulb on a thin neck (use flip:true to hang down)
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(8, 12, 3.4, 0, 7); ctx.fill();
      px(ctx, 7, 1, 2, 10);
      break;
    case 'wisp': // soft flame-like glow (pair with glow:true / additive)
      for (const [cx, cy, r, a] of [[8, 12, 5, 0.5], [8, 8, 4, 0.7], [8, 4, 2.6, 0.9]]) {
        ctx.globalAlpha = a; ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    case 'ember': // scattered specks
      ctx.fillStyle = '#ffffff';
      for (const [ex, ey] of [[4, 11], [9, 7], [6, 3], [12, 9], [8, 13]]) {
        ctx.beginPath(); ctx.arc(ex, ey, 1.3, 0, 7); ctx.fill();
      }
      break;
    default:
      px(ctx, 4, 0, 8, 16, '#ffffff');
  }
}

function tex(kind) {
  if (texCache.has(kind)) return texCache.get(kind);
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  drawAccent(c.getContext('2d'), kind);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(kind, t);
  return t;
}

// Two crossed vertical quads (an "X" seen from above), base at the origin.
function crossGeo(w, h) {
  const key = `${w},${h}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const d = w / 2;
  const pos = [
    -d, 0, -d, d, 0, d, d, h, d, -d, h, -d,
    -d, 0, d, d, 0, -d, d, h, -d, -d, h, d,
  ];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  geoCache.set(key, g);
  return g;
}

// Add a billboard accent to a group/pivot. Returns the mesh.
//   kind: 'spike'|'frill'|'tatter'|'drip'|'wisp'|'ember'
//   opts: { x,y,z, w,h, color, opacity, glow, flip, rotY }
export function addAccent(group, kind, opts = {}) {
  const { x = 0, y = 0, z = 0, w = 0.4, h = 0.4, color = 0xffffff,
    opacity = 1, glow = false, flip = false, rotY = 0 } = opts;
  const m = new THREE.MeshBasicMaterial({
    map: tex(kind), color, side: THREE.DoubleSide,
    transparent: glow || opacity < 1, opacity,
    alphaTest: glow ? 0 : 0.5, depthWrite: !(glow || opacity < 1),
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(crossGeo(w, h), m);
  mesh.position.set(x, y, z);
  if (flip) mesh.rotation.x = Math.PI;
  if (rotY) mesh.rotation.y = rotY;
  group.add(mesh);
  return mesh;
}
