// Shared monster definitions — imported by BOTH the browser client and the Node
// server, so it must stay free of `three` and browser globals.
// passive monsters never chase or attack (safe for beginners); leash = how far
// they'll chase before giving up; minLevel = monsters this strong ignore players
// below it unless provoked. Speeds are below the player's so you can run away.
export const MOB_TYPES = {
  slime:    { name: 'Slime',    hp: 12,  dmg: 0,  speed: 1.2, reach: 1.8, aggro: 0,  leash: 0,  minLevel: 0, xp: 8,   cash: 3,  weight: 5, color: 0x6fcf6f, height: 0.9, passive: true },
  zombie:   { name: 'Zombie',   hp: 24,  dmg: 5,  speed: 2.0, reach: 2.0, aggro: 14, leash: 22, minLevel: 0, xp: 14,  cash: 6,  weight: 5, color: 0x4a7a4a, height: 1.8 },
  skeleton: { name: 'Skeleton', hp: 18,  dmg: 4,  speed: 2.6, reach: 2.2, aggro: 18, leash: 26, minLevel: 3, xp: 16,  cash: 7,  weight: 3, color: 0xdadada, height: 1.8 },
  brute:    { name: 'Brute',    hp: 70,  dmg: 11, speed: 1.4, reach: 2.8, aggro: 15, leash: 18, minLevel: 6, xp: 36,  cash: 16, weight: 1, color: 0x8a4a4a, height: 3.0 },
  boss:     { name: 'Warlord',  hp: 260, dmg: 16, speed: 1.6, reach: 3.2, aggro: 38, leash: 70, minLevel: 0, xp: 220, cash: 120, weight: 0, color: 0x6a2db0, height: 3.8, boss: true },
};

// Materials a slain mob can drop (block ids), picked at random.
export const MOB_DROPS = [3, 4, 5, 10, 7]; // dirt, stone, wood, cobble, sand

export function pickMobType(rng = Math.random) {
  const list = Object.entries(MOB_TYPES).filter(([, m]) => m.weight > 0);
  const total = list.reduce((a, [, m]) => a + m.weight, 0);
  let r = rng() * total;
  for (const [k, m] of list) { if ((r -= m.weight) <= 0) return k; }
  return list[0][0];
}
