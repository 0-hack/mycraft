// Seeded 2D Perlin noise + fractal helper. Deterministic from a seed so every
// client generates an identical base world.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Noise {
  constructor(seed) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  static fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  static lerp(a, b, t) { return a + t * (b - a); }
  static grad(hash, x, y) {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
  }

  perlin2(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = Noise.fade(x), v = Noise.fade(y);
    const p = this.perm;
    const A = p[X] + Y, B = p[X + 1] + Y;
    return Noise.lerp(
      Noise.lerp(Noise.grad(p[A], x, y), Noise.grad(p[B], x - 1, y), u),
      Noise.lerp(Noise.grad(p[A + 1], x, y - 1), Noise.grad(p[B + 1], x - 1, y - 1), u),
      v
    );
  }

  // Fractal Brownian motion: layered noise for natural terrain.
  fbm(x, y, octaves = 4, persistence = 0.5, scale = 0.01) {
    let total = 0, amp = 1, freq = scale, max = 0;
    for (let i = 0; i < octaves; i++) {
      total += this.perlin2(x * freq, y * freq) * amp;
      max += amp;
      amp *= persistence;
      freq *= 2;
    }
    return total / max; // roughly -1..1
  }
}

// Deterministic hash for per-column decisions (tree placement, etc.).
export function hash2(x, z, seed) {
  let h = (x * 374761393 + z * 668265263 + seed * 982451653) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
