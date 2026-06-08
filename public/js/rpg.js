// Shared RPG progression — classes ("genes"), attributes, leveling and the
// derived-stat math. Imported by BOTH the browser client and the Node server,
// so it must stay free of `three` and browser globals.

export const LEVEL_CAP = 30;
export const POINTS_PER_LEVEL = 2;
export const ATTR_CAP = 20;

export const ATTRS = ['str', 'dex', 'int', 'end', 'vit', 'spd'];
export const ATTR_INFO = {
  str: { name: 'Strength', icon: '💪', desc: 'Melee damage & mining power' },
  dex: { name: 'Dexterity', icon: '🎯', desc: 'Ranged damage, attack speed & crit chance' },
  int: { name: 'Intelligence', icon: '🔮', desc: 'Magic damage & cheaper crafting' },
  end: { name: 'Endurance', icon: '🛡️', desc: 'Defence & slower hunger' },
  vit: { name: 'Vitality', icon: '❤️', desc: 'Maximum health' },
  spd: { name: 'Speed', icon: '👟', desc: 'Movement speed' },
};

// Starting "genes". `mult` scales weapon-category damage; biases shape playstyle.
export const CLASSES = {
  soldier: { name: 'Soldier', icon: '🛡️',
    desc: 'Tough melee bruiser — strong & hardy, poor at range and magic.',
    base: { str: 5, dex: 1, int: 0, end: 4, vit: 4, spd: 2 },
    mult: { melee: 1.25, ranged: 0.8, magic: 0.5 } },
  archer: { name: 'Archer', icon: '🏹',
    desc: 'Deadly with a bow at range; fragile in a brawl.',
    base: { str: 2, dex: 6, int: 1, end: 1, vit: 2, spd: 4 },
    mult: { melee: 0.8, ranged: 1.3, magic: 0.6 }, favored: 'bow' },
  gunman: { name: 'Gunman', icon: '🔫',
    desc: 'Master of firearms — high ranged burst, light on defence.',
    base: { str: 2, dex: 5, int: 2, end: 1, vit: 2, spd: 3 },
    mult: { melee: 0.8, ranged: 1.3, magic: 0.7 }, favored: 'gun' },
  mage: { name: 'Mage', icon: '🧙',
    desc: 'Wields magic none other can — devastating spells, frail body.',
    base: { str: 0, dex: 1, int: 7, end: 1, vit: 2, spd: 2 },
    mult: { melee: 0.6, ranged: 0.8, magic: 1.7 }, favored: 'staff' },
  artisan: { name: 'Artisan', icon: '🛠️',
    desc: 'Master crafter — cheaper, well-rounded gear offsets modest stats.',
    base: { str: 3, dex: 2, int: 3, end: 2, vit: 3, spd: 2 },
    mult: { melee: 1.0, ranged: 1.0, magic: 0.8 }, craftDiscount: 0.4 },
};

// ---- Class skills (3 per class, levels 0..5) -----------------------------
// kind: nuke (single target), aoe (around you), heal (self), buff (timed).
// cat scales damage by class/attribute; buffStat: dmg/def/speed.
export const SKILL_CAP = 5;
// status entries: { type:'burn'|'slow'|'stun', mag?, duration }. burn = damage
// over time; slow = movement reduction; stun = can't act (mobs only).
export const CLASS_SKILLS = {
  soldier: [
    { id: 'cleave',  name: 'Cleave',    icon: '🌀', kind: 'aoe',  cat: 'melee', base: 6, per: 3, radius: 3.0, cd: 6000, status: [{ type: 'slow', mag: 0.4, duration: 2500 }], blurb: 'Sweeping hit that slows all around you.' },
    { id: 'warcry',  name: 'War Cry',   icon: '📣', kind: 'buff', buffStat: 'def', base: 4, per: 2, duration: 7000, cd: 14000, blurb: 'Roar for bonus defence.' },
    { id: 'charge',  name: 'Charge',    icon: '💨', kind: 'buff', buffStat: 'speed', base: 1.4, per: 0.1, duration: 3000, cd: 8000, blurb: 'Burst of speed to close in or flee.' },
  ],
  archer: [
    { id: 'powershot', name: 'Power Shot', icon: '🏹', kind: 'nuke', cat: 'ranged', base: 12, per: 5, cd: 4000, status: [{ type: 'burn', mag: 3, duration: 4000 }], blurb: 'Piercing shot that leaves a bleed.' },
    { id: 'volley',    name: 'Volley',     icon: '☄️', kind: 'aoe',  cat: 'ranged', base: 5, per: 3, radius: 4.0, cd: 7000, blurb: 'Rain arrows on everything nearby.' },
    { id: 'dodge',     name: 'Dodge Roll', icon: '🤸', kind: 'buff', buffStat: 'speed', base: 1.5, per: 0.1, duration: 2500, cd: 6000, blurb: 'Quick burst of speed to reposition.' },
  ],
  gunman: [
    { id: 'headshot',  name: 'Headshot',   icon: '🎯', kind: 'nuke', cat: 'ranged', base: 16, per: 7, cd: 4500, blurb: 'High-damage precision shot.' },
    { id: 'grenade',   name: 'Grenade',    icon: '💣', kind: 'aoe',  cat: 'ranged', base: 8, per: 4, radius: 4.5, cd: 8000, status: [{ type: 'stun', duration: 1000 }], blurb: 'Explosive blast that stuns monsters.' },
    { id: 'adrenaline',name: 'Adrenaline', icon: '⚡', kind: 'buff', buffStat: 'dmg', base: 1.3, per: 0.08, duration: 6000, cd: 14000, blurb: 'Pump up your damage for a while.' },
  ],
  mage: [
    { id: 'fireball',  name: 'Fireball',  icon: '🔥', kind: 'nuke', cat: 'magic', base: 14, per: 6, cd: 3500, status: [{ type: 'burn', mag: 4, duration: 4000 }], blurb: 'Hurl a fireball that sets the target ablaze.' },
    { id: 'frostnova', name: 'Frost Nova',icon: '❄️', kind: 'aoe',  cat: 'magic', base: 7, per: 4, radius: 5.0, cd: 7000, status: [{ type: 'slow', mag: 0.5, duration: 3000 }, { type: 'stun', duration: 800 }], blurb: 'Freezing blast: slows everything and briefly stuns monsters.' },
    { id: 'heal',      name: 'Heal',      icon: '✨', kind: 'heal', base: 8, per: 4, cd: 10000, blurb: 'Restore your own health.' },
  ],
  artisan: [
    { id: 'bomb',      name: 'Bomb',      icon: '🧨', kind: 'aoe',  cat: 'melee', base: 9, per: 4, radius: 4.0, cd: 7000, status: [{ type: 'burn', mag: 4, duration: 3500 }], blurb: 'Throw a bomb that scorches the area.' },
    { id: 'repair',    name: 'Repair',    icon: '🔧', kind: 'heal', base: 7, per: 3, cd: 9000, blurb: 'Patch yourself up.' },
    { id: 'fortify',   name: 'Fortify',   icon: '🛡️', kind: 'buff', buffStat: 'def', base: 3, per: 2, duration: 8000, cd: 14000, blurb: 'Brace for heavy bonus defence.' },
  ],
};
export function classSkills(cls) { return CLASS_SKILLS[cls] || CLASS_SKILLS.soldier; }
export function skillLevel(p, id) { p = normalizeProgress(p); return p.skills[id] || 0; }

export function defaultProgress(cls) {
  cls = CLASSES[cls] ? cls : 'soldier';
  return { class: cls, level: 1, xp: 0, points: 0, skillPoints: 0, skills: {}, attrs: { ...CLASSES[cls].base } };
}

export function normalizeProgress(p) {
  p = p || {};
  const cls = CLASSES[p.class] ? p.class : 'soldier';
  const base = CLASSES[cls].base;
  const attrs = {};
  for (const a of ATTRS) {
    const v = Number(p.attrs && p.attrs[a]);
    attrs[a] = Math.max(0, Math.min(ATTR_CAP, Math.floor(Number.isFinite(v) ? v : base[a])));
  }
  const skills = {};
  const ids = classSkills(cls).map((s) => s.id);
  if (p.skills && typeof p.skills === 'object') {
    for (const id of ids) {
      const v = Math.floor(Number(p.skills[id]) || 0);
      if (v > 0) skills[id] = Math.min(SKILL_CAP, v);
    }
  }
  return {
    class: cls,
    level: Math.max(1, Math.min(LEVEL_CAP, Math.floor(p.level) || 1)),
    xp: Math.max(0, Math.floor(p.xp) || 0),
    points: Math.max(0, Math.floor(p.points) || 0),
    skillPoints: Math.max(0, Math.floor(p.skillPoints) || 0),
    skills,
    attrs,
  };
}

// Medium curve: XP to go from `level` to `level+1`.
export function xpForNext(level) { return Math.round(60 * Math.pow(level, 1.35)); }

// Mutates a *normalized* progress object; returns { leveled } count.
export function addXp(p, amount) {
  if (p.level >= LEVEL_CAP) { p.xp = 0; return { leveled: 0 }; }
  p.xp += Math.max(0, amount | 0);
  let leveled = 0;
  while (p.level < LEVEL_CAP && p.xp >= xpForNext(p.level)) {
    p.xp -= xpForNext(p.level);
    p.level += 1;
    p.points += POINTS_PER_LEVEL;
    p.skillPoints = (p.skillPoints || 0) + 1; // 1 skill point per level
    leveled++;
  }
  if (p.level >= LEVEL_CAP) p.xp = 0;
  return { leveled };
}

// ---- Derived stats -------------------------------------------------------
const A = (p, k) => normalizeProgress(p).attrs[k];
const classMult = (p, cat) => (CLASSES[normalizeProgress(p).class].mult[cat] ?? 1);

export function maxHealth(p) { return 20 + A(p, 'vit') * 4; }            // 20..100
export function meleeMult(p) { return classMult(p, 'melee') * (1 + A(p, 'str') * 0.06); }
export function rangedMult(p) { return classMult(p, 'ranged') * (1 + A(p, 'dex') * 0.06); }
export function magicMult(p) { return classMult(p, 'magic') * (1 + A(p, 'int') * 0.08); }
export function damageMult(p, category) {
  if (category === 'ranged') return rangedMult(p);
  if (category === 'magic') return magicMult(p);
  return meleeMult(p);
}
export function defenseBonus(p) { return A(p, 'end') * 0.5; }            // adds to armour defence
export function attackCooldownMult(p) { return Math.max(0.45, 1 - A(p, 'dex') * 0.03); }
export const CRIT_MULT = 1.8;
export function critChance(p) { return Math.min(0.5, A(p, 'dex') * 0.02); } // 2%/dex, cap 50%
export function miningMult(p) { return 1 + A(p, 'str') * 0.1; }
export function hungerMult(p) { return Math.max(0.5, 1 - A(p, 'end') * 0.03); }
export function speedAttrMult(p) { return 1 + A(p, 'spd') * 0.03; }      // boots/armour handled in gear.js
export function craftDiscount(p) { return CLASSES[normalizeProgress(p).class].craftDiscount || 0; }
export function nextXp(p) { p = normalizeProgress(p); return p.level >= LEVEL_CAP ? 0 : xpForNext(p.level); }
