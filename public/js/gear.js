// Shared gear/economy rules — imported by BOTH the browser client and the Node
// server (it must stay free of `three` and browser globals). Single source of
// truth for weapon/armor stats, crafting costs and combat math.

// `mine` = how fast this weapon breaks blocks. The axe is the all-round default
// (everyone carries one on hotbar slot 1); the pickaxe is best at it; ranged
// weapons (bow/gun) and the wand are weak at mining. Mining speed also scales
// with the player's strength (see miningMult in rpg.js).
export const WEAPONS = {
  fist:    { name: 'Fists',   icon: '✊', type: 'melee',  cat: 'melee',  reach: 2.2, dmg: 1, mine: 1, craftable: false },
  sword:   { name: 'Sword',   icon: '⚔️', type: 'melee',  cat: 'melee',  reach: 3.0, dmg: 6, mine: 2, craftable: true },
  axe:     { name: 'Axe',     icon: '🪓', type: 'melee',  cat: 'melee',  reach: 2.6, dmg: 4, mine: 4, craftable: true },
  pickaxe: { name: 'Pickaxe', icon: '⛏️', type: 'melee',  cat: 'melee',  reach: 2.4, dmg: 2, mine: 5, craftable: true },
  spear:   { name: 'Spear',   icon: '🔱', type: 'melee',  cat: 'melee',  reach: 3.8, dmg: 5, mine: 2, craftable: true },
  bow:     { name: 'Bow',     icon: '🏹', type: 'ranged', cat: 'ranged', reach: 26,  dmg: 5, mine: 1, craftable: true },
  gun:     { name: 'Gun',     icon: '🔫', type: 'ranged', cat: 'ranged', reach: 34,  dmg: 9, mine: 1, craftable: true },
  staff:   { name: 'Staff',   icon: '🪄', type: 'ranged', cat: 'magic',  reach: 22,  dmg: 6, mine: 1, craftable: true },
};
export const DMG_PER_LEVEL = 2;

export const ARMOR = {
  helmet: { name: 'Helmet',     icon: '🪖', stat: 'def', per: 1 },
  chest:  { name: 'Chestplate', icon: '🦺', stat: 'def', per: 2 },
  legs:   { name: 'Greaves',    icon: '🦵', stat: 'def', per: 1 },
  boots:  { name: 'Boots',      icon: '🥾', stat: 'agi', per: 1 },
};
export const ARMOR_SLOTS = ['helmet', 'chest', 'legs', 'boots'];
export const MAX_LEVEL = 5;

export function defaultEquipment() {
  return { weapon: 'sword', weapons: { sword: 1 }, helmet: 0, chest: 0, legs: 0, boots: 0 };
}

// Starting loadout for a chosen class: everyone owns a basic sword + an axe
// (the quick-swap weapon on hotbar slot 1), plus their class's favored weapon,
// which is the one equipped by default (mage→staff, archer→bow, etc.).
export function classEquipment(favored) {
  const weapons = { sword: 1, axe: 1 };
  if (favored && WEAPONS[favored] && WEAPONS[favored].craftable) weapons[favored] = 1;
  const weapon = favored && weapons[favored] ? favored : 'sword';
  return { weapon, weapons, helmet: 0, chest: 0, legs: 0, boots: 0 };
}

export function normalizeEquipment(e) {
  e = e || {};
  const lv = (v) => Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number(v) || 0)));
  const weapons = {};
  if (e.weapons && typeof e.weapons === 'object') {
    for (const k of Object.keys(WEAPONS)) {
      if (WEAPONS[k].craftable && e.weapons[k]) weapons[k] = Math.max(1, Math.min(MAX_LEVEL, Math.floor(e.weapons[k])));
    }
  }
  if (!weapons.sword) weapons.sword = 1; // everyone keeps a basic sword
  if (!weapons.axe) weapons.axe = 1;     // …and a basic axe (the slot-1 quick-swap)
  let weapon = WEAPONS[e.weapon] ? e.weapon : 'sword';
  if (weapon !== 'fist' && !weapons[weapon]) weapon = 'sword';
  return { weapon, weapons, helmet: lv(e.helmet), chest: lv(e.chest), legs: lv(e.legs), boots: lv(e.boots) };
}

export function weaponStats(type, level = 1) {
  const w = WEAPONS[type] || WEAPONS.fist;
  const lvl = type === 'fist' ? 0 : Math.max(1, level);
  return {
    id: type, name: w.name, icon: w.icon, type: w.type, cat: w.cat, reach: w.reach, mine: w.mine,
    dmg: w.dmg + Math.max(0, lvl - 1) * DMG_PER_LEVEL, level: lvl,
  };
}

// Body armour slows you down (boots are handled by agility, not weight).
export function bodyArmorWeight(e) {
  e = normalizeEquipment(e);
  return e.helmet * 0.01 + e.chest * 0.025 + e.legs * 0.02; // up to ~0.275
}

// The weapon currently in hand, resolved to live stats.
export function equippedWeapon(e) {
  e = normalizeEquipment(e);
  return weaponStats(e.weapon, e.weapons[e.weapon] || 1);
}

export function defenseOf(e) {
  e = normalizeEquipment(e);
  return e.helmet * ARMOR.helmet.per + e.chest * ARMOR.chest.per + e.legs * ARMOR.legs.per;
}
export function agilityOf(e) {
  e = normalizeEquipment(e);
  return e.boots * ARMOR.boots.per;
}
export function speedMultiplier(e) { return 1 + agilityOf(e) * 0.06; } // +6% per boots level

// Flat % mitigation: 4% per defense point, capped at 80%; always ≥1 damage.
export function mitigate(dmg, defense) {
  return Math.max(1, Math.round(dmg * (1 - Math.min(0.8, defense * 0.04))));
}

// Cost to craft (0→1) or upgrade (L→L+1): cash + total raw-material units.
export function upgradeCost(currentLevel) {
  const next = currentLevel + 1;
  return { cash: 40 * next, materials: 4 * next };
}
