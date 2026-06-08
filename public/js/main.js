// MyCraft entry point: wires the renderer, world, player, networking, UI
// and input together into the game loop.
import * as THREE from 'three';
import { World } from './world.js';
import { Player } from './player.js';
import { Network } from './network.js';
import { UI } from './ui.js';
import { B, isSolid } from './blocks.js';
import { isTouchDevice, setupMobileControls } from './mobile.js';
import { Minimap } from './minimap.js';
import { buildCharacter, animateCharacter, addWings, setPainFace } from './character.js';
import { CharacterEditor } from './chareditor.js';
import { Tutorial, tutorialSeen } from './tutorial.js';
import { addAccent } from './detail.js';
import { equippedWeapon, speedMultiplier, bodyArmorWeight, defaultEquipment, WEAPONS } from './gear.js';
import { speedAttrMult, hungerMult, maxHealth, miningMult, defaultProgress, classSkills, CLASSES } from './rpg.js';
import { blockHardness } from './blocks.js';
import { MOB_TYPES } from './mobs.js';
import * as audio from './audio.js';

const net = new Network();
const ui = new UI();
const minimap = new Minimap();
const charEditor = new CharacterEditor();
const tutorial = new Tutorial();
let myAppearance = null;
let myEquipment = defaultEquipment();
let myProgress = defaultProgress('soldier');
// Admin-tunable knobs pushed by the server (balanced defaults).
let tuning = { moveSpeedMult: 1, hungerDrainMult: 1, staminaDrainSec: 5, staminaRefillSec: 7, skillRangeMult: 1, skillCdMult: 1 };
function applyTuning(t) {
  if (!t) return;
  tuning = { ...tuning, ...t };
  if (player) { player.staminaDrainSec = tuning.staminaDrainSec; player.staminaRefillSec = tuning.staminaRefillSec; }
  recomputeDerived();
}

// Unlock audio on the first user gesture (browser autoplay policy), then kick
// off the ambient background music (no-op if the player muted music).
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  addEventListener(ev, () => { audio.resume(); audio.startMusic(); }, { once: true });
}
let world, player, renderer, scene, camera, highlight;
let crackGeo = null, crackTextures = null;
const crackOverlays = new Map(); // "x,y,z" -> crack mesh (persistent per block)
let selfId = null, username = null;
let dayLength = 1200000, serverTimeOffset = 0;
const remotePlayers = new Map(); // netId -> { group, target }
let lastMoveSent = 0, lastStatsSent = 0, lastMovePos = null;
let onlineCount = 1;
let swam = false;
const SPAWN = { x: 8, y: 40, z: 8 };

// Mouse look sensitivity (radians per pixel of mouse movement). Lowered from the
// old 0.0025 default, which felt twitchy on desktop. Adjustable in Settings.
const DEFAULT_SENSITIVITY = 0.0013;
let lookSensitivity = (() => {
  const v = parseFloat(localStorage.getItem('vc_sensitivity'));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SENSITIVITY;
})();
function setSensitivity(v) {
  lookSensitivity = Math.max(0.0003, Math.min(0.006, v));
  localStorage.setItem('vc_sensitivity', String(lookSensitivity));
}

// ---------------------------------------------------------------- auth flow
ui.bindAuth({
  onLogin: async (u, p) => handleAuth(await net.login(u, p)),
  onRegister: async (u, p) => handleAuth(await net.register(u, p)),
});

function handleAuth(res) {
  if (res.error) return res;
  localStorage.setItem('vc_token', res.token);
  startGame(res.token, res.username);
  return res;
}

// Auto-login if a token is stored.
const saved = localStorage.getItem('vc_token');
if (saved) {
  fetch('/api/status').then(() => startGame(saved)).catch(() => ui.showAuth(true));
} else {
  ui.showAuth(true);
}

// ---------------------------------------------------------------- game setup
function startGame(token) {
  ui.showAuth(false);
  setupThree();
  setupNetwork();
  net.connect(token);
}

function setupThree() {
  scene = new THREE.Scene();
  // Marina City skyline haze — pushed back so towers stay visible.
  scene.background = new THREE.Color(0x9fc4e6);
  scene.fog = new THREE.Fog(0xbcd2e6, 45, 130);

  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 1000);
  scene.add(camera); // so the first-person viewmodel (a camera child) renders

  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.getElementById('game').appendChild(renderer.domElement);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // Block highlight wireframe.
  const hl = new THREE.BoxGeometry(1.002, 1.002, 1.002);
  highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(hl),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }));
  highlight.visible = false;

  // Block-breaking crack overlays (Minecraft-style). One cube per damaged block
  // so cracks persist on every block you've chipped, not just the one you aim at.
  crackTextures = makeCrackTextures(8);
  crackGeo = new THREE.BoxGeometry(1.01, 1.01, 1.01);
}

// Procedurally drawn crack stages (transparent PNG-like canvases): more and
// longer cracks as the stage rises.
function makeCrackTextures(stages) {
  const texs = [];
  for (let s = 0; s < stages; s++) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 64, 64);
    x.strokeStyle = 'rgba(0,0,0,0.8)'; x.lineCap = 'round';
    let seed = 9301 + s * 233;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const n = 1 + s; // crack count grows with stage
    for (let i = 0; i < n; i++) {
      x.lineWidth = 1 + (s > 4 ? 1 : 0);
      let px = 20 + rnd() * 24, py = 20 + rnd() * 24;
      x.beginPath(); x.moveTo(px, py);
      const segs = 2 + ((rnd() * 3) | 0);
      for (let j = 0; j < segs; j++) { px += (rnd() - 0.5) * 34; py += (rnd() - 0.5) * 34; x.lineTo(px, py); }
      x.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    texs.push(tex);
  }
  return texs;
}

function setupNetwork() {
  net.on('authError', () => {
    localStorage.removeItem('vc_token');
    location.reload();
  });

  net.on('init', (msg) => {
    selfId = msg.selfId;
    username = msg.username;
    dayLength = msg.dayLength;
    serverTimeOffset = msg.serverTime - Date.now();

    world = new World(scene, msg.seed);
    world.loadEdits(msg.edits);
    minimap.world = world; // lets the minimap render the actual city layout
    scene.add(highlight);

    const spawn = (msg.state && Number.isFinite(msg.state.x))
      ? { x: msg.state.x, y: msg.state.y, z: msg.state.z } : SPAWN;
    player = new Player(camera, world, spawn);
    player.yaw = msg.state?.yaw || 0;
    player.pitch = msg.state?.pitch || 0;
    player.health = msg.state?.health ?? 20;
    player.hunger = msg.state?.hunger ?? 20;
    // Report environmental damage to the server (it owns health).
    player.onDamage = (amount, cause) => net.sendDamage(amount, cause);
    setCanFly(!!msg.canFly);

    ui.hideAuthAndPlay(username);
    ui.primeAchievements(msg.state?.achievements);
    ui.setPrices(msg.prices);
    ui.setAdmin(msg.isAdmin);
    bindMenuActions();
    applyTuning(msg.tuning);
    if (msg.state?.equipment) applyEquipment(msg.state.equipment);
    if (msg.state?.progress) applyProgress(msg.state.progress);
    currentStats = { ...defaultStats(), ...(msg.state || {}) };
    spawnPointSet = !!msg.state?.spawnSet;
    ui.updateStats(currentStats);

    for (const p of msg.players) addRemote(p);
    for (const pk of msg.pickups || []) addPickup(pk);
    for (const g of msg.ground || []) addGround(g);
    for (const mob of msg.mobs || []) { addMob(mob); if (mob.type === 'boss') showBoss(mob); }
    onlineCount = msg.players.length + 1;
    ui.setOnline(onlineCount);
    ui.addChat('', 'Welcome to MyCraft! Build, mine and explore together.', true);

    setupInput();
    requestAnimationFrame(loop);

    // First-time players go to the character creator before they get going.
    myAppearance = msg.state?.appearance || null;
    if (!myAppearance) {
      charEditor.open(null, myProgress.class, saveAppearance);
      ui.addChat('', 'Create your character & pick a class to get started — reopen via 🎒 Bag → Customise.', true);
    } else if (!tutorialSeen()) {
      tutorial.open();
    }
  });

  net.on('playerJoin', (msg) => {
    addRemote(msg.player);
    onlineCount++;
    ui.setOnline(onlineCount);
    ui.addChat('', `${msg.player.name} joined the world`, true);
  });
  net.on('playerLeave', (msg) => {
    removeRemote(msg.id);
    onlineCount = Math.max(1, onlineCount - 1);
    ui.setOnline(onlineCount);
  });
  net.on('playerMove', (msg) => {
    const r = remotePlayers.get(msg.id);
    if (r) { r.target.set(msg.x, msg.y, msg.z); r.yaw = msg.yaw; r.pitch = msg.pitch || 0; }
  });
  net.on('block', (msg) => {
    if (!world) return;
    const affected = world.applyEdit(msg.x, msg.y, msg.z, msg.t);
    world.remeshChunks(affected);
  });
  net.on('placeDenied', (msg) => {
    // Server rejected a build (out of that block) — revert our optimistic edit.
    if (!world) return;
    const affected = world.applyEdit(msg.x, msg.y, msg.z, B.AIR);
    world.remeshChunks(affected);
    ui.toast('⛏ Out of that block — mine more to build.');
  });
  net.on('stats', (msg) => {
    if (msg.state) {
      currentStats = { ...currentStats, ...msg.state };
      if (msg.state.equipment) applyEquipment(msg.state.equipment);
      if (msg.state.progress) applyProgress(msg.state.progress); // updates maxHealth
      // Keep the player's HP in sync with the authoritative state too (heals,
      // regen, etc.), in case a 'health' push was missed or arrived out of order.
      if (player && typeof msg.state.health === 'number') {
        player.health = Math.max(0, msg.state.health);
      }
      ui.updateStats(currentStats);
    }
  });
  net.on('tuning', (msg) => applyTuning(msg.tuning));
  net.on('canFly', (msg) => setCanFly(!!msg.value));
  net.on('spawnSet', (msg) => {
    ui.toast(`📍 Respawn point set here (${msg.x}, ${msg.y}, ${msg.z}).`);
    spawnPointSet = true;
    refreshSpawnBtn();
  });
  net.on('crafted', (msg) => {
    if (msg && msg.action === 'equip') { audio.play('place'); return; } // quiet weapon swap
    ui.toast('🛠 Crafted!'); audio.play('craft');
  });
  net.on('craftFail', () => ui.toast('Not enough cash or materials.'));
  net.on('levelup', (msg) => { ui.toast(`⭐ Level ${msg.level}!\n+2 attribute & +1 skill point — open 🎒 Bag`); audio.play('level'); });
  net.on('skillFx', (msg) => {
    const pos = new THREE.Vector3(msg.x, msg.y, msg.z);
    if (msg.kind === 'aoe') spawnRing(pos, 4, 0xffaa55);
    else spawnRing(pos.add(new THREE.Vector3(0, 1, 0)), 1.2, 0xffffff);
  });
  net.on('buff', (msg) => {
    if (msg.stat === 'speed') {
      myBuffSpeed = msg.value;
      recomputeDerived();
      clearTimeout(_buffTimer);
      _buffTimer = setTimeout(() => { myBuffSpeed = 1; recomputeDerived(); }, msg.duration);
      ui.toast(msg.value < 1 ? '🥶 Slowed!' : '💨 Speed boost!');
    }
  });
  net.on('respawn', (msg) => {
    player.respawn({ x: msg.x, y: msg.y, z: msg.z });
    ui.showDeath(false);
  });
  // Authoritative health pushes (combat, environmental, heals, regen).
  net.on('health', (msg) => {
    if (!player) return;
    const wasDead = player.dead;
    player.setHealth(msg.health, msg.dead);
    if (msg.dead && !wasDead) audio.play('death');
    if (typeof msg.hunger === 'number') player.hunger = msg.hunger;
    if (msg.hit) {
      hurtFlash(); audio.play('hurt');
      if (ownAvatar) { setPainFace(ownAvatar, true); setTimeout(() => ownAvatar && setPainFace(ownAvatar, false), 450); }
    }
    if (msg.dmg) selfFloat('-' + msg.dmg + (msg.fx === 'crit' ? '!' : ''), msg.fx === 'crit' ? '#ffd23f' : '#ff6b6b');
    if (msg.heal) { selfFloat('+' + msg.heal, '#7fe3a0'); audio.play('heal'); }
  });
  net.on('kill', (msg) => {
    currentStats.kills = (currentStats.kills || 0) + 1;
    ui.toast(`⚔️ You defeated ${msg.victim}!\n+${msg.score} score`);
  });
  net.on('pickupSpawn', (msg) => addPickup(msg.pickup));
  net.on('pickupRemove', (msg) => removePickup(msg.id));
  net.on('pickupGot', (msg) => {
    const label = msg.kind === 'medkit' ? '🩹 Healing patch' : '🍗 Food';
    const key = msg.kind === 'medkit' ? 'Q' : 'F';
    ui.toast(`${label} added to bag — press ${key} (or the button) to use.`);
    audio.play('pickup');
  });
  net.on('groundItemSpawn', (msg) => addGround(msg.item));
  net.on('groundItemRemove', (msg) => removeGround(msg.id));
  net.on('mobSpawn', (msg) => { addMob(msg.mob); if (msg.mob.type === 'boss') showBoss(msg.mob); });
  net.on('mobs', (msg) => { for (const u of msg.mobs) { const e = mobEntities.get(u.id); if (e) { e.target.set(u.x, u.y, u.z); e.yaw = u.yaw; e.st = u.st; } } });
  net.on('mobAttack', (msg) => { const e = mobEntities.get(msg.id); if (e) e.attackT = 1; }); // lunge/swing
  net.on('mobHit', (msg) => {
    const e = mobEntities.get(msg.id);
    if (!e) return;
    e.health = msg.health; updateMobBar(e); mobFlash(e);
    if (msg.id === bossId) updateBoss(msg.health);
    if (msg.dmg) { const crit = msg.fx === 'crit'; worldFloat(e.group.position.x, e.group.position.y + mobTop(e), e.group.position.z, '-' + msg.dmg + (crit ? '!' : ''), FX_COLOR[msg.fx] || '#fff', crit); }
  });
  net.on('mobDead', (msg) => {
    const e = mobEntities.get(msg.id);
    if (e && msg.dmg) { const crit = msg.fx === 'crit'; worldFloat(e.group.position.x, e.group.position.y + mobTop(e), e.group.position.z, '-' + msg.dmg + (crit ? '!' : ''), FX_COLOR[msg.fx] || '#fff', crit); }
    if (e && player && e.group.position.distanceTo(player.pos) < 28) audio.play('mobDie');
    if (msg.id === bossId) { hideBoss(true); audio.play('bossWin'); }
    removeMob(msg.id, true);
  });
  net.on('mobRemove', (msg) => { if (msg.id === bossId) hideBoss(false); removeMob(msg.id, false); });
  net.on('bossTelegraph', (msg) => { bossTelegraph(msg.x, msg.y, msg.z, msg.radius, msg.duration); audio.play('warn'); });
  net.on('bossSlam', (msg) => { spawnRing(new THREE.Vector3(msg.x, msg.y + 0.1, msg.z), msg.radius, 0xff3030); audio.play('slam'); });
  net.on('mobShoot', (msg) => {
    const e = mobEntities.get(msg.id);
    if (e && scene) shootTracer(e.group.position.clone().add(new THREE.Vector3(0, 1, 0)),
      new THREE.Vector3(msg.tx, msg.ty, msg.tz), 0xffffff);
  });
  net.on('sold', (msg) => {
    if (msg.earned > 0) { ui.toast(`💰 Sold materials for ${msg.earned} cash!`); audio.play('coin'); }
    else ui.toast('Nothing to sell.');
  });
  net.on('looted', (msg) => {
    const bits = [];
    if (msg.cash) bits.push(`💰 ${msg.cash}`);
    if (msg.count) bits.push(`🎒 ${msg.count} materials`);
    ui.toast(`Looted ${msg.owner ? msg.owner + "'s" : 'a'} stash!\n${bits.join('  ')}`);
    audio.play('coin');
  });
  net.on('playerAppearance', (msg) => {
    const r = remotePlayers.get(msg.id);
    if (r) { r.appearance = msg.appearance; rebuildRemoteAvatar(r); }
  });
  net.on('playerEquipment', (msg) => {
    const r = remotePlayers.get(msg.id);
    if (r) { r.equipment = msg.equipment; rebuildRemoteAvatar(r); }
  });
  net.on('playerSwing', (msg) => {
    const r = remotePlayers.get(msg.id);
    if (r) r.swing = 1; // animation progress, decays in the loop
  });
  net.on('playerFly', (msg) => {
    const r = remotePlayers.get(msg.id);
    if (r && r.canFly !== !!msg.value) { r.canFly = !!msg.value; rebuildRemoteAvatar(r); }
  });
  net.on('playerDead', (msg) => {
    const r = remotePlayers.get(msg.id);
    if (r) r.dead = !!msg.dead;
  });
  net.on('playerHurt', (msg) => {
    const r = remotePlayers.get(msg.id);
    if (r) { r.painUntil = performance.now() + 450; setPainFace(r.group, true); }
  });
  net.on('chat', (msg) => ui.addChat(msg.name, msg.text, msg.system));
  net.on('sessionReplaced', () => {
    sessionEnded = true;
    ui.toast('⚠️ You logged in on another device.\nThis session has ended.');
  });
  net.on('disconnect', () => ui.addChat('',
    sessionEnded ? 'Session ended — you logged in on another device.'
                 : 'Disconnected from server. Reconnecting…', true));
}

let sessionEnded = false; // set when the server kicks us for a newer login
let currentStats = defaultStats();
function defaultStats() {
  return { score: 0, level: 1, xp: 0, nextLevelXp: 50, blocksMined: 0, blocksPlaced: 0, kills: 0, cash: 0, inventory: {}, equipment: defaultEquipment(), progress: defaultProgress('soldier') };
}

// Apply the authoritative equipment/progress: drives combat, derived player
// stats (speed, max health, hunger) and the bag UI.
let myBuffSpeed = 1;
let _buffTimer = null;
function applyEquipment(eq) { myEquipment = eq; ui.setEquipment(eq); ui.setHeldWeapon(eq.weapon); recomputeDerived(); buildViewModel(); }

// Quick-swap the held weapon between the class's favored weapon and the axe
// (the slot-1 default). Falls back to a sword if the favored weapon isn't owned.
function switchWeapon() {
  if (!myEquipment) return;
  const fav = (CLASSES[myProgress.class] && CLASSES[myProgress.class].favored) || 'sword';
  const owned = myEquipment.weapons || {};
  const primary = owned[fav] ? fav : 'sword';
  const target = myEquipment.weapon === 'axe' ? primary : 'axe';
  if (!owned[target]) { ui.toast('🪓 You don\'t have that weapon yet — craft it in the Bag.'); return; }
  if (target === myEquipment.weapon) return;
  // Optimistic icon + feedback so the swap is obvious (esp. on touch); the
  // server confirms via a stats push.
  ui.setHeldWeapon(target);
  const w = WEAPONS[target] || {};
  ui.toast(`${w.icon || ''} ${w.name || target} equipped`);
  net.sendCraft({ kind: 'weapon', item: target, action: 'equip' });
}
function applyProgress(p) { myProgress = p; ui.setProgress(p); recomputeDerived(); buildSkillBar(); }

function recomputeDerived() {
  if (!player) return;
  const speed = speedMultiplier(myEquipment) * speedAttrMult(myProgress) * (1 - bodyArmorWeight(myEquipment)) * myBuffSpeed * tuning.moveSpeedMult;
  player.speedMul = Math.max(0.4, Math.min(4, speed));
  player.maxHealth = maxHealth(myProgress);
  player.hungerMul = hungerMult(myProgress) * tuning.hungerDrainMult;
  player.staminaDrainSec = tuning.staminaDrainSec;
  player.staminaRefillSec = tuning.staminaRefillSec;
  if (thirdPerson) rebuildOwnAvatar();
}

// ---------------------------------------------------------------- skills
const skillSlots = [];          // [{ el, overlay, badge }]
const skillReady = {};          // skillId -> performance.now() when usable again

function buildSkillBar() {
  const bar = document.getElementById('skillbar');
  if (!bar) return;
  bar.innerHTML = '';
  skillSlots.length = 0;
  classSkills(myProgress.class).forEach((sk, slot) => {
    const lvl = (myProgress.skills && myProgress.skills[sk.id]) || 0;
    const el = document.createElement('div');
    el.className = 'skill' + (lvl === 0 ? ' locked' : '');
    el.innerHTML = `<span class="sk-ico">${sk.icon}</span><span class="sk-key">${['Z', 'X', 'C'][slot]}</span>` +
      `<span class="sk-lvl">${lvl ? 'L' + lvl : '🔒'}</span><div class="sk-cd"></div>`;
    const use = (e) => { e.preventDefault(); useSkillSlot(slot); };
    el.addEventListener('pointerdown', use);
    bar.appendChild(el);
    skillSlots.push({ el, overlay: el.querySelector('.sk-cd'), skill: sk });
  });
}

function useSkillSlot(slot) {
  if (!player || player.dead) return;
  player.syncCamera(); // aim skills from the eye, not the 3rd-person camera
  const sk = classSkills(myProgress.class)[slot];
  if (!sk) return;
  const lvl = (myProgress.skills && myProgress.skills[sk.id]) || 0;
  if (lvl <= 0) { ui.toast(`${sk.icon} ${sk.name} — learn it first (Bag → Skills)`); return; }
  const now = performance.now();
  if (now < (skillReady[sk.id] || 0)) return; // on cooldown
  skillReady[sk.id] = now + sk.cd * tuning.skillCdMult;
  let target = null, tt = null;
  if (sk.kind === 'nuke') {
    const t = findTarget({ reach: 36 * tuning.skillRangeMult, type: 'ranged', cat: sk.cat });
    if (t) target = t.id, tt = t.kind;
    // Magic skills (fireball) launch a big glowing orb in the aim direction; it
    // homes onto a target if there is one, else streaks off and fades.
    const from = camera.position.clone().addScaledVector(aimDirection(), 0.8);
    if (sk.cat === 'magic') {
      shootProjectile(from, aimDirection(), skillColor(sk),
        { to: t && t.point ? t.point.clone() : null, size: 0.45, maxDist: 30, speed: 15 });
    } else if (t && t.point) {
      shootTracer(camera.position.clone(), t.point, skillColor(sk));
    }
  } else if (sk.kind === 'aoe') {
    spawnRing(player.pos.clone(), (sk.radius || 4) + lvl * 0.4, skillColor(sk));
  }
  ownSwing = 1;
  audio.play(sk.kind === 'heal' ? 'heal' : sk.kind === 'buff' ? 'skillBuff'
    : sk.cat === 'magic' ? 'skillMagic' : sk.cat === 'ranged' ? 'skillRanged' : 'skillMelee');
  net.sendSkill(slot, target, tt);
}

function skillColor(sk) {
  return sk.cat === 'magic' ? 0xbb66ff : sk.kind === 'heal' ? 0x7fe3a0 : sk.kind === 'buff' ? 0xf4d35e : 0xffaa55;
}

// Sprint feedback now lives on the movement joystick (sprinting is driven by
// pushing it forward). The stamina vital bar shows the reserve/cooldown; here we
// just flag the joystick red while stamina is locked in cooldown.
function updateSprintUI() {
  const el = document.getElementById('joystick');
  if (!el || !player) return;
  el.classList.toggle('cd', player.staminaLocked);
}

function updateSkillBar(now) {
  for (const s of skillSlots) {
    const ready = skillReady[s.skill.id] || 0;
    const frac = ready > now ? (ready - now) / (s.skill.cd * tuning.skillCdMult) : 0;
    s.overlay.style.height = Math.round(frac * 100) + '%';
  }
}

// Expanding ring effect for AoE skills.
function spawnRing(pos, radius, color) {
  if (!scene) return;
  const geo = new THREE.RingGeometry(radius * 0.2, radius * 0.25, 24);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(pos.x, pos.y + 0.1, pos.z);
  scene.add(m);
  let t = 0;
  const grow = () => {
    t += 0.06;
    const s = 0.2 + t * 4;
    m.scale.set(s / 0.225, s / 0.225, 1);
    m.material.opacity = Math.max(0, 0.7 - t);
    if (t < 0.7) requestAnimationFrame(grow);
    else { scene.remove(m); geo.dispose(); m.material.dispose(); }
  };
  grow();
}

// ---------------------------------------------------------------- third-person
let thirdPerson = false;
let ownAvatar = null;
let ownPhase = 0;
const _back = new THREE.Vector3();

function toggleView() {
  thirdPerson = !thirdPerson;
  document.getElementById('btn-view')?.classList.toggle('on', thirdPerson);
  if (thirdPerson) rebuildOwnAvatar();
  else if (ownAvatar) { scene.remove(ownAvatar); ownAvatar = null; }
}

function rebuildOwnAvatar() {
  if (!scene) return;
  if (ownAvatar) scene.remove(ownAvatar);
  ownAvatar = buildCharacter(myAppearance, myEquipment);
  if (canFly) addWings(ownAvatar);
  scene.add(ownAvatar);
}

// ---------------------------------------------------------------- first-person viewmodel
let viewModel = null;
const VM_WEAPON_COLOR = { sword: '#d7dce3', axe: '#9aa3ad', pickaxe: '#aab0b8', spear: '#c9cdd4', bow: '#8a5a2b', gun: '#2b2f36', staff: '#7a3aa5', fist: null };

function buildViewModel() {
  if (!camera) return;
  if (viewModel) { camera.remove(viewModel); }
  viewModel = new THREE.Group();
  const skin = (myAppearance && myAppearance.skin) || '#e8b27a';
  const sleeve = (myAppearance && myAppearance.shirt) || '#3a7bd5';
  const box = (w, h, d, x, y, z, c) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: c, depthTest: false }));
    m.position.set(x, y, z); m.renderOrder = 30; viewModel.add(m); return m;
  };
  box(0.16, 0.16, 0.34, 0, 0, -0.18, sleeve);   // forearm (sleeve)
  box(0.17, 0.17, 0.18, 0, 0, -0.4, skin);       // hand
  const w = (myEquipment && myEquipment.weapon) || 'sword';
  const wc = VM_WEAPON_COLOR[w];
  const WOOD = '#6b4f2a';
  if (wc) {
    if (w === 'sword') {
      box(0.05, 0.05, 0.5, 0, 0.04, -0.7, wc);          // blade
      box(0.22, 0.06, 0.06, 0, 0.04, -0.5, '#caa54a');  // crossguard
    } else if (w === 'spear') {
      box(0.04, 0.04, 0.8, 0, 0.04, -0.85, WOOD);       // shaft
      box(0.08, 0.08, 0.14, 0, 0.04, -1.28, wc);        // head
    } else if (w === 'axe') {
      box(0.05, 0.05, 0.46, 0, 0.04, -0.68, WOOD);      // handle
      box(0.05, 0.30, 0.20, 0.13, 0.08, -0.84, wc);     // broad axe head (offset)
      box(0.05, 0.22, 0.10, 0.22, 0.08, -0.84, '#cdd3da'); // edge
    } else if (w === 'pickaxe') {
      box(0.05, 0.05, 0.46, 0, 0.04, -0.68, WOOD);      // handle
      box(0.5, 0.05, 0.05, 0, 0.08, -0.86, wc);         // crossbar head
    } else if (w === 'bow') {
      box(0.04, 0.62, 0.04, 0, 0.04, -0.7, wc);         // riser
      box(0.015, 0.64, 0.015, 0, 0.04, -0.64, '#eeeeee'); // string
    } else if (w === 'gun') {
      box(0.08, 0.12, 0.3, 0, 0.02, -0.62, wc);         // body
      box(0.05, 0.05, 0.22, 0, 0.04, -0.84, '#15181d'); // barrel
    } else if (w === 'staff') {
      box(0.035, 0.035, 0.5, 0, 0.04, -0.7, WOOD);      // wand shaft
      box(0.14, 0.14, 0.14, 0, 0.06, -0.98, '#c98bff'); // glowing crystal orb
    }
  }
  viewModel.position.set(0.42, -0.38, -0.5);
  camera.add(viewModel);
}

function updateViewModel(dt) {
  if (ownSwing > 0) ownSwing = Math.max(0, ownSwing - dt * 3);
  if (!viewModel) return;
  viewModel.visible = !thirdPerson && player && !player.dead && !ui.anyMenuOpen();
  const moving = player && (player.input.forward || player.input.strafe);
  const bob = moving ? Math.sin(performance.now() / 1000 * 8) * 0.02 : 0;
  viewModel.position.set(0.42, -0.38 + bob, -0.5);
  viewModel.rotation.set(-Math.sin(Math.min(1, ownSwing) * Math.PI) * 1.5, -0.25, 0);
}

// Pose the player's own avatar and pull the camera back behind it.
let ownBodyYaw = 0;
function updateThirdPerson(dt) {
  if (!thirdPerson || !ownAvatar || !player) return;
  ownAvatar.position.set(player.pos.x, player.pos.y, player.pos.z);
  if (player.dead) {
    ownAvatar.rotation.set(-Math.PI / 2, player.yaw + Math.PI, 0); // lie down when dead
    return;
  }
  // Body yaw lags the look yaw so the head leads when turning.
  ownBodyYaw += angleDelta(player.yaw, ownBodyYaw) * Math.min(1, dt * 8);
  ownAvatar.rotation.set(0, ownBodyYaw + Math.PI, 0);
  const moving = player.input.forward !== 0 || player.input.strafe !== 0;
  ownPhase += dt * (moving ? 9 : 0);
  animateCharacter(ownAvatar.userData.parts, { phase: ownPhase, moving, swing: ownSwing, pitch: player.pitch, headYaw: player.yaw - ownBodyYaw });
  // Flap the wings while flying; rest them otherwise.
  const wings = ownAvatar.userData.wings;
  if (wings) {
    const flap = player.flying ? Math.sin(performance.now() / 1000 * 14) * 0.6 + 0.2 : 0;
    wings.left.rotation.z = flap;
    wings.right.rotation.z = -flap;
  }
  // Move the camera back along its view axis (local +z is backwards).
  _back.set(0, 0, 1).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(_back, 4.2);
  camera.position.y += 0.4;
}

// ---------------------------------------------------------------- menu / account
function bindMenuActions() {
  ui.onMenuOpen = onMenuOpened;
  ui.bindMenu({
    onSell: () => net.sendSell(),
    onEquip: (type) => net.sendCraft({ kind: 'weapon', item: type, action: 'equip' }),
    onCraft: (req) => net.sendCraft(req),
    onSpend: (attr) => net.sendSpendAttr(attr),
    onUpgradeSkill: (slot) => net.sendSpendSkill(slot),
    onUseConsumable: (kind) => net.sendUseConsumable(kind),
    onCustomize: () => { charEditor.open(myAppearance, myProgress.class, saveAppearance); },
    onLogout: () => { localStorage.removeItem('vc_token'); location.reload(); },
    onDelete: async () => {
      const token = localStorage.getItem('vc_token');
      await net.deleteAccount(token);
      localStorage.removeItem('vc_token');
      location.reload();
    },
  });
}

function refreshSoundBtn() {
  const b = document.getElementById('btn-sound');
  if (b) b.textContent = audio.isEnabled() ? '🔊 Sound: on' : '🔇 Sound: off';
}
function toggleSound() {
  const on = audio.toggle();
  refreshSoundBtn();
  ui.toast(on ? '🔊 Sound on' : '🔇 Sound off');
}

function refreshMusicBtn() {
  const b = document.getElementById('btn-music');
  if (b) b.textContent = audio.musicEnabled() ? '🎵 Music: on' : '🎵 Music: off';
}
function toggleMusic() {
  const on = audio.toggleMusic();
  refreshMusicBtn();
  ui.toast(on ? '🎵 Music on' : '🎵 Music off');
}

// ---- wings / flight ----
let canFly = false;
function setCanFly(v) {
  const was = canFly;
  canFly = !!v;
  if (player) { player.canFly = canFly; if (!canFly) player.flightMode = false; }
  const flyBtn = document.getElementById('btn-fly'); // mobile fly toggle button
  if (flyBtn) flyBtn.classList.toggle('hidden', !canFly);
  refreshFlyIndicator();
  if (thirdPerson) rebuildOwnAvatar(); // show/hide the wings on the avatar
  if (canFly && !was) ui.toast(isTouchDevice()
    ? '🪽 Wings granted! Tap the 🪽 button (right) to toggle flight.'
    : '🪽 Wings granted! Press G to toggle flight (hold Space to climb).');
}

// Flight is a toggle: turn it on to fly (hold Space / the look-tap to climb,
// steer with movement + look), turn it off to walk and jump normally.
function toggleFlight() {
  if (!player || !player.canFly) return;
  player.flightMode = !player.flightMode;
  const btn = document.getElementById('btn-fly');
  if (btn) btn.classList.toggle('flying', player.flightMode);
  refreshFlyIndicator();
  ui.toast(player.flightMode ? '🪽 Flight ON' : '🚶 Flight OFF');
}

function refreshFlyIndicator() {
  const ind = document.getElementById('fly-indicator');
  if (!ind) return;
  ind.classList.toggle('hidden', !canFly);
  if (!canFly) return;
  ind.textContent = (player && player.flightMode)
    ? '🪽 Flying — climb: ' + (isTouchDevice() ? 'tap' : 'Space') + ' · steer: move + look'
    : (isTouchDevice() ? '🪽 Tap 🪽 to fly' : '🪽 Press G to fly');
}

// ---- custom respawn point ----
let spawnPointSet = false;
function refreshSpawnBtn() {
  const b = document.getElementById('btn-setspawn');
  if (b) b.textContent = spawnPointSet ? '📍 Update spawn point here' : '📍 Set spawn point here';
}

function saveAppearance(appearance, cls) {
  const firstTime = !myAppearance;
  myAppearance = appearance;
  net.sendAppearance(appearance);
  if (cls) net.sendSetClass(cls); // server applies only on a fresh character
  buildViewModel();
  ui.toast('🧑‍🎨 Character saved!');
  if (firstTime && !tutorialSeen()) tutorial.open(); // new players get the tour
}

// ---------------------------------------------------------------- remote players
function nameTag(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.y = 2.2;
  return sprite;
}

function makeAvatar(name, appearance, equipment, canFly) {
  const group = buildCharacter(appearance, equipment);
  if (canFly) addWings(group); // so other players can see the game master's wings
  group.add(nameTag(name));
  return group;
}

function addRemote(p) {
  if (remotePlayers.has(p.id)) return;
  const group = makeAvatar(p.name, p.appearance, p.equipment, p.canFly);
  group.position.set(p.x, p.y, p.z);
  scene.add(group);
  remotePlayers.set(p.id, {
    group, target: new THREE.Vector3(p.x, p.y, p.z), yaw: p.yaw || 0, pitch: p.pitch || 0,
    name: p.name, appearance: p.appearance, equipment: p.equipment,
    canFly: !!p.canFly, dead: !!p.dead, bodyYaw: p.yaw || 0, painUntil: 0,
    phase: 0, swing: 0, lastPos: new THREE.Vector3(p.x, p.y, p.z),
  });
}

// Rebuild a remote avatar when appearance/equipment/wings change (keep transform).
function rebuildRemoteAvatar(r) {
  const old = r.group;
  const group = makeAvatar(r.name, r.appearance, r.equipment, r.canFly);
  group.position.copy(old.position);
  group.rotation.y = old.rotation.y;
  scene.add(group);
  scene.remove(old);
  r.group = group;
}

function removeRemote(id) {
  const r = remotePlayers.get(id);
  if (r) { scene.remove(r.group); remotePlayers.delete(id); }
}

// ---------------------------------------------------------------- input
function setupInput() {
  if (isTouchDevice()) {
    setupMobileControls(player, ui, {
      onPrimaryDown: primaryDown, onPrimaryUp: primaryUp, onPlace: placeBlock, onView: toggleView,
      onToggleFly: toggleFlight,
    });
  }
  setupDesktopControls();
  setupHotbarKeys();

  document.getElementById('btn-sound').onclick = () => toggleSound();
  document.getElementById('btn-music')?.addEventListener('click', () => toggleMusic());
  document.getElementById('btn-view2').onclick = () => toggleView();
  document.getElementById('btn-help').onclick = () => { ui.closeAll(); tutorial.open(); };
  document.getElementById('btn-setspawn')?.addEventListener('click', () => net.sendSetSpawn());
  setupSensitivitySlider();
  refreshSoundBtn();
  refreshMusicBtn();
  refreshSpawnBtn();
  document.getElementById('btn-respawn').onclick = () => net.sendRespawn();
  document.getElementById('btn-leaderboard').onclick = () =>
    ui.toggleLeaderboard(() => net.leaderboard());
  setupChat();
}

function setupSensitivitySlider() {
  const slider = document.getElementById('set-sensitivity');
  const label = document.getElementById('set-sensitivity-val');
  if (!slider) return;
  // The slider is a friendly 1–10 scale mapped onto the radian-per-pixel range.
  const toSlider = (s) => Math.round((s / 0.0013) * 5);
  slider.value = String(Math.max(1, Math.min(20, toSlider(lookSensitivity))));
  const show = () => { if (label) label.textContent = '×' + (slider.value / 5).toFixed(1); };
  show();
  slider.addEventListener('input', () => { setSensitivity((slider.value / 5) * 0.0013); show(); });
}

// Toggle a HUD panel open/closed (used by the desktop K / O shortcuts).
function togglePanel(id) {
  if (ui.isOpen(id)) ui.closePanel(id);
  else ui.openPanel(id);
}

const keys = {};
// Open/close the bag; clears held movement so keys don't get stuck, and frees
// the cursor on desktop so the panel is clickable.
// Opening any window frees the cursor and stops movement (no stuck keys).
function onMenuOpened() {
  document.exitPointerLock?.();
  if (player) { player.input.forward = 0; player.input.strafe = 0; player.input.sprint = false; }
  for (const k in keys) keys[k] = false;
}

function setupDesktopControls() {
  const canvas = renderer.domElement;
  canvas.addEventListener('click', () => {
    if (!chatOpen && !ui.anyMenuOpen()) canvas.requestPointerLock();
  });

  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) {
      player.look(e.movementX * lookSensitivity, e.movementY * lookSensitivity);
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (e.button === 0) primaryDown();
    else if (e.button === 2) placeBlock();
  });
  addEventListener('mouseup', (e) => { if (e.button === 0) primaryUp(); });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) primaryUp();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  addEventListener('keydown', (e) => {
    // While dead, Enter or Esc respawns (matches the on-screen button).
    if (player && player.dead && !chatOpen) {
      if (e.code === 'Enter' || e.code === 'Escape' || e.code === 'NumpadEnter') {
        net.sendRespawn(); e.preventDefault(); e.stopImmediatePropagation(); return;
      }
    }
    if ((e.code === 'KeyB' || e.code === 'KeyI') && !chatOpen) { ui.toggleBag(); return; }
    if (e.code === 'KeyK' && !chatOpen) { togglePanel('charsheet'); return; } // attributes + skills
    if (e.code === 'KeyO' && !chatOpen) { togglePanel('settings'); return; }  // settings
    if (e.code === 'Escape' && ui.anyMenuOpen()) { ui.closeAll(); return; }
    if (e.code === 'KeyV' && !chatOpen && !ui.anyMenuOpen()) { toggleView(); return; }
    if (e.code === 'KeyM' && !chatOpen) { toggleSound(); return; }
    if (e.code === 'KeyG' && !chatOpen && !ui.anyMenuOpen()) { toggleFlight(); return; } // wings on/off
    if (e.code === 'KeyQ' && !chatOpen && !ui.anyMenuOpen()) { net.sendUseConsumable('medkit'); return; }
    if (e.code === 'KeyF' && !chatOpen && !ui.anyMenuOpen()) { net.sendUseConsumable('food'); return; }
    if (chatOpen || ui.anyMenuOpen()) return;
    if (e.code === 'KeyZ') { useSkillSlot(0); return; }
    if (e.code === 'KeyX') { useSkillSlot(1); return; }
    if (e.code === 'KeyC') { useSkillSlot(2); return; }
    keys[e.code] = true;
    updateKeyInput(keys);
    if (e.code === 'Space') player.input.jump = true;
  });
  addEventListener('keyup', (e) => {
    if (chatOpen || ui.anyMenuOpen()) return;
    keys[e.code] = false;
    updateKeyInput(keys);
    if (e.code === 'Space') player.input.jump = false;
  });

  addEventListener('wheel', (e) => {
    if (!chatOpen) ui.cycleSlot(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });
}

function updateKeyInput(keys) {
  let f = 0, s = 0;
  if (keys['KeyW'] || keys['ArrowUp']) f += 1;
  if (keys['KeyS'] || keys['ArrowDown']) f -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) s += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) s -= 1;
  player.input.forward = f;
  player.input.strafe = s;
  player.input.sprint = !!(keys['ShiftLeft'] || keys['ShiftRight']);
}

function setupHotbarKeys() {
  ui.bindWeaponSwitch(switchWeapon);
  addEventListener('keydown', (e) => {
    if (chatOpen || ui.anyMenuOpen()) return;
    if (e.code.startsWith('Digit')) {
      const n = parseInt(e.code.slice(5), 10);
      if (n < 1 || n > 9) return;
      // Pressing 1 while the weapon slot is already active swaps weapon ⇄ axe.
      if (n === 1 && ui.selected === 0) switchWeapon();
      else ui.selectSlot(n - 1);
    }
  });
}

let chatOpen = false;
function openChat() {
  if (chatOpen) return;
  chatOpen = true;
  const input = document.getElementById('chat-input');
  input.classList.remove('hidden');
  input.focus();             // brings up the soft keyboard on mobile
  document.exitPointerLock();
}
function closeChat(send) {
  const input = document.getElementById('chat-input');
  if (send) { const text = input.value.trim(); if (text) net.sendChat(text); }
  input.value = '';
  input.classList.add('hidden');
  input.blur();
  chatOpen = false;
}
function setupChat() {
  addEventListener('keydown', (e) => {
    if ((e.code === 'Enter' || e.code === 'KeyT') && !chatOpen) { e.preventDefault(); openChat(); }
    else if (e.code === 'Enter' && chatOpen) closeChat(true);
    else if (e.code === 'Escape' && chatOpen) closeChat(false);
  });
  // Touch/desktop chat button: opens the box, or sends if already open.
  const btn = document.getElementById('btn-chat');
  if (btn) btn.addEventListener('click', () => (chatOpen ? closeChat(true) : openChat()));
}

// ---------------------------------------------------------------- combat + blocks
// Press = attack a player in the crosshair (within the weapon's reach), or start
// mining the targeted block. Hold to keep mining; harder blocks take longer.
const mineState = { active: false, key: null, progress: 0, swingT: 0 };
let ownSwing = 0;

// Per-block break progress, persisted by coordinate so a block remembers how
// damaged it is between hits/shots (its "lifespan" stays based on the last
// state). Untouched blocks slowly heal so cracks don't linger forever.
const blockDamage = new Map(); // "x,y,z" -> { dmg, max, t }
function blockFrac(hit) {
  const e = blockDamage.get(`${hit.x},${hit.y},${hit.z}`);
  return e ? Math.min(1, e.dmg / e.max) : 0;
}
// Add `amount` damage to the aimed block; break it (into your inventory) when it
// reaches its hardness. Returns the new 0..1 progress.
function damageBlock(r, amount) {
  const t = world.getBlock(r.hit.x, r.hit.y, r.hit.z);
  if (t === B.AIR || t === B.BEDROCK) return 0;
  const k = `${r.hit.x},${r.hit.y},${r.hit.z}`;
  const max = blockHardness(t);
  let e = blockDamage.get(k);
  if (!e) { e = { dmg: 0, max, t: 0 }; blockDamage.set(k, e); }
  e.max = max;
  e.dmg += amount;
  e.t = performance.now();
  if (e.dmg >= max) { breakBlock(r); blockDamage.delete(k); return 1; }
  return e.dmg / max;
}
// A block keeps its crack state for a while, then very slowly heals if left
// alone — so progress persists across hits but the map stays bounded.
function decayBlockDamage(now, dt) {
  for (const [k, e] of blockDamage) {
    if (now - e.t > 10000) {
      e.dmg -= e.max * 0.2 * dt; // heal over ~5s, only after 10s untouched
      if (e.dmg <= 0) blockDamage.delete(k);
    }
  }
}

// Fire a visible shot at a block point (gun tracer / wand orb).
function shootAtBlock(w, point) {
  const from = camera.position.clone().addScaledVector(aimDirection(), 0.8);
  if (w.cat === 'magic') shootProjectile(from, aimDirection(), 0xc98bff, { to: point.clone(), size: 0.3, maxDist: 24, speed: 22 });
  else shootTracer(camera.position.clone(), point, 0xffee88);
}

// What the primary action (attack/mine button) is currently pointed at. Attack
// wins when a creature is closer than the aimed block (ranged/magic always
// attack); otherwise mine the block. Used by both the action and the bracket.
function computeAim(w) {
  if (!player) return null;
  // In third person the camera is pulled back behind the avatar for rendering;
  // snap it back to the eye so attack/mine rays come from the player, not the
  // displaced camera (otherwise targets read as out of reach).
  player.syncCamera();
  const target = findTarget(w);
  const r = player.raycast();
  let blockDist = Infinity, blockPoint = null;
  if (r) {
    blockPoint = new THREE.Vector3(r.hit.x + 0.5, r.hit.y + 0.5, r.hit.z + 0.5);
    blockDist = camera.position.distanceTo(blockPoint);
  }
  const attackWins = target && (w.cat !== 'melee' || target.dist <= blockDist + 0.4);
  if (attackWins) return { mode: 'attack', target, point: target.point };
  if (!r) return null;
  // No block selected → mine the aimed block; a block selected → build on the
  // adjacent face (where the new block will appear).
  if (ui.selectedBlock() == null) return { mode: 'mine', r, point: blockPoint };
  const p = r.place;
  return { mode: 'build', r, place: p, point: new THREE.Vector3(p.x + 0.5, p.y + 0.5, p.z + 0.5) };
}

function primaryDown() {
  if (!player || player.dead) return;
  ownSwing = 1; // swing the hand/weapon on every press, hit or not
  const w = equippedWeapon(myEquipment);
  const aim = computeAim(w);
  if (aim && aim.mode === 'attack') {
    const target = aim.target;
    net.sendAttack(target.id, w.id, target.kind);
    audio.play(w.cat === 'magic' ? 'skillMagic' : w.cat === 'ranged' ? 'skillRanged' : 'hit');
    if (w.cat === 'magic') {
      const from = camera.position.clone().addScaledVector(aimDirection(), 0.8);
      shootProjectile(from, aimDirection(), 0xc98bff, { to: target.point.clone(), size: 0.3, maxDist: 24, speed: 18 });
    } else if (w.cat === 'ranged') {
      shootTracer(camera.position.clone(), target.point, 0xffee88);
    }
    return;
  }
  // No monster: weapon slot mines/shoots the block, a selected block builds.
  if (ui.selectedBlock() == null) {
    if (w.cat === 'melee') audio.play('swing');
    mineState.active = true;   // hold to mine (melee) or auto-fire at it (ranged)
    mineState.swingT = 0;      // fire/chip on the very next frame
  } else {
    placeBlock();
  }
}

// Snap the on-screen target bracket onto whatever the primary action will hit.
const _proj = new THREE.Vector3();
function updateAimUI() {
  const el = document.getElementById('target-bracket');
  if (!el) return;
  if (!player || player.dead) { el.classList.add('hidden'); highlight.visible = false; return; }
  const aim = computeAim(equippedWeapon(myEquipment));
  if (!aim) { el.classList.add('hidden'); highlight.visible = false; return; }
  // 3D wire box on the block (mine) or the placement cell (build).
  if (aim.mode === 'attack') { highlight.visible = false; }
  else { highlight.position.copy(aim.point); highlight.visible = true; }
  // Project the target to screen and place the bracket.
  _proj.copy(aim.point).project(camera);
  if (_proj.z > 1) { el.classList.add('hidden'); return; }
  const x = (_proj.x * 0.5 + 0.5) * innerWidth;
  const y = (-_proj.y * 0.5 + 0.5) * innerHeight;
  const dist = camera.position.distanceTo(aim.point);
  const size = Math.max(26, Math.min(82, 170 / Math.max(1, dist)));
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = size + 'px';
  el.style.height = size + 'px';
  el.classList.toggle('attack', aim.mode === 'attack');
  el.classList.toggle('build', aim.mode === 'build');
  el.classList.remove('hidden');
}
function primaryUp() {
  mineState.active = false;
  mineState.key = null;
  mineState.progress = 0;
  setMineBar(0);
  // Cracks persist on the block (driven by the aim UI), so don't clear them here.
}

function updateMining(dt) {
  if (!mineState.active || !player || player.dead || ui.anyMenuOpen()) { if (!mineState.active) setMineBar(0); return; }
  const w = equippedWeapon(myEquipment);
  const ranged = w.cat === 'ranged' || w.cat === 'magic';
  // Break rate (damage/sec): weapon mining power (axe good, gun/wand weak) × strength.
  const rate = (1 + (w.mine || 0) * 0.4) * miningMult(myProgress);
  mineState.swingT -= dt;
  const r = player.raycast();
  const t = r ? world.getBlock(r.hit.x, r.hit.y, r.hit.z) : B.AIR;
  const minable = r && t !== B.AIR && t !== B.BEDROCK;

  if (ranged) {
    // Shooters fire on a cadence: at a block they chip it open; otherwise they
    // still throw a projectile out to their range that flies and fades — so the
    // wand/gun always "shoots" the same way, target or not.
    if (mineState.swingT <= 0) {
      mineState.swingT = 0.4;
      ownSwing = 1;
      audio.play(w.cat === 'magic' ? 'skillMagic' : 'skillRanged');
      if (minable) {
        shootAtBlock(w, new THREE.Vector3(r.hit.x + 0.5, r.hit.y + 0.5, r.hit.z + 0.5));
        setMineBar(damageBlock(r, rate * 0.45));
      } else {
        throwShot(w); // nothing to mine: throw into the distance and fade
        setMineBar(0);
      }
    } else {
      setMineBar(minable ? blockFrac(r.hit) : 0);
    }
  } else {
    if (!minable) { setMineBar(0); return; }
    if (mineState.swingT <= 0) { ownSwing = 1; mineState.swingT = 0.45; }
    setMineBar(damageBlock(r, rate * dt)); // melee: continuous chipping
  }
}

// Throw a projectile in the aim direction with no target — it flies out to the
// weapon's range and fades (consistent with the on-target shot's look).
function throwShot(w) {
  const dir = aimDirection();
  const from = camera.position.clone().addScaledVector(dir, 0.8);
  if (w.cat === 'magic') shootProjectile(from, dir, 0xc98bff, { size: 0.3, maxDist: w.reach, speed: 22 });
  else shootTracer(camera.position.clone(), camera.position.clone().addScaledVector(dir, w.reach), 0xffee88);
}

// Render a persistent crack overlay on EVERY damaged block, so the cracks stay
// visible whether or not you're currently aiming at the block. Overlays are
// removed when a block fully heals, breaks, or is otherwise gone.
function updateCracks() {
  if (!scene || !crackTextures) return;
  const stages = crackTextures.length;
  for (const [k, e] of blockDamage) {
    const frac = Math.min(1, e.dmg / e.max);
    if (frac <= 0.001) continue;
    const [x, y, z] = k.split(',').map(Number);
    const bt = world.getBlock(x, y, z);
    if (bt === B.AIR || bt === B.BEDROCK) { blockDamage.delete(k); continue; } // gone (e.g. someone else broke it)
    const stage = Math.min(stages - 1, Math.floor(frac * stages));
    let mesh = crackOverlays.get(k);
    if (!mesh) {
      mesh = new THREE.Mesh(crackGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
      }));
      mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
      mesh.renderOrder = 2;
      scene.add(mesh);
      crackOverlays.set(k, mesh);
    }
    if (mesh.material.map !== crackTextures[stage]) { mesh.material.map = crackTextures[stage]; mesh.material.needsUpdate = true; }
  }
  // Drop overlays whose blocks are no longer damaged.
  for (const [k, mesh] of crackOverlays) {
    if (!blockDamage.has(k)) { scene.remove(mesh); mesh.material.dispose(); crackOverlays.delete(k); }
  }
}

// Warn (once) when hunger hits zero — the server then drains health until the
// player eats. The food bar pulses while starving.
let starvingWarned = false;
function checkStarving() {
  if (!player) return;
  const starving = player.hunger <= 0 && !player.dead;
  document.getElementById('food-fill')?.closest('.vbar')?.classList.toggle('starving', starving);
  if (starving && !starvingWarned) {
    starvingWarned = true;
    ui.toast('🍖 Starving! Your health is draining — eat food (F or the 🍗 button).');
  } else if (!starving) {
    starvingWarned = false;
  }
}

function setMineBar(frac) {
  const el = document.getElementById('mine-bar');
  if (!el) return;
  el.style.opacity = frac > 0 ? '1' : '0';
  el.firstElementChild.style.width = Math.round(frac * 100) + '%';
}

const _fwd = new THREE.Vector3();
// Best target (player or mob) in the crosshair within reach. Returns
// { id, kind, point } or null. Ranged/magic need tighter aim than melee.
function findTarget(w) {
  const reach = w.reach;
  const minDot = w.type === 'ranged' ? 0.985 : 0.86;
  camera.getWorldDirection(_fwd);
  let best = null, bestDist = Infinity;
  const consider = (id, kind, cx, cy, cz) => {
    const dx = cx - camera.position.x, dy = cy - camera.position.y, dz = cz - camera.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > reach || dist < 0.001) return;
    if ((dx * _fwd.x + dy * _fwd.y + dz * _fwd.z) / dist < minDot) return;
    // No shooting/striking through walls: a solid block between us blocks it.
    if (losBlocked(camera.position, cx, cy, cz)) return;
    if (dist < bestDist) { bestDist = dist; best = { id, kind, dist, point: new THREE.Vector3(cx, cy, cz) }; }
  };
  for (const [id, r] of remotePlayers) consider(id, 'player', r.group.position.x, r.group.position.y + 1.0, r.group.position.z);
  for (const [id, e] of mobEntities) {
    const h = (MOB_TYPES[e.type] || MOB_TYPES.slime).height;
    consider(id, 'mob', e.group.position.x, e.group.position.y + h * 0.6, e.group.position.z);
  }
  return best;
}

// Is the straight line from `from` to (tx,ty,tz) blocked by a solid block before
// it reaches the target's cell? DDA voxel traversal (line of sight for shots).
function losBlocked(from, tx, ty, tz) {
  const dirx = tx - from.x, diry = ty - from.y, dirz = tz - from.z;
  const len = Math.hypot(dirx, diry, dirz);
  if (len < 0.001) return false;
  const dx = dirx / len, dy = diry / len, dz = dirz / len;
  let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z);
  const tgX = Math.floor(tx), tgY = Math.floor(ty), tgZ = Math.floor(tz);
  const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
  const tDX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDZ = dz === 0 ? Infinity : Math.abs(1 / dz);
  let tMX = dx === 0 ? Infinity : ((stepX > 0 ? x + 1 - from.x : from.x - x) * tDX);
  let tMY = dy === 0 ? Infinity : ((stepY > 0 ? y + 1 - from.y : from.y - y) * tDY);
  let tMZ = dz === 0 ? Infinity : ((stepZ > 0 ? z + 1 - from.z : from.z - z) * tDZ);
  let guard = 0;
  while (guard++ < 256) {
    if (tMX < tMY && tMX < tMZ) { x += stepX; if (tMX > len) return false; tMX += tDX; }
    else if (tMY < tMZ) { y += stepY; if (tMY > len) return false; tMY += tDY; }
    else { z += stepZ; if (tMZ > len) return false; tMZ += tDZ; }
    if (x === tgX && y === tgY && z === tgZ) return false; // reached the target cell
    if (isSolid(world.getBlock(x, y, z))) return true;     // wall in the way
  }
  return false;
}

// Brief tracer line for ranged/magic shots.
function shootTracer(from, to, color) {
  if (!scene) return;
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  scene.add(line);
  setTimeout(() => { scene.remove(line); geo.dispose(); line.material.dispose(); }, 100);
}

// An obvious glowing projectile that flies from `from` along `dir`. If `to` is
// given it homes onto that point (a hit); otherwise it streaks ahead and fades
// after `maxDist` blocks (a miss). Used for the mage's fireball etc.
function shootProjectile(from, dir, color, { to = null, maxDist = 26, speed = 16, size = 0.32 } = {}) {
  if (!scene) return;
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(size, 14, 14),
    new THREE.MeshBasicMaterial({ color }));
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(size * 2.3, 14, 14),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 }));
  core.add(glow);
  core.position.copy(from);
  scene.add(core);
  const d = dir.clone().normalize();
  let travelled = 0;
  let lastT = performance.now();
  const startT = lastT;
  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    const adv = speed * dt;
    travelled += adv;
    core.position.addScaledVector(d, adv);
    // Pulse the glow so the orb is clearly visible as it travels.
    const pulse = 1 + Math.sin((now - startT) / 60) * 0.15;
    glow.scale.setScalar(pulse);
    glow.material.opacity = 0.4 * (1 - travelled / (maxDist * 1.15));
    const reached = to && core.position.distanceTo(to) < 0.8;
    if (reached) { spawnRing(to.clone(), 1.4, color); cleanup(); return; }
    if (travelled >= maxDist) { glow.material.opacity = 0; cleanup(); return; } // fade out, no target
    requestAnimationFrame(step);
  };
  const cleanup = () => {
    scene.remove(core);
    core.geometry.dispose(); core.material.dispose();
    glow.geometry.dispose(); glow.material.dispose();
  };
  requestAnimationFrame(step);
}

// World-space aim direction from the camera (the way the player is pointing).
const _aimDir = new THREE.Vector3();
function aimDirection() { camera.getWorldDirection(_aimDir); return _aimDir.clone(); }

function breakBlock(r) {
  if (!player || player.dead) return;
  r = r || player.raycast();
  if (!r) return;
  const t = world.getBlock(r.hit.x, r.hit.y, r.hit.z);
  if (t === B.BEDROCK || t === B.AIR) return;
  const affected = world.applyEdit(r.hit.x, r.hit.y, r.hit.z, B.AIR);
  world.remeshChunks(affected);
  audio.play('break');
  net.sendBlock('break', r.hit.x, r.hit.y, r.hit.z, B.AIR, null, t);
}

function placeBlock() {
  if (!player || player.dead) return;
  const block = ui.selectedBlock();
  if (block == null) return; // a tool is selected, nothing to place
  // Building consumes mined blocks — you can't place what you haven't gathered.
  if (ui.blockCount(block) <= 0) {
    ui.toast('⛏ Mine more of this block to build with it.');
    audio.play('swing');
    return;
  }
  const r = player.raycast();
  if (!r) return;
  const { x, y, z } = r.place;
  if (!player.canPlaceAt(x, y, z)) return;
  if (isSolid(world.getBlock(x, y, z))) return;
  const affected = world.applyEdit(x, y, z, block);
  world.remeshChunks(affected);
  audio.play('place');
  // Optimistically decrement; the server's authoritative stats will reconcile.
  if (currentStats.inventory) {
    currentStats.inventory[block] = Math.max(0, (currentStats.inventory[block] || 0) - 1);
    ui.inventory = currentStats.inventory; ui.updateBlockCounts();
  }
  net.sendBlock('place', x, y, z, block);
}

// ---------------------------------------------------------------- pickups
const pickups = new Map();          // id -> { kind, mesh, baseY, phase, x, y, z }
const requestedPickups = new Set(); // ids we've already asked to collect

function makePickupSprite(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fillStyle = kind === 'medkit' ? 'rgba(220,60,60,0.35)' : 'rgba(240,180,60,0.35)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = kind === 'medkit' ? '#ff6b6b' : '#f4d35e';
  ctx.stroke();
  ctx.font = '34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(kind === 'medkit' ? '🩹' : '🍗', 32, 34);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
  sprite.scale.set(0.8, 0.8, 0.8);
  return sprite;
}

function addPickup(p) {
  if (!scene || pickups.has(p.id)) return;
  const mesh = makePickupSprite(p.kind);
  mesh.position.set(p.x, p.y + 0.6, p.z);
  scene.add(mesh);
  pickups.set(p.id, { kind: p.kind, mesh, baseY: p.y + 0.6, phase: Math.random() * 6.28,
    x: p.x, y: p.y, z: p.z });
}

function removePickup(id) {
  const e = pickups.get(id);
  if (!e) return;
  scene.remove(e.mesh);
  e.mesh.material.map?.dispose();
  e.mesh.material.dispose();
  pickups.delete(id);
  requestedPickups.delete(id);
}

function updatePickups(t) {
  for (const [id, e] of pickups) {
    e.mesh.position.y = e.baseY + Math.sin(t * 3 + e.phase) * 0.18;
    if (player && !player.dead && !requestedPickups.has(id)) {
      // Cylindrical proximity: a generous horizontal radius plus a tall vertical
      // tolerance so jumping over (or standing under) a floating pickup still
      // grabs it. The server allows up to 2.5 units, so stay within that.
      const dx = e.x - player.pos.x;
      const dz = e.z - player.pos.z;
      const dy = e.y - player.pos.y; // pickup ground level vs. feet
      if (dx * dx + dz * dz < 1.7 * 1.7 && dy > -1.5 && dy < 2.4) {
        requestedPickups.add(id);
        net.sendPickup(id);
      }
    }
  }
}

let _flashTimer = null;
function hurtFlash() {
  const el = document.getElementById('hurt-flash');
  if (!el) return;
  el.classList.add('show');
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => el.classList.remove('show'), 180);
}

// ---------------------------------------------------------------- combat juice
const FX_COLOR = { hit: '#ffffff', skill: '#c9a0ff', burn: '#ff8c42', crit: '#ffd23f' };
const floats3d = [];
// Floating combat number in the 3D world (for monsters / other players).
function worldFloat(x, y, z, text, color, big) {
  if (!scene) return;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.font = `bold ${big ? 58 : 46}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(text, 64, 32);
  g.fillStyle = color; g.fillText(text, 64, 32);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.position.set(x + (Math.random() - 0.5) * 0.5, y, z);
  const s = big ? 1.9 : 1.3;
  sp.scale.set(s, s * 0.5, 1);
  scene.add(sp);
  const life = big ? 1.1 : 0.9;
  floats3d.push({ sp, life, max: life });
}
function updateFloats(dt) {
  for (let i = floats3d.length - 1; i >= 0; i--) {
    const f = floats3d[i];
    f.life -= dt;
    f.sp.position.y += dt * 1.3;
    f.sp.material.opacity = Math.max(0, f.life / f.max);
    if (f.life <= 0) { scene.remove(f.sp); f.sp.material.map.dispose(); f.sp.material.dispose(); floats3d.splice(i, 1); }
  }
}
// Floating number for the player themselves (centred DOM popup).
function selfFloat(text, color) {
  const box = document.getElementById('floats');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'float';
  el.textContent = text;
  el.style.color = color;
  el.style.left = (50 + (Math.random() * 10 - 5)) + '%';
  box.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

// ---------------------------------------------------------------- boss UI
let bossId = null, bossMax = 1;
let _bossBannerTimer = null;
function bossBanner(text) {
  const el = document.getElementById('boss-banner');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(_bossBannerTimer);
  _bossBannerTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}
function showBoss(mob) {
  audio.play('boss');
  bossId = mob.id; bossMax = mob.maxHealth || 1;
  document.getElementById('boss-name').textContent = (MOB_TYPES[mob.type] || {}).name || 'Boss';
  document.getElementById('boss-fill').style.width = (mob.health / bossMax * 100) + '%';
  document.getElementById('boss-bar').classList.remove('hidden');
  bossBanner('⚔️ ' + ((MOB_TYPES[mob.type] || {}).name || 'Boss') + ' has appeared!');
}
function updateBoss(health) {
  if (bossId == null) return;
  document.getElementById('boss-fill').style.width = Math.max(0, health / bossMax * 100) + '%';
}
function hideBoss(victory) {
  if (bossId == null) return;
  bossId = null;
  document.getElementById('boss-bar').classList.add('hidden');
  if (victory) bossBanner('🏆 Boss defeated!');
}

// Red danger zone on the ground that fills up over the wind-up; get out before
// it completes or take the slam.
function bossTelegraph(x, y, z, radius, duration) {
  if (!scene) return;
  const mkMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), mkMat(0xff3030, 0.16));
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.93, radius, 40), mkMat(0xff5555, 0.85));
  const fill = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), mkMat(0xff2020, 0.4));
  for (const o of [disc, ring, fill]) { o.rotation.x = -Math.PI / 2; o.position.set(x, y + 0.06, z); scene.add(o); }
  fill.scale.setScalar(0.01);
  const t0 = performance.now();
  const tick = () => {
    const p = Math.min(1, (performance.now() - t0) / duration);
    fill.scale.setScalar(Math.max(0.01, p));
    if (p < 1) requestAnimationFrame(tick);
    else for (const o of [disc, ring, fill]) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- monsters (PvE)
const mobEntities = new Map(); // id -> { group, parts, target, yaw, type, health, maxHealth, bar, ... }

function buildMobMesh(type) {
  const def = MOB_TYPES[type] || MOB_TYPES.slime;
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshBasicMaterial({ color: c });
  const box = (w, h, d, x, y, z, c, rot) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
    m.position.set(x, y, z); if (rot) m.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
    g.add(m); return m;
  };
  const H = def.height;
  const C = def.color;
  if (type === 'slime') {                      // gooey two-tier blob with a grin
    box(1.05, 0.5, 1.05, 0, 0.26, 0, C);
    box(0.74, 0.42, 0.74, 0, 0.66, 0, C);
    box(0.42, 0.22, 0.42, 0, 0.95, 0, C);
    box(0.14, 0.16, 0.06, -0.19, 0.6, 0.37, 0x102010);
    box(0.14, 0.16, 0.06, 0.19, 0.6, 0.37, 0x102010);
    box(0.34, 0.05, 0.05, 0, 0.4, 0.4, 0x0c180c);
    box(0.22, 0.22, 0.22, -0.5, 0.18, 0, C);   // little blobs
    box(0.18, 0.18, 0.18, 0.52, 0.16, 0.1, C);
    // finer detail: glints in the eyes + teeth in the grin
    box(0.05, 0.05, 0.03, -0.22, 0.64, 0.4, 0xeafdea);
    box(0.05, 0.05, 0.03, 0.16, 0.64, 0.4, 0xeafdea);
    for (const tx of [-0.1, 0.02, 0.14]) box(0.05, 0.06, 0.03, tx, 0.41, 0.41, 0xeafdea);
    // gooey drips oozing off the underside + a wet sheen on top
    for (const [dx, dz] of [[-0.42, 0.3], [0.46, 0.18], [0.1, -0.45], [-0.3, -0.32]])
      addAccent(g, 'drip', { x: dx, y: 0.16, z: dz, w: 0.2, h: 0.32, color: C, flip: true, opacity: 0.9 });
    addAccent(g, 'wisp', { x: -0.12, y: 0.9, z: 0.05, w: 0.5, h: 0.3, color: 0xbfffe0, glow: true, opacity: 0.5 });
  } else if (type === 'zombie') {              // lurching, arms outstretched
    box(0.22, 0.7, 0.26, -0.14, 0.35, 0, 0x39592f);
    box(0.22, 0.7, 0.26, 0.14, 0.35, 0, 0x39592f);
    box(0.6, 0.72, 0.32, 0, 1.06, 0, C);
    box(0.5, 0.18, 0.34, -0.02, 1.34, 0.02, 0x3f6a36); // torn shoulder
    box(0.16, 0.6, 0.16, -0.36, 1.25, 0.32, C, [-1.2, 0, 0]); // reaching arms
    box(0.16, 0.6, 0.16, 0.36, 1.25, 0.32, C, [-1.2, 0, 0]);
    box(0.17, 0.17, 0.17, -0.36, 1.0, 0.62, 0x6a8a5a);
    box(0.17, 0.17, 0.17, 0.36, 1.0, 0.62, 0x6a8a5a);
    box(0.46, 0.46, 0.46, 0.04, 1.62, 0, 0x6a8a5a, [0, 0, 0.18]); // tilted head
    box(0.09, 0.11, 0.05, -0.08, 1.66, 0.24, 0x180c00);
    box(0.09, 0.11, 0.05, 0.16, 1.62, 0.24, 0x180c00);
    // finer detail: bony fingers, exposed rib, gaping jaw
    for (const hx of [-0.36, 0.36]) for (const fx of [-0.05, 0, 0.05])
      box(0.04, 0.12, 0.04, hx + fx, 0.92, 0.66, 0x6a8a5a);
    box(0.3, 0.04, 0.2, 0, 1.12, 0.16, 0xcfd8b8); // exposed ribcage
    box(0.14, 0.05, 0.05, 0.04, 1.5, 0.22, 0x180c00); // mouth
    // tattered, rotting clothes hanging off the torso + lank hair
    addAccent(g, 'tatter', { x: 0, y: 0.62, z: 0.16, w: 0.6, h: 0.5, color: 0x3a4a2a, opacity: 0.95 });
    addAccent(g, 'tatter', { x: 0.34, y: 0.95, z: 0.34, w: 0.3, h: 0.34, color: 0x44331f });
    addAccent(g, 'frill', { x: 0.04, y: 1.78, z: -0.04, w: 0.4, h: 0.3, color: 0x2a3320 });
  } else if (type === 'skeleton') {            // bony white with a ribcage & skull
    box(0.12, 0.72, 0.12, -0.12, 0.36, 0, 0xc8c8c0);
    box(0.12, 0.72, 0.12, 0.12, 0.36, 0, 0xc8c8c0);
    box(0.12, 0.12, 0.12, 0, 0.78, 0, 0xb8b8b0); // pelvis
    box(0.1, 0.55, 0.1, 0, 1.1, 0, 0xd0d0c8);    // spine
    for (let i = 0; i < 3; i++) box(0.4, 0.05, 0.24, 0, 0.92 + i * 0.16, 0, 0xdeded6); // ribs
    box(0.1, 0.5, 0.1, -0.27, 1.12, 0, 0xc8c8c0); // arms
    box(0.1, 0.5, 0.1, 0.27, 1.12, 0, 0xc8c8c0);
    box(0.42, 0.4, 0.4, 0, 1.62, 0, 0xeeeee6);    // skull
    box(0.11, 0.13, 0.05, -0.1, 1.64, 0.2, 0x111111); // eye sockets
    box(0.11, 0.13, 0.05, 0.1, 1.64, 0.2, 0x111111);
    box(0.26, 0.07, 0.05, 0, 1.46, 0.2, 0x111111);    // jaw
    // finer detail: finger bones, teeth row, neck vertebra
    for (const hx of [-0.27, 0.27]) for (const fx of [-0.05, 0, 0.05])
      box(0.035, 0.13, 0.035, hx + fx, 0.84, 0, 0xc8c8c0);
    for (const tx of [-0.08, 0, 0.08]) box(0.05, 0.04, 0.04, tx, 1.45, 0.22, 0xeeeee6);
    box(0.08, 0.07, 0.08, 0, 1.4, 0, 0xd0d0c8);
    // an eerie glow in the eye sockets + faint bone dust
    addAccent(g, 'wisp', { x: -0.1, y: 1.62, z: 0.22, w: 0.18, h: 0.18, color: 0x9ff0ff, glow: true });
    addAccent(g, 'wisp', { x: 0.1, y: 1.62, z: 0.22, w: 0.18, h: 0.18, color: 0x9ff0ff, glow: true });
    addAccent(g, 'frill', { x: 0, y: 1.0, z: 0, w: 0.5, h: 0.22, color: 0xded6c4, opacity: 0.85 });
  } else if (type === 'brute') {               // hulking, tiny head, shoulder spikes
    box(0.36, 1.0, 0.42, -0.24, 0.5, 0, 0x5a2f2f);
    box(0.36, 1.0, 0.42, 0.24, 0.5, 0, 0x5a2f2f);
    box(1.1, 1.2, 0.74, 0, 1.6, 0, C);            // huge torso
    box(0.44, 1.15, 0.46, -0.78, 1.5, 0, C);      // massive arms
    box(0.44, 1.15, 0.46, 0.78, 1.5, 0, C);
    box(0.3, 0.3, 0.3, -0.8, 0.92, 0, 0x7a4a4a);  // fists
    box(0.3, 0.3, 0.3, 0.8, 0.92, 0, 0x7a4a4a);
    box(0.46, 0.4, 0.44, 0, 2.45, 0, 0x6a3a3a);   // small head sunk in shoulders
    box(0.12, 0.13, 0.05, -0.1, 2.5, 0.22, 0xff3b3b);
    box(0.12, 0.13, 0.05, 0.1, 2.5, 0.22, 0xff3b3b);
    box(0.22, 0.34, 0.22, -0.6, 2.3, 0, 0xb0b0b0, [0, 0, 0.5]); // spikes
    box(0.22, 0.34, 0.22, 0.6, 2.3, 0, 0xb0b0b0, [0, 0, -0.5]);
    // finer detail: chunky knuckles + brow ridge
    for (const sgn of [-1, 1]) for (const kx of [-0.09, 0.09])
      box(0.1, 0.1, 0.1, sgn * 0.8 + kx, 1.06, 0.12, 0x7a4a4a);
    box(0.5, 0.08, 0.1, 0, 2.56, 0.2, 0x4a2424); // heavy brow
    // jagged bony spikes along the shoulders + coarse back fur
    for (const sx of [-0.72, -0.24, 0.24, 0.72])
      addAccent(g, 'spike', { x: sx, y: 2.18, z: -0.1, w: 0.26, h: 0.5, color: 0xcfcfcf });
    addAccent(g, 'frill', { x: 0, y: 1.7, z: -0.36, w: 0.9, h: 0.5, color: 0x3a1d1d });
    addAccent(g, 'ember', { x: 0, y: 2.5, z: 0.24, w: 0.5, h: 0.4, color: 0xff5a3c, glow: true });
  } else if (type === 'boss') {                // towering warlord: cape, horns, glow
    box(0.4, 1.2, 0.46, -0.27, 0.6, 0, 0x2c1450);
    box(0.4, 1.2, 0.46, 0.27, 0.6, 0, 0x2c1450);
    box(1.1, 1.4, 0.36, 0, 1.85, -0.42, 0x1a0a30); // cape
    box(1.16, 1.34, 0.82, 0, 1.95, 0, C);          // torso
    box(1.5, 0.4, 0.9, 0, 2.55, 0, 0x4a1f80);      // broad shoulders
    box(0.48, 1.4, 0.5, -0.86, 1.9, 0, C);         // arms
    box(0.48, 1.4, 0.5, 0.86, 1.9, 0, C);
    box(0.34, 0.34, 0.34, -0.86, 1.1, 0, 0x5a2da0); // fists
    box(0.34, 0.34, 0.34, 0.86, 1.1, 0, 0x5a2da0);
    box(0.6, 0.58, 0.58, 0, 3.05, 0, 0x4a1f80);    // head
    box(0.16, 0.16, 0.06, -0.15, 3.1, 0.3, 0xff2222); // glowing eyes
    box(0.16, 0.16, 0.06, 0.15, 3.1, 0.3, 0xff2222);
    box(0.14, 0.5, 0.14, -0.26, 3.5, 0, 0xe8e0d0, [0, 0, 0.5]); // horns
    box(0.14, 0.5, 0.14, 0.26, 3.5, 0, 0xe8e0d0, [0, 0, -0.5]);
    // finer detail: knuckle plates, horn tips, jaw
    for (const sgn of [-1, 1]) for (const kx of [-0.1, 0.1])
      box(0.11, 0.11, 0.11, sgn * 0.86 + kx, 1.28, 0.14, 0x6a3da0);
    box(0.08, 0.14, 0.08, -0.34, 3.85, 0, 0xfff4e0, [0, 0, 0.6]);
    box(0.08, 0.14, 0.08, 0.34, 3.85, 0, 0xfff4e0, [0, 0, -0.6]);
    // a ragged, billowing cape + hellish glow at the eyes, hands and crown
    for (const tx of [-0.3, 0, 0.3])
      addAccent(g, 'tatter', { x: tx, y: 0.4, z: -0.5, w: 0.5, h: 1.1, color: 0x1a0a30 });
    addAccent(g, 'wisp', { x: -0.15, y: 3.1, z: 0.32, w: 0.22, h: 0.26, color: 0xff3030, glow: true });
    addAccent(g, 'wisp', { x: 0.15, y: 3.1, z: 0.32, w: 0.22, h: 0.26, color: 0xff3030, glow: true });
    addAccent(g, 'wisp', { x: -0.86, y: 1.0, z: 0, w: 0.5, h: 0.6, color: 0x9a4cff, glow: true });
    addAccent(g, 'wisp', { x: 0.86, y: 1.0, z: 0, w: 0.5, h: 0.6, color: 0x9a4cff, glow: true });
    addAccent(g, 'wisp', { x: 0, y: 3.3, z: 0, w: 0.7, h: 0.5, color: 0x7a3cff, glow: true, opacity: 0.7 });
  } else {
    box(0.6, 1.0, 0.34, 0, 0.6, 0, C);
    box(0.5, 0.5, 0.5, 0, 1.35, 0, C);
  }
  // Health bar sprite above the mob.
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 10;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(1.2, 0.2, 1);
  sprite.position.y = H + 0.35;
  g.add(sprite);
  // Status-effect icons above the health bar.
  const sc = document.createElement('canvas');
  sc.width = 96; sc.height = 28;
  const ss = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(sc), depthTest: false, transparent: true }));
  ss.scale.set(1.4, 0.4, 1);
  ss.position.y = H + 0.58;
  ss.material.opacity = 0;
  g.add(ss);
  // Remember body materials + colours so we can flash the mob red when hit.
  const bodyMats = [];
  g.traverse((o) => { if (o.isMesh && o.material) bodyMats.push({ mat: o.material, hex: o.material.color.getHex() }); });
  return { group: g, barCanvas: canvas, barSprite: sprite, statusCanvas: sc, statusSprite: ss, top: H + 0.35, bodyMats };
}

function mobTop(e) { return e.top || 1.5; }

const STATUS_ICON = { b: '🔥', s: '🥶', z: '❄️' };
function drawMobStatus(e) {
  const key = (e.st || []).join('');
  if (key === e._stKey) return;
  e._stKey = key;
  const ctx = e.statusCanvas.getContext('2d');
  ctx.clearRect(0, 0, 96, 28);
  if (!key) { e.statusSprite.material.opacity = 0; e.statusSprite.material.map.needsUpdate = true; return; }
  ctx.font = '22px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const icons = (e.st || []).map((c) => STATUS_ICON[c] || '');
  icons.forEach((ic, i) => ctx.fillText(ic, 96 / (icons.length + 1) * (i + 1), 15));
  e.statusSprite.material.opacity = 1;
  e.statusSprite.material.map.needsUpdate = true;
}

function drawMobBar(e) {
  const ctx = e.barCanvas.getContext('2d');
  ctx.clearRect(0, 0, 64, 10);
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, 64, 10);
  const frac = Math.max(0, e.health / e.maxHealth);
  ctx.fillStyle = frac > 0.5 ? '#5fd06f' : frac > 0.25 ? '#f4d35e' : '#e25555';
  ctx.fillRect(1, 1, 62 * frac, 8);
  e.barSprite.material.map.needsUpdate = true;
}
function updateMobBar(e) { drawMobBar(e); }
// Painful reaction on hit: a scale-bump, a red flash, and a 💢 emote.
function mobFlash(e) {
  e.flash = 0.16;
  for (const bm of e.bodyMats || []) bm.mat.color.setHex(0xff5a5a);
  clearTimeout(e.hurtT);
  e.hurtT = setTimeout(() => { for (const bm of e.bodyMats || []) bm.mat.color.setHex(bm.hex); }, 160);
  painEmote(e);
}
function painEmote(e) {
  if (!scene) return;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d');
  g.font = '34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('💢', 24, 27);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(0.7, 0.7, 0.7);
  sp.position.set(e.group.position.x + 0.3, e.group.position.y + mobTop(e) - 0.1, e.group.position.z);
  scene.add(sp);
  floats3d.push({ sp, life: 0.6, max: 0.6 });
}

function addMob(m) {
  if (!scene || mobEntities.has(m.id)) return;
  const built = buildMobMesh(m.type);
  built.group.position.set(m.x, m.y, m.z);
  scene.add(built.group);
  const e = { group: built.group, barCanvas: built.barCanvas, barSprite: built.barSprite,
    statusCanvas: built.statusCanvas, statusSprite: built.statusSprite, top: built.top, bodyMats: built.bodyMats,
    target: new THREE.Vector3(m.x, m.y, m.z), yaw: m.yaw || 0, type: m.type,
    health: m.health, maxHealth: m.maxHealth, phase: Math.random() * 6.28, flash: 0,
    st: undefined, _stKey: '' };
  mobEntities.set(m.id, e);
  drawMobBar(e);
}

function removeMob(id, killed) {
  const e = mobEntities.get(id);
  if (!e) return;
  if (killed && scene) { // brief poof
    e.group.scale.multiplyScalar(1.3);
    setTimeout(() => { scene.remove(e.group); disposeGroup(e.group); }, 60);
  } else if (scene) { scene.remove(e.group); disposeGroup(e.group); }
  mobEntities.delete(id);
}
function disposeGroup(g) { g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); } }); }

function updateMobs(dt, t) {
  const a = Math.min(1, dt * 10);
  for (const e of mobEntities.values()) {
    e.group.position.lerp(e.target, a);
    e.group.rotation.y = e.yaw;
    e.group.position.y += Math.sin(t * 4 + e.phase) * 0.04; // subtle bob
    // Attack tell: lunge toward the target (a jab); legless slimes hop at you.
    if (e.attackT > 0) {
      e.attackT = Math.max(0, e.attackT - dt * 3);
      const k = Math.sin((1 - e.attackT) * Math.PI); // out then back
      e.group.position.x += Math.sin(e.yaw) * 0.5 * k;
      e.group.position.z += Math.cos(e.yaw) * 0.5 * k;
      if (e.type === 'slime') e.group.position.y += 0.55 * k;       // pounce
      else e.group.rotation.x = -0.4 * k;                            // lean in to strike
    } else if (e.group.rotation.x) {
      e.group.rotation.x = 0;
    }
    if (e.flash > 0) { e.flash -= dt; e.group.scale.setScalar(1 + Math.max(0, e.flash) * 1.2); }
    drawMobStatus(e);
  }
}

// ---------------------------------------------------------------- ground loot
const groundItems = new Map();       // id -> { mesh, baseY, phase, x, y, z }
const requestedLoot = new Set();

function makeGroundSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(244,211,94,0.3)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#f4d35e';
  ctx.stroke();
  ctx.font = '34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('💰', 32, 34);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
  sprite.scale.set(0.9, 0.9, 0.9);
  return sprite;
}

function addGround(g) {
  if (!scene || groundItems.has(g.id)) return;
  const mesh = makeGroundSprite();
  mesh.position.set(g.x, g.y + 0.7, g.z);
  scene.add(mesh);
  groundItems.set(g.id, { mesh, baseY: g.y + 0.7, phase: Math.random() * 6.28,
    x: g.x, y: g.y, z: g.z });
}

function removeGround(id) {
  const e = groundItems.get(id);
  if (!e) return;
  scene.remove(e.mesh);
  e.mesh.material.map?.dispose();
  e.mesh.material.dispose();
  groundItems.delete(id);
  requestedLoot.delete(id);
}

function updateGround(t) {
  for (const [id, e] of groundItems) {
    e.mesh.position.y = e.baseY + Math.sin(t * 2.2 + e.phase) * 0.16;
    if (player && !player.dead && !requestedLoot.has(id)) {
      const dx = e.x - player.pos.x;
      const dy = e.y - (player.pos.y + 0.9);
      const dz = e.z - player.pos.z;
      if (dx * dx + dy * dy + dz * dz < 1.9 * 1.9) {
        requestedLoot.add(id);
        net.sendCollectGround(id);
      }
    }
  }
}

// ---------------------------------------------------------------- game loop
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = (now - last) / 1000;
  last = now;

  player.update(dt);
  if (player.inWater) swam = true;

  const radius = isTouchDevice() ? 3 : 5;
  world.update(player.pos.x, player.pos.z, radius, 2);

  updateMining(dt);   // raycasts from the first-person eye (before the camera pulls back)
  decayBlockDamage(now, dt); // idle blocks slowly heal their crack damage
  updateCracks();            // keep crack overlays on every damaged block
  updateAimUI();
  interpolateRemotes(dt);
  updateMobs(dt, now / 1000);
  updatePickups(now / 1000);
  updateGround(now / 1000);
  updateDayNight();
  updateThirdPerson(dt); // poses own avatar + moves camera back (render only)
  updateViewModel(dt);
  updateSkillBar(now);
  updateSprintUI();
  updateFloats(dt);
  minimap.draw(player, remotePlayers, mobEntities);

  // HUD vitals.
  ui.updateVitals(player);
  checkStarving();
  ui.checkAchievements({ ...currentStats, swam });

  // Death handling.
  ui.showDeath(player.dead);

  // Network sync (throttled).
  if (now - lastMoveSent > 80) {
    if (!lastMovePos || lastMovePos.distanceToSquared(player.pos) > 0.0004 ||
        Math.abs((lastMovePos.yaw ?? 0) - player.yaw) > 0.01) {
      net.sendMove(player);
      lastMovePos = player.pos.clone();
      lastMovePos.yaw = player.yaw;
      lastMoveSent = now;
    }
  }
  if (now - lastStatsSent > 3000) {
    net.sendStats(player.hunger);
    lastStatsSent = now;
  }

  renderer.render(scene, camera);
}

// Shortest signed angle difference (−PI..PI).
function angleDelta(target, current) {
  let d = (target - current) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function interpolateRemotes(dt) {
  const a = Math.min(1, dt * 10);
  const now = performance.now();
  for (const r of remotePlayers.values()) {
    r.group.position.lerp(r.target, a);

    if (r.dead) {
      // Lay the fallen player on the ground instead of standing frozen.
      r.group.rotation.set(-Math.PI / 2, r.yaw + Math.PI, 0);
      r.lastPos.copy(r.group.position);
      continue;
    }

    // The body turns to follow the look yaw, but lags slightly so the head
    // leads — turning your view visibly turns the head first.
    r.bodyYaw += angleDelta(r.yaw, r.bodyYaw) * Math.min(1, dt * 8);
    r.group.rotation.set(0, r.bodyYaw + Math.PI, 0);

    const moved = Math.hypot(
      r.group.position.x - r.lastPos.x, r.group.position.z - r.lastPos.z);
    const speed = moved / Math.max(dt, 1e-3);
    const moving = speed > 0.6;
    r.phase += dt * (moving ? 9 : 0);
    if (r.swing > 0) r.swing = Math.max(0, r.swing - dt * 3);
    animateCharacter(r.group.userData.parts,
      { phase: r.phase, moving, swing: r.swing, pitch: r.pitch || 0, headYaw: r.yaw - r.bodyYaw });
    if (r.painUntil && now > r.painUntil) { r.painUntil = 0; setPainFace(r.group, false); }
    r.lastPos.copy(r.group.position);
  }
}

function updateDayNight() {
  const serverNow = Date.now() + serverTimeOffset;
  const phase = (serverNow % dayLength) / dayLength; // 0..1
  // Daylight: peak at midday (phase 0.5-ish). Use a smooth curve.
  const sun = Math.sin(phase * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5; // 0 night..1 day
  const light = 0.25 + sun * 0.75;
  world.matOpaque.color.setScalar(light);
  world.matTransparent.color.setScalar(light);

  const day = new THREE.Color(0x88ccff);
  const night = new THREE.Color(0x0a0e1a);
  const sky = night.clone().lerp(day, sun);
  scene.background = sky;
  scene.fog.color = sky;
}
