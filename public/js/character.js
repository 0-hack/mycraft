// Procedural blocky character built from Three.js boxes, driven by an
// `appearance` object + `equipment` (weapon in hand, armor overlays). Limbs and
// head are pivot groups so the avatar can be animated (walk, swing, look).
// Shared by the in-game avatars and the character editor. Uses MeshBasicMaterial
// so it renders without lights (the world has none).
import * as THREE from 'three';
import { normalizeEquipment, equippedWeapon, WEAPONS } from './gear.js';
import { addAccent } from './detail.js';

export const HAIR_STYLES = ['none', 'short', 'spiky', 'mohawk', 'long', 'ponytail', 'afro'];
export const FACES = ['neutral', 'happy', 'grin', 'cool', 'angry', 'surprised'];
export const ACCESSORIES = ['none', 'glasses', 'sunglasses', 'hat', 'headband', 'crown'];
export const BAGS = ['none', 'backpack', 'satchel'];

const SKIN_TONES = ['#f2d3b3', '#e8b27a', '#c68642', '#8d5524', '#5c3a1e', '#ffe0bd'];
const HAIR_COLORS = ['#1a1a1a', '#2b1d12', '#5a3a1a', '#a0671f', '#d9b45b', '#b03030', '#3a6ea5', '#7a3aa5', '#cccccc'];
const CLOTH_COLORS = ['#3a7bd5', '#d54a4a', '#3ad57b', '#f4d35e', '#9b59b6', '#e67e22', '#1abc9c', '#2c3e63', '#ecf0f1', '#34495e', '#ff7eb6'];
const WEAPON_COLORS = { sword: '#d7dce3', axe: '#9aa3ad', pickaxe: '#aab0b8', spear: '#c9cdd4', bow: '#8a5a2b', gun: '#2b2f36', fist: '#e8b27a' };

export function defaultAppearance() {
  return {
    skin: '#e8b27a', hair: 'short', hairColor: '#2b1d12', face: 'neutral',
    shirt: '#3a7bd5', pants: '#2c3e63', shoes: '#222222',
    accessory: 'none', accessoryColor: '#222222', bag: 'none', bagColor: '#7a5436',
  };
}

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export function randomAppearance() {
  return {
    skin: pick(SKIN_TONES),
    hair: pick(HAIR_STYLES.filter((h) => h !== 'none')), hairColor: pick(HAIR_COLORS),
    face: pick(FACES),
    shirt: pick(CLOTH_COLORS), pants: pick(CLOTH_COLORS), shoes: pick(CLOTH_COLORS),
    accessory: pick(ACCESSORIES), accessoryColor: pick(CLOTH_COLORS),
    bag: pick(BAGS), bagColor: pick(CLOTH_COLORS),
  };
}

export function normalizeAppearance(a) {
  const d = defaultAppearance();
  a = a || {};
  const col = (v, fb) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fb);
  const en = (v, list, fb) => (list.includes(v) ? v : fb);
  return {
    skin: col(a.skin, d.skin),
    hair: en(a.hair, HAIR_STYLES, d.hair), hairColor: col(a.hairColor, d.hairColor),
    face: en(a.face, FACES, d.face),
    shirt: col(a.shirt, d.shirt), pants: col(a.pants, d.pants), shoes: col(a.shoes, d.shoes),
    accessory: en(a.accessory, ACCESSORIES, d.accessory), accessoryColor: col(a.accessoryColor, d.accessoryColor),
    bag: en(a.bag, BAGS, d.bag), bagColor: col(a.bagColor, d.bagColor),
  };
}

function mat(color) { return new THREE.MeshBasicMaterial({ color }); }
function addBox(parent, w, h, d, x, y, z, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function pivot(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}
// Armor tint brightens with level (1..5).
function armorShade(level) {
  const t = Math.min(1, level / 5);
  const v = Math.round(0x66 + t * 0x88);
  return (v << 16) | (v << 8) | v;
}

function faceTexture(a) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = a.skin; x.fillRect(0, 0, 64, 64);
  const eyeY = 30;
  x.fillStyle = '#1b1b1b';
  if (a.face === 'cool') {
    x.fillRect(12, eyeY - 4, 40, 10);
  } else {
    const eye = (ex) => {
      if (a.face === 'surprised') { x.beginPath(); x.arc(ex, eyeY, 5, 0, 7); x.fill(); }
      else x.fillRect(ex - 4, eyeY - 5, 8, 8);
    };
    eye(22); eye(42);
    if (a.face === 'angry') {
      x.lineWidth = 3; x.strokeStyle = '#1b1b1b';
      x.beginPath(); x.moveTo(16, eyeY - 9); x.lineTo(28, eyeY - 4);
      x.moveTo(48, eyeY - 9); x.lineTo(36, eyeY - 4); x.stroke();
    }
  }
  x.strokeStyle = '#7a2f2f'; x.fillStyle = '#7a2f2f'; x.lineWidth = 3;
  const my = 46;
  if (a.face === 'happy' || a.face === 'cool') {
    x.beginPath(); x.arc(32, my - 6, 10, 0.15 * Math.PI, 0.85 * Math.PI); x.stroke();
  } else if (a.face === 'grin') {
    x.fillRect(22, my - 4, 20, 8); x.fillStyle = '#fff'; x.fillRect(22, my - 4, 20, 3);
  } else if (a.face === 'surprised') {
    x.beginPath(); x.arc(32, my, 5, 0, 7); x.stroke();
  } else if (a.face === 'angry') {
    x.beginPath(); x.arc(32, my + 4, 9, 1.15 * Math.PI, 1.85 * Math.PI); x.stroke();
  } else {
    x.fillRect(26, my, 12, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// Head pivot at the neck (y = 1.4); children use head-local coordinates.
function buildHead(headG, a) {
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const skin = mat(a.skin);
  const face = new THREE.MeshBasicMaterial({ map: faceTexture(a) });
  const head = new THREE.Mesh(geo, [skin, skin.clone(), skin.clone(), skin.clone(), face, skin.clone()]);
  head.position.y = 0.26;
  headG.add(head);
  addHair(headG, a);
  addAccessory(headG, a);
}

function addHair(g, a) {
  if (a.hair === 'none') return;
  const c = a.hairColor, top = 0.51;
  switch (a.hair) {
    case 'short':
      addBox(g, 0.54, 0.14, 0.54, 0, top - 0.05, 0, c);
      addBox(g, 0.54, 0.12, 0.1, 0, top - 0.14, 0.23, c);
      break;
    case 'spiky':
      addBox(g, 0.54, 0.08, 0.54, 0, top - 0.04, 0, c);
      for (const sx of [-0.15, 0, 0.15]) for (const sz of [-0.12, 0.12])
        addBox(g, 0.1, 0.16, 0.1, sx, top + 0.06, sz, c);
      break;
    case 'mohawk': addBox(g, 0.12, 0.24, 0.54, 0, top + 0.06, 0, c); break;
    case 'long':
      addBox(g, 0.54, 0.14, 0.54, 0, top - 0.05, 0, c);
      addBox(g, 0.56, 0.5, 0.12, 0, 0.1, -0.23, c);
      addBox(g, 0.12, 0.46, 0.5, -0.23, 0.12, 0, c);
      addBox(g, 0.12, 0.46, 0.5, 0.23, 0.12, 0, c);
      break;
    case 'ponytail':
      addBox(g, 0.54, 0.14, 0.54, 0, top - 0.05, 0, c);
      addBox(g, 0.16, 0.42, 0.16, 0, 0.15, -0.3, c);
      break;
    case 'afro': addBox(g, 0.72, 0.42, 0.72, 0, top + 0.02, 0, c); break;
  }
  // Soft billboard wisps break up the blocky hair silhouette.
  if (a.hair === 'spiky' || a.hair === 'mohawk') {
    addAccent(g, 'frill', { x: 0, y: top, z: 0, w: 0.5, h: 0.26, color: parseInt(c.slice(1), 16) });
  } else if (a.hair === 'afro') {
    for (const rz of [0, Math.PI / 2])
      addAccent(g, 'frill', { x: 0, y: top - 0.05, z: 0, w: 0.78, h: 0.3, color: parseInt(c.slice(1), 16), rotY: rz });
  } else if (a.hair === 'long' || a.hair === 'ponytail') {
    addAccent(g, 'tatter', { x: 0, y: -0.05, z: -0.24, w: 0.5, h: 0.45, color: parseInt(c.slice(1), 16) });
  }
}

function addAccessory(g, a) {
  if (a.accessory === 'none') return;
  const c = a.accessoryColor, eyeY = 0.3, fz = 0.26;
  switch (a.accessory) {
    case 'glasses':
    case 'sunglasses': {
      const t = a.accessory === 'sunglasses' ? 0.05 : 0.04;
      addBox(g, 0.42, 0.04, 0.04, 0, eyeY, fz, c);
      addBox(g, 0.16, 0.12, t, -0.1, eyeY, fz, c);
      addBox(g, 0.16, 0.12, t, 0.1, eyeY, fz, c);
      break;
    }
    case 'hat':
      addBox(g, 0.62, 0.06, 0.62, 0, 0.53, 0.02, c);
      addBox(g, 0.46, 0.2, 0.46, 0, 0.64, 0, c);
      break;
    case 'headband': addBox(g, 0.54, 0.09, 0.54, 0, 0.4, 0, c); break;
    case 'crown':
      addBox(g, 0.52, 0.1, 0.52, 0, 0.56, 0, c);
      for (const px of [-0.18, 0, 0.18]) addBox(g, 0.08, 0.14, 0.52, px, 0.65, 0, c);
      break;
  }
}

function addBag(g, a) {
  if (a.bag === 'none') return;
  const c = a.bagColor;
  if (a.bag === 'backpack') {
    addBox(g, 0.46, 0.52, 0.18, 0, 1.05, -0.27, c);
    addBox(g, 0.12, 0.5, 0.06, -0.18, 1.08, 0.16, c);
    addBox(g, 0.12, 0.5, 0.06, 0.18, 1.08, 0.16, c);
  } else {
    addBox(g, 0.3, 0.32, 0.12, 0.2, 0.95, -0.22, c);
    addBox(g, 0.06, 0.5, 0.06, 0, 1.2, 0.02, c);
  }
}

// A weapon held in the right hand (added to the arm pivot at the hand).
function addWeapon(armG, type) {
  if (!type || type === 'fist') return;
  const c = WEAPON_COLORS[type] || '#cccccc';
  const hy = -0.58; // hand position within the arm pivot
  switch (type) {
    case 'sword':
      addBox(armG, 0.05, 0.05, 0.5, 0, hy, 0.28, c);
      addBox(armG, 0.16, 0.05, 0.06, 0, hy, 0.06, '#6b4f2a');
      break;
    case 'spear':
      addBox(armG, 0.04, 0.04, 0.8, 0, hy, 0.4, '#6b4f2a');
      addBox(armG, 0.07, 0.07, 0.14, 0, hy, 0.82, c);
      break;
    case 'axe':
      addBox(armG, 0.04, 0.04, 0.4, 0, hy, 0.2, '#6b4f2a');
      addBox(armG, 0.06, 0.22, 0.16, 0, hy + 0.06, 0.36, c);
      break;
    case 'pickaxe':
      addBox(armG, 0.04, 0.04, 0.4, 0, hy, 0.2, '#6b4f2a');
      addBox(armG, 0.06, 0.06, 0.4, 0, hy + 0.06, 0.36, c);
      break;
    case 'bow':
      addBox(armG, 0.05, 0.62, 0.05, 0, hy, 0.22, c);
      addBox(armG, 0.02, 0.5, 0.02, 0, hy, 0.27, '#eeeeee');
      break;
    case 'gun':
      addBox(armG, 0.08, 0.12, 0.34, 0, hy, 0.22, c);
      addBox(armG, 0.07, 0.16, 0.08, 0, hy - 0.12, 0.1, c);
      break;
  }
}

function addArmor(g, leftLeg, rightLeg, torso, headG, eq) {
  if (eq.chest > 0) addBox(g, 0.66, 0.5, 0.4, 0, 1.08, 0, armorShade(eq.chest));
  if (eq.helmet > 0) addBox(headG, 0.56, 0.3, 0.56, 0, 0.34, 0, armorShade(eq.helmet));
  if (eq.legs > 0) {
    addBox(leftLeg, 0.28, 0.4, 0.32, 0, -0.28, 0, armorShade(eq.legs));
    addBox(rightLeg, 0.28, 0.4, 0.32, 0, -0.28, 0, armorShade(eq.legs));
  }
}

// Build a full character. Origin at the feet (y = 0). Exposes animatable parts
// on group.userData.parts.
export function buildCharacter(appearance, equipment) {
  const a = normalizeAppearance(appearance);
  const eq = normalizeEquipment(equipment);
  const g = new THREE.Group();

  // Legs (pivots at the hips) + shoes with a finer toe cap.
  const leftLeg = pivot(g, -0.13, 0.7, 0);
  addBox(leftLeg, 0.24, 0.7, 0.28, 0, -0.35, 0, a.pants);
  addBox(leftLeg, 0.28, 0.18, 0.38, 0, -0.61, 0.05, a.shoes);
  addBox(leftLeg, 0.28, 0.1, 0.12, 0, -0.66, 0.22, a.shoes);
  const rightLeg = pivot(g, 0.13, 0.7, 0);
  addBox(rightLeg, 0.24, 0.7, 0.28, 0, -0.35, 0, a.pants);
  addBox(rightLeg, 0.28, 0.18, 0.38, 0, -0.61, 0.05, a.shoes);
  addBox(rightLeg, 0.28, 0.1, 0.12, 0, -0.66, 0.22, a.shoes);

  // Torso + a short neck.
  const torso = addBox(g, 0.6, 0.7, 0.32, 0, 1.05, 0, a.shirt);
  addBox(g, 0.2, 0.12, 0.2, 0, 1.44, 0, a.skin);

  // Arms (pivots at the shoulders) + hands; right hand holds the weapon.
  // Three little finger nubs give the hands granularity.
  const addHand = (arm) => {
    addBox(arm, 0.17, 0.24, 0.21, 0, -0.55, 0, a.skin);
    for (const fx of [-0.05, 0, 0.05]) addBox(arm, 0.04, 0.11, 0.18, fx, -0.71, 0.01, a.skin);
  };
  const leftArm = pivot(g, -0.39, 1.4, 0);
  addBox(leftArm, 0.18, 0.46, 0.22, 0, -0.23, 0, a.shirt);
  addHand(leftArm);
  const rightArm = pivot(g, 0.39, 1.4, 0);
  addBox(rightArm, 0.18, 0.46, 0.22, 0, -0.23, 0, a.shirt);
  addHand(rightArm);
  addWeapon(rightArm, eq.weapon);

  // Head (pivot at the neck) with hair/accessory.
  const head = pivot(g, 0, 1.4, 0);
  buildHead(head, a);

  // Bag + armor overlays.
  addBag(g, a);
  addArmor(g, leftLeg, rightLeg, torso, head, eq);

  g.userData.parts = { head, leftArm, rightArm, leftLeg, rightLeg };
  g.userData.appearance = a;
  g.userData.equipment = eq;
  return g;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Pose the limbs/head. `opts`: { phase, moving, swing (0..1), pitch }.
export function animateCharacter(parts, opts) {
  if (!parts) return;
  const { phase = 0, moving = false, swing = 0, pitch = 0 } = opts;
  const amp = moving ? 0.6 : 0;
  const s = Math.sin(phase);
  parts.leftLeg.rotation.x = s * amp;
  parts.rightLeg.rotation.x = -s * amp;
  parts.leftArm.rotation.x = -s * amp * 0.8;
  // Right arm swings with the walk, or does a big overhead strike while attacking.
  parts.rightArm.rotation.x = swing > 0 ? -Math.sin(clamp(swing, 0, 1) * Math.PI) * 2.2 : s * amp * 0.8;
  parts.head.rotation.x = clamp(pitch, -0.9, 0.9) * 0.7;
}
