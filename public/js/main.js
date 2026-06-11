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
import { Tutorial } from './tutorial.js';
import { addAccent } from './detail.js';
import { equippedWeapon, speedMultiplier, bodyArmorWeight, defaultEquipment, WEAPONS, blockReach, blockReachH } from './gear.js';
import { speedAttrMult, hungerMult, maxHealth, defaultProgress, classSkills, CLASSES, rangeMult } from './rpg.js';
import { MOB_TYPES } from './mobs.js';
import { SAFE_ZONES, inSafeZone } from './worldgen.js';
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
let tuning = { moveSpeedMult: 1, hungerDrainMult: 1, staminaDrainSec: 5, staminaRefillSec: 7, skillRangeMult: 1, skillCdMult: 1, dodgeCdMs: 1000 };
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
  net.on('authError', (msg) => {
    // A live session for this account is already playing elsewhere. Don't clear
    // the token or reload (that would just bounce against the same block) —
    // freeze this tab and let the player decide to take over.
    if (msg && msg.reason === 'duplicate') { showDuplicateSession(); return; }
    net.stop(); // bad/expired token — don't reconnect-loop; bounce to login
    localStorage.removeItem('vc_token');
    location.reload();
  });

  net.on('init', (msg) => {
    // A second `init` means we reconnected after a dropped/backgrounded socket.
    // The one-time setup below (World, Player, render loop) must not run twice —
    // reload to pull a clean, fully synced session from the server.
    if (world) { location.reload(); return; }
    reconnectNotice = false;
    selfId = msg.selfId;
    username = msg.username;
    dayLength = msg.dayLength;
    serverTimeOffset = msg.serverTime - Date.now();
    if (msg.musicUrl) audio.setMusicUrl(msg.musicUrl); // admin-uploaded background track

    world = new World(scene, msg.seed);
    world.loadEdits(msg.edits);
    minimap.world = world; // lets the minimap render the actual city layout
    scene.add(highlight);
    buildSafeZones();

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
    for (const c of msg.cracks || []) crackStages.set(`${c.x},${c.y},${c.z}`, c.stage); // in-progress breaks
    onlineCount = msg.players.length + 1;
    ui.setOnline(onlineCount);
    ui.addChat('', 'Welcome to MyCraft! Build, mine and explore together.', true);

    setupInput();
    tutorial.onClose = () => setGuideShield(false); // drop the shield when the guide is closed
    requestAnimationFrame(loop);

    // First-time players go to the character creator before they get going.
    // They're shielded (immune + invisible) while setting up / reading the guide.
    // `firstTime` is server-authoritative: the guide auto-shows once per account.
    myAppearance = msg.state?.appearance || null;
    guideFirstTime = !!msg.firstTime;
    if (!myAppearance) {
      setGuideShield(true);
      charEditor.open(null, myProgress.class, saveAppearance);
      ui.addChat('', 'Create your character & pick a class to get started — reopen via 🎒 Bag → Customise.', true);
    } else if (guideFirstTime) {
      setGuideShield(true);
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
  net.on('crack', (msg) => applyCrack(msg)); // shared block-break cracks
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
  net.on('music', (msg) => { audio.setMusicUrl(msg.url); refreshMusicBtn(); }); // admin changed the track
  net.on('canFly', (msg) => setCanFly(!!msg.value));
  net.on('spawnSet', (msg) => {
    ui.toast(`📍 Respawn point set here (${msg.x}, ${msg.y}, ${msg.z}).`);
    spawnPointSet = true;
    refreshSpawnBtn();
  });
  net.on('spawnDenied', () => ui.toast('🕊 You can only set your spawn inside a safe sanctuary (look for the green dome).'));
  net.on('playerShield', (msg) => { // a player started/stopped reading the guide
    const r = remotePlayers.get(msg.id);
    if (r) { r.shielded = !!msg.on; if (r.group) r.group.visible = !r.shielded; }
  });
  net.on('crafted', (msg) => {
    if (msg && msg.action === 'equip') { audio.play('place'); return; } // quiet weapon swap
    ui.toast('🛠 Crafted!'); audio.play('craft');
  });
  net.on('craftFail', () => ui.toast('Not enough cash or materials.'));
  net.on('levelup', (msg) => { ui.toast(`⭐ Level ${msg.level}!\n+2 attribute & +1 skill point — open 🎒 Bag`); audio.play('level'); });
  net.on('skillFx', (msg) => {
    remoteSkillEffect(msg.skill, msg.kind, new THREE.Vector3(msg.x, msg.y, msg.z), msg.id, msg.dur);
  });
  net.on('buff', (msg) => {
    if (msg.stat === 'speed') {
      myBuffSpeed = msg.value;
      recomputeDerived();
      clearTimeout(_buffTimer);
      _buffTimer = setTimeout(() => { myBuffSpeed = 1; recomputeDerived(); }, msg.duration);
      ui.toast(msg.value < 1 ? '🥶 Slowed!' : '💨 Speed boost!');
      // (The boost's surrounding aura is shown by the skill's own cast effect.)
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
    audio.play('pickup');
    lootPop(msg, msg.kind === 'medkit' ? '🩹' : '🍗', msg.kind === 'medkit' ? 0x7fe3a0 : 0xf4d35e);
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
    audio.play('coin');
    lootPop(msg, msg.cash ? '💰' : '🎒', 0xffd23f);
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
  net.on('shot', (msg) => { // another player's projectile, rendered so we see it fly
    renderShot(msg.kind, new THREE.Vector3(msg.ax, msg.ay, msg.az), new THREE.Vector3(msg.bx, msg.by, msg.bz));
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
  net.on('sessionReplaced', () => endSession());
  net.on('disconnect', () => {
    if (sessionEnded) { endSession(); return; }
    // Show the reconnecting notice once per outage, not on every backoff retry.
    if (!reconnectNotice) { reconnectNotice = true; ui.addChat('', 'Disconnected — reconnecting…', true); }
  });
  // A mobile tab that returns to the foreground may have had its socket closed
  // while suspended — re-establish it the moment we're visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') net.ensureConnected();
  });
}
let reconnectNotice = false;

// The server kicked us because the account signed in elsewhere: hard-stop this
// session so two devices can't appear to play at once.
let sessionEnded = false;
function endSession() {
  if (sessionEnded && document.getElementById('session-ended') && !document.getElementById('session-ended').classList.contains('hidden')) return;
  sessionEnded = true;
  net.stop(); // this session is over for good — don't auto-reconnect
  if (player) { player.input = { forward: 0, strafe: 0, jump: false, sprint: false }; }
  try { document.exitPointerLock?.(); } catch { /* ignore */ }
  const el = document.getElementById('session-ended');
  if (el) el.classList.remove('hidden');
}

// This (new) connection was rejected because the account is already playing on
// another device. We keep the token and offer a retry rather than reload-looping
// against the live session.
function showDuplicateSession() {
  sessionEnded = true;
  if (player) { player.input = { forward: 0, strafe: 0, jump: false, sprint: false }; }
  try { document.exitPointerLock?.(); } catch { /* ignore */ }
  const el = document.getElementById('session-ended');
  if (!el) return;
  const h = el.querySelector('h2');
  const p = el.querySelector('p');
  const btn = el.querySelector('#btn-session-reload');
  if (h) h.textContent = '🔒 Already playing elsewhere';
  if (p) p.textContent = 'This account is already active on another device. Only one '
    + 'session can run at a time. Close the other one, then retry here.';
  if (btn) btn.textContent = 'Retry';
  el.classList.remove('hidden');
}

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
    el.innerHTML = `<span class="sk-ico">${sk.icon}</span><span class="sk-key">${['Q', 'E', 'R'][slot]}</span>` +
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
  // Single-target skills (nukes) need a target id; thrown AoE skills need an
  // aimed landing point so the blast lands where you look, not at your feet.
  let target = null, tt = null, aim = null;
  if (sk.kind === 'nuke') {
    const t = findTarget({ reach: 36 * tuning.skillRangeMult, type: 'ranged', cat: sk.cat });
    if (t) { target = t.id; tt = t.kind; }
    castSkillEffect(sk, lvl, t);
  } else if (sk.kind === 'aoe' && sk.throw) {
    const land = throwLandingPoint(sk.throw * tuning.skillRangeMult, sk.cat);
    aim = { x: land.x, y: land.y, z: land.z };
    castSkillEffect(sk, lvl, { point: land });
  } else {
    castSkillEffect(sk, lvl, null);
  }
  ownSwing = 1;
  audio.play(sk.kind === 'heal' ? 'heal' : sk.kind === 'buff' ? 'skillBuff'
    : sk.cat === 'magic' ? 'skillMagic' : sk.cat === 'ranged' ? 'skillRanged' : 'skillMelee');
  net.sendSkill(slot, target, tt, aim);
}

// Where a thrown AoE skill should land: an enemy under the crosshair if there is
// one, otherwise the block being aimed at, otherwise a point at max range. The
// result is clamped to `maxR` so you can never throw further than the skill allows.
function throwLandingPoint(maxR, cat) {
  player.syncCamera();
  const eye = camera.position.clone();
  const dir = aimDirection();
  let point;
  const t = findTarget({ reach: maxR, type: 'ranged', cat });
  if (t && t.point) point = t.point.clone();
  else {
    const r = player.raycast();
    point = r ? new THREE.Vector3(r.hit.x + 0.5, r.hit.y + 0.5, r.hit.z + 0.5)
              : eye.clone().addScaledVector(dir, maxR);
  }
  const off = point.clone().sub(eye);
  if (off.length() > maxR) point = eye.clone().addScaledVector(off.normalize(), maxR);
  return point;
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

// A volley of arrows raining down across the AoE radius (archer's Volley).
function spawnFallingArrows(center, radius, color = 0xffcf66) {
  if (!scene) return;
  spawnRing(center.clone(), radius, color);
  const n = Math.round(10 + radius * 2);
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      if (!scene) return;
      const ang = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * radius;
      const x = center.x + Math.cos(ang) * rr, z = center.z + Math.sin(ang) * rr;
      const top = new THREE.Vector3(x, center.y + 11 + Math.random() * 3, z);
      const land = new THREE.Vector3(x, center.y + 0.15, z);
      shootArrow(top, new THREE.Vector3(0, -1, 0), { to: land, maxDist: 16, speed: 26 + Math.random() * 8, color });
    }, i * 45);
  }
}

// ---------------------------------------------------------------- skill FX
// A small library of distinctive, reusable effects. Each class's skills compose
// these into something recognisable (no shared look between classes).

// Generic transient mesh that fades+grows then disposes.
function fx(mesh, { life = 0.5, grow = 0, spin = 0, rise = 0, fade = true } = {}) {
  if (!scene) return;
  scene.add(mesh);
  let t = 0; const o0 = mesh.material.opacity ?? 1;
  const tick = () => {
    t += 0.016;
    const k = t / life;
    if (grow) mesh.scale.setScalar((mesh.userData.s0 || 1) * (1 + k * grow));
    if (spin) mesh.rotation.z += spin * 0.016;
    if (rise) mesh.position.y += rise * 0.016;
    if (fade) mesh.material.opacity = Math.max(0, o0 * (1 - k));
    if (t < life) requestAnimationFrame(tick);
    else { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  };
  requestAnimationFrame(tick);
}
const bmat = (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, side: THREE.DoubleSide, depthWrite: false });

// Soldier — Cleave: a whirling blade arc that sweeps all the way around you.
function slashArc(pos, radius) {
  for (let s = 0; s < 2; s++) {
    const arc = new THREE.Mesh(new THREE.RingGeometry(radius * 0.45, radius, 40, 1, 0, Math.PI * 0.7), bmat(0xeef3ff, 0.85));
    arc.rotation.x = -Math.PI / 2; arc.position.set(pos.x, pos.y + 0.6, pos.z);
    scene.add(arc);
    let t = 0; const dir = s ? -1 : 1, start = s ? Math.PI : 0;
    const tick = () => { t += 0.016; arc.rotation.z = start + dir * t * 14; arc.material.opacity = 0.85 * (1 - t / 0.45);
      arc.scale.setScalar(1 + t * 0.6);
      if (t < 0.45) requestAnimationFrame(tick); else { scene.remove(arc); arc.geometry.dispose(); arc.material.dispose(); } };
    requestAnimationFrame(tick);
  }
  for (let i = 0; i < 7; i++) spawnSpark(pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * radius, 0.6 + Math.random(), (Math.random() - 0.5) * radius)), 0xcfe0ff);
}

// Expanding concentric shock rings (Soldier War Cry cast burst).
function shockRings(pos, color) {
  for (let i = 0; i < 3; i++) setTimeout(() => {
    if (!scene) return;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.06, 8, 32), bmat(color, 0.8));
    ring.rotation.x = -Math.PI / 2; ring.position.set(pos.x, pos.y + 0.2, pos.z); ring.userData.s0 = 1;
    fx(ring, { life: 0.6, grow: 8 });
  }, i * 110);
}

// Mage — Frost Nova: a ring of ice spikes erupting from the ground + frost mist.
function iceNova(pos, radius) {
  spawnRing(pos.clone(), radius, 0x9fe8ff);
  const N = Math.round(10 + radius * 2);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, rr = radius * (0.5 + Math.random() * 0.5);
    const x = pos.x + Math.cos(a) * rr, z = pos.z + Math.sin(a) * rr;
    const h = 0.8 + Math.random() * 1.4;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.18, h, 5), bmat(0xbff0ff, 0.9));
    spike.position.set(x, pos.y - h, z); spike.rotation.y = Math.random() * 3;
    scene.add(spike);
    let t = 0; const targetY = pos.y + h * 0.4;
    const tick = () => { t += 0.016; const k = Math.min(1, t / 0.18);
      spike.position.y = (pos.y - h) + (targetY - (pos.y - h)) * k;
      if (t > 0.45) spike.material.opacity = Math.max(0, 0.9 * (1 - (t - 0.45) / 0.5));
      if (t < 0.95) requestAnimationFrame(tick); else { scene.remove(spike); spike.geometry.dispose(); spike.material.dispose(); } };
    requestAnimationFrame(tick);
  }
  const mist = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.9, 16, 12), bmat(0xcdeeff, 0.28));
  mist.position.set(pos.x, pos.y + 0.8, pos.z); mist.userData.s0 = 1; fx(mist, { life: 0.7, grow: 0.6 });
}

// A fiery / smoky explosion (Gunman Grenade, Artisan Bomb).
function explosion(pos, { core = 0xffb14d, ring = 0xffd27f, smoke = 0x554c44, big = true } = {}) {
  const ball = new THREE.Mesh(new THREE.SphereGeometry(big ? 0.5 : 0.35, 16, 12), bmat(core, 0.95));
  ball.position.copy(pos); ball.userData.s0 = 1; fx(ball, { life: 0.4, grow: big ? 6 : 4 });
  const r = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.08, 8, 28), bmat(ring, 0.8));
  r.rotation.x = -Math.PI / 2; r.position.copy(pos); r.userData.s0 = 1; fx(r, { life: 0.55, grow: big ? 9 : 6 });
  for (let i = 0; i < (big ? 14 : 9); i++) {
    const deb = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), bmat(i % 2 ? smoke : core, 0.9));
    deb.position.copy(pos);
    const v = new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 6 + 2, (Math.random() - 0.5) * 8);
    scene.add(deb); let t = 0;
    const tick = () => { t += 0.016; v.y -= 16 * 0.016; deb.position.addScaledVector(v, 0.016); deb.rotation.x += 0.2; deb.rotation.y += 0.2;
      deb.material.opacity = Math.max(0, 0.9 * (1 - t / 0.7));
      if (t < 0.7) requestAnimationFrame(tick); else { scene.remove(deb); deb.geometry.dispose(); deb.material.dispose(); } };
    requestAnimationFrame(tick);
  }
}

// Lob a small object from `from` up and over to `to`, then call onLand.
function lob(from, to, color, onLand) {
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), bmat(color, 1));
  const fuse = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), bmat(0xffd27f, 1)); fuse.position.y = 0.18; ball.add(fuse);
  ball.position.copy(from); scene.add(ball);
  let t = 0; const T = 0.5; const peak = Math.max(from.y, to.y) + 2.5;
  const tick = () => { t += 0.016; const k = Math.min(1, t / T);
    ball.position.x = from.x + (to.x - from.x) * k;
    ball.position.z = from.z + (to.z - from.z) * k;
    ball.position.y = (1 - k) * from.y + k * to.y + Math.sin(k * Math.PI) * (peak - Math.max(from.y, to.y));
    ball.rotation.x += 0.3; ball.rotation.z += 0.2;
    if (k < 1) requestAnimationFrame(tick);
    else { scene.remove(ball); ball.geometry.dispose(); ball.material.dispose(); onLand && onLand(); } };
  requestAnimationFrame(tick);
}

// Gunman — Headshot: a precise bright beam + muzzle flash + lock reticle + ping.
function gunBeam(from, to) {
  shootTracer(from.clone(), to.clone(), 0xfff2a0);
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), bmat(0xfff7c0, 0.95)); flash.position.copy(from); flash.userData.s0 = 1; fx(flash, { life: 0.18, grow: 2 });
  // lock reticle at the target
  const ret = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 24), bmat(0xff5a5a, 0.95));
  ret.position.copy(to); ret.lookAt(camera.position); ret.userData.s0 = 1.6;
  scene.add(ret); ret.scale.setScalar(1.6);
  let t = 0; const tick = () => { t += 0.016; ret.scale.setScalar(1.6 - t * 4); ret.material.opacity = Math.max(0, 0.95 * (1 - t / 0.25));
    if (t < 0.25) requestAnimationFrame(tick); else { scene.remove(ret); ret.geometry.dispose(); ret.material.dispose(); spawnBurst(to.clone(), 0xfff2a0); } };
  requestAnimationFrame(tick);
}

// Mage — Heal: a soft column of green light with rising motes + a halo.
function healColumn(pos, color = 0x8effb0) {
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 2.4, 16, 1, true), bmat(color, 0.4));
  col.position.set(pos.x, pos.y + 1.2, pos.z); col.userData.s0 = 1; fx(col, { life: 0.8, grow: 0.3 });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.05, 8, 24), bmat(0xeaffe0, 0.9)); halo.rotation.x = -Math.PI / 2; halo.position.set(pos.x, pos.y + 0.1, pos.z); halo.userData.s0 = 1; fx(halo, { life: 0.7, grow: 1.4 });
  for (let i = 0; i < 16; i++) setTimeout(() => {
    if (!scene) return;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), bmat(color, 0.95));
    m.position.set(pos.x + (Math.random() - 0.5) * 1.1, pos.y + Math.random() * 0.3, pos.z + (Math.random() - 0.5) * 1.1);
    scene.add(m); let t = 0;
    const tick = () => { t += 0.016; m.position.y += 0.03; m.material.opacity = Math.max(0, 0.95 * (1 - t / 0.7));
      if (t < 0.7) requestAnimationFrame(tick); else { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } };
    requestAnimationFrame(tick);
  }, i * 30);
}

// Artisan — Repair: orange mechanical sparks + spinning bolts (no magic glow).
function repairSparks(pos) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.04, 6, 6), bmat(0xc9c2b4, 0.9)); // hex "gear"
  ring.rotation.x = -Math.PI / 2; ring.position.set(pos.x, pos.y + 1.0, pos.z);
  scene.add(ring); let tr = 0;
  const spin = () => { tr += 0.016; ring.rotation.z += 0.25; ring.material.opacity = Math.max(0, 0.9 * (1 - tr / 0.8));
    if (tr < 0.8) requestAnimationFrame(spin); else { scene.remove(ring); ring.geometry.dispose(); ring.material.dispose(); } };
  requestAnimationFrame(spin);
  for (let i = 0; i < 22; i++) setTimeout(() => {
    if (!scene) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), bmat(Math.random() < 0.5 ? 0xffb24d : 0xfff0a0, 1));
    m.position.set(pos.x, pos.y + 0.9 + Math.random() * 0.4, pos.z);
    const v = new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 3, (Math.random() - 0.5) * 5);
    scene.add(m); let t = 0;
    const tick = () => { t += 0.016; v.y -= 14 * 0.016; m.position.addScaledVector(v, 0.016); m.material.opacity = Math.max(0, 1 - t / 0.45);
      if (t < 0.45) requestAnimationFrame(tick); else { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } };
    requestAnimationFrame(tick);
  }, i * 18);
}

// ---- sustained auras that follow a player (local or remote) for a duration ----
const activeAuras = []; // { group, until, update(now), follow() -> {x,y,z}|null }
function addAura(durationMs, group, update, follow) {
  if (!scene) return;
  follow = follow || (() => (player ? player.pos : null)); // defaults to the local player
  scene.add(group);
  activeAuras.push({ group, until: performance.now() + durationMs, update, follow });
}
function updateAuras(now) {
  for (let i = activeAuras.length - 1; i >= 0; i--) {
    const a = activeAuras[i];
    const p = a.follow();
    if (now > a.until || !p) { scene.remove(a.group); disposeGroup(a.group); activeAuras.splice(i, 1); continue; }
    a.group.position.set(p.x, p.y, p.z);
    a.update(now, a.group);
  }
}
// Position-getter for a remote player's avatar (used to follow them with auras).
function remoteFollow(id) {
  return () => { const r = remotePlayers.get(id); return r && r.group && r.group.visible ? r.group.position : null; };
}
// Soldier War Cry — a rotating golden guard sigil (two counter-spun rune rings).
function guardAura(durationMs, follow) {
  const g = new THREE.Group();
  for (const [r, dir] of [[0.7, 1], [0.95, -1]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.05, 6, 6), bmat(0xffcf5a, 0.75)); // hex
    ring.rotation.x = -Math.PI / 2; ring.userData.dir = dir; ring.position.y = 0.1 + (r - 0.7); g.add(ring);
  }
  addAura(durationMs, g, (now) => { for (const c of g.children) c.rotation.z = (now / 600) * c.userData.dir; }, follow);
}
// Soldier Charge — bright dash streaks trailing behind you.
function chargeTrail(durationMs, follow) {
  const g = new THREE.Group();
  for (let i = 0; i < 8; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.7), bmat(0xbfe3ff, 0.6)); s.userData.i = i; g.add(s); }
  addAura(durationMs, g, (now) => g.children.forEach((c, i) => {
    const a = (i / 8) * Math.PI * 2 + now / 200; c.position.set(Math.cos(a) * 0.45, 0.4 + Math.sin(now / 120 + i) * 0.4, Math.sin(a) * 0.45); c.rotation.y = a;
  }), follow);
}
// Archer Dodge — quick translucent after-images of a ring (agile blur).
function dodgeBlur(durationMs, follow) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.42, 20), bmat(0x9affc0, 0.5)); r.rotation.x = -Math.PI / 2; r.userData.i = i; g.add(r); }
  addAura(durationMs, g, (now) => g.children.forEach((c, i) => { c.position.y = 0.1 + ((now / 500 + i / 3) % 1) * 1.6; c.material.opacity = 0.5 * (1 - ((now / 500 + i / 3) % 1)); }), follow);
}
// Gunman Adrenaline — a throbbing red surge (heartbeat) with rising embers.
function adrenalineAura(durationMs, follow) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 12), bmat(0xff4d4d, 0.22)); core.position.y = 1; g.add(core);
  for (let i = 0; i < 6; i++) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), bmat(0xff9a4d, 0.9)); e.userData.a = (i / 6) * 6.28; g.add(e); }
  addAura(durationMs, g, (now) => {
    const beat = 0.85 + Math.abs(Math.sin(now / 180)) * 0.5; core.scale.setScalar(beat);
    g.children.forEach((c, i) => { if (i === 0) return; const a = c.userData.a + now / 250; c.position.set(Math.cos(a) * 0.55, 0.4 + ((now / 350 + c.userData.a) % 1) * 1.1, Math.sin(a) * 0.55); });
  }, follow);
}
// Artisan Fortify — a hexagonal shield dome that shimmers around you.
function hexShield(durationMs, follow) {
  const g = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1), new THREE.MeshBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.18, wireframe: true, depthWrite: false }));
  dome.position.y = 1; g.add(dome);
  const dome2 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 1), new THREE.MeshBasicMaterial({ color: 0xbfeaff, transparent: true, opacity: 0.1, depthWrite: false }));
  dome2.position.y = 1; g.add(dome2);
  addAura(durationMs, g, (now) => { dome.rotation.y = now / 1200; dome.rotation.x = now / 2400; const p = 1 + Math.sin(now / 200) * 0.04; dome.scale.setScalar(p); dome2.scale.setScalar(p); }, follow);
}

// Dispatch the LOCAL cast visual for a skill (caller has already validated it).
function castSkillEffect(sk, lvl, target) {
  const pos = player.pos.clone();
  const rad = (sk.radius || 4) + lvl * 0.4;
  const from = camera.position.clone().addScaledVector(aimDirection(), 0.8);
  const dir = (target && target.point) ? target.point.clone().sub(from) : aimDirection();
  // Thrown AoE skills land at the aimed point; other AoEs stay centred on you.
  const land = (target && target.point) ? target.point.clone() : pos.clone();
  switch (sk.id) {
    case 'cleave': slashArc(pos, rad); break;
    case 'warcry': shockRings(pos, 0xffcf5a); guardAura(sk.duration || 6000); break;
    case 'charge': chargeTrail(sk.duration || 3000); spawnBurst(pos.clone().add(new THREE.Vector3(0, 0.4, 0)), 0xbfe3ff); break;
    case 'powershot': shootArrow(from, dir, { to: target && target.point ? target.point.clone() : null, maxDist: 36 * tuning.skillRangeMult, speed: 40, power: true }); break;
    case 'volley': spawnFallingArrows(land, rad); break;
    case 'dodge': dodgeBlur(sk.duration || 2500); break;
    case 'headshot': gunBeam(from, target && target.point ? target.point.clone() : from.clone().addScaledVector(dir, 30)); break;
    case 'grenade': { const at = land.clone().add(new THREE.Vector3(0, 0.2, 0)); lob(from, at, 0x3a3a3a, () => explosion(at, { core: 0xffb14d, big: true })); break; }
    case 'adrenaline': adrenalineAura(sk.duration || 6000); break;
    case 'fireball': shootProjectile(from, aimDirection(), 0xff7a2a, { to: target && target.point ? target.point.clone() : null, size: 0.45, maxDist: 30, speed: 15 }); break;
    case 'frostnova': iceNova(pos, rad); break;
    case 'heal': healColumn(pos); break;
    case 'bomb': { const at = land.clone().add(new THREE.Vector3(0, 0.2, 0)); lob(from, at, 0x222222, () => explosion(at, { core: 0xff7a2a, smoke: 0x333028, big: true })); break; }
    case 'repair': repairSparks(pos); break;
    case 'fortify': hexShield(sk.duration || 8000); break;
    default:
      if (sk.kind === 'aoe') spawnRing(pos, rad, skillColor(sk));
      else if (sk.kind === 'heal') healColumn(pos);
  }
}

// Effect for ANOTHER player's cast (skillFx broadcast). AoE/heal play at their
// position; buffs attach a sustained aura that follows their avatar; nuke
// projectiles arrive via the separate 'shot' message (here just a muzzle flash).
function remoteSkillEffect(skillId, kind, pos, id, dur) {
  const up = (y) => pos.clone().add(new THREE.Vector3(0, y, 0));
  const follow = remoteFollow(id);
  switch (skillId) {
    case 'cleave': slashArc(pos, 3.5); break;
    case 'warcry': shockRings(pos, 0xffcf5a); guardAura(dur || 6000, follow); break;
    case 'charge': spawnBurst(up(0.5), 0xbfe3ff); chargeTrail(dur || 3000, follow); break;
    case 'volley': spawnFallingArrows(pos, 4.5); break;
    case 'dodge': dodgeBlur(dur || 2500, follow); break;
    case 'grenade': explosion(pos, { core: 0xffb14d, big: true }); break;
    case 'adrenaline': spawnBurst(up(1), 0xff5a3a); adrenalineAura(dur || 6000, follow); break;
    case 'frostnova': iceNova(pos, 5); break;
    case 'heal': healColumn(pos); break;
    case 'bomb': explosion(pos, { core: 0xff7a2a, big: true }); break;
    case 'repair': repairSparks(pos); break;
    case 'fortify': spawnRing(pos, 1.6, 0x6fd0ff); hexShield(dur || 8000, follow); break;
    case 'powershot': case 'headshot': case 'fireball': spawnBurst(up(1.4), skillId === 'fireball' ? 0xff7a2a : 0xfff2a0); break;
    default: if (kind === 'aoe') spawnRing(pos, 4, 0xffaa55); else spawnRing(up(1), 1.2, 0xffffff);
  }
}

// ---- safe sanctuaries: a calm green dome + ground ring + light column ----
const safeZoneMeshes = [];
function buildSafeZones() {
  if (!scene) return;
  for (const z of SAFE_ZONES) {
    const g = new THREE.Group();
    g.position.set(z.x, GROUND_Y, z.z);
    const ground = new THREE.Mesh(new THREE.RingGeometry(z.r - 0.4, z.r, 48), bmat(0x7fffc0, 0.5));
    ground.rotation.x = -Math.PI / 2; ground.position.y = 0.08; g.add(ground);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(z.r, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x8effc8, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    g.add(dome);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 6, 10, 1, true), bmat(0xaaffd6, 0.25));
    col.position.y = 3; g.add(col);
    g.userData.r = z.r;
    scene.add(g); safeZoneMeshes.push(g);
  }
}
function updateSafeZones(now) {
  for (const g of safeZoneMeshes) {
    g.rotation.y = now / 3000;
    const p = 1 + Math.sin(now / 500) * 0.02;
    g.children[0].scale.setScalar(p); // ground ring breathes
    g.children[0].material.opacity = 0.4 + Math.sin(now / 500) * 0.12;
  }
}
const GROUND_Y = 22; // street surface (matches worldgen GEN.GROUND)

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

// ---- new-player guide shield (immune + invisible while reading) ----
let guideShielded = false;
let guideFirstTime = false; // server says this account hasn't seen the guide yet
function setGuideShield(on) {
  guideShielded = !!on;
  if (net) net.sendGuide(guideShielded);
}
// Safety net: never stay shielded once the guide UI (char editor / tutorial) is
// gone — otherwise a player could be stuck immune and unable to act.
function dropShieldIfGuideClosed() {
  if (!guideShielded) return;
  const tut = document.getElementById('tutorial');
  const ch = document.getElementById('character');
  const tutOpen = tut && !tut.classList.contains('hidden');
  const chOpen = ch && !ch.classList.contains('hidden');
  if (!tutOpen && !chOpen) setGuideShield(false);
}

// HUD banner shown while protected (reading the guide) or inside a sanctuary.
function updateSafeHud() {
  const el = document.getElementById('safe-indicator');
  if (!el || !player) return;
  if (guideShielded) { el.textContent = '🛡 Reading the guide — you are hidden & protected'; el.classList.remove('hidden'); }
  else if (inSafeZone(player.pos.x, player.pos.z)) { el.textContent = '🕊 Safe sanctuary — no PvP or monsters · 📍 you can set your spawn here'; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
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
  // New players get the tour (server-authoritative, once per account). Otherwise
  // make sure we never leave the shield up — drop it now that the editor closed.
  if (firstTime && guideFirstTime) tutorial.open();
  else setGuideShield(false);
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
  group.visible = !p.shielded; // hidden while they read the guide
  scene.add(group);
  remotePlayers.set(p.id, {
    group, target: new THREE.Vector3(p.x, p.y, p.z), yaw: p.yaw || 0, pitch: p.pitch || 0,
    name: p.name, appearance: p.appearance, equipment: p.equipment,
    canFly: !!p.canFly, dead: !!p.dead, shielded: !!p.shielded, bodyYaw: p.yaw || 0, painUntil: 0,
    phase: 0, swing: 0, lastPos: new THREE.Vector3(p.x, p.y, p.z),
  });
}

// Rebuild a remote avatar when appearance/equipment/wings change (keep transform).
function rebuildRemoteAvatar(r) {
  const old = r.group;
  const group = makeAvatar(r.name, r.appearance, r.equipment, r.canFly);
  group.position.copy(old.position);
  group.rotation.y = old.rotation.y;
  group.visible = !r.shielded;
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
      onToggleFly: toggleFlight, onToggleLock: toggleLock, onDodge: tryDodge,
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
  document.getElementById('btn-session-reload')?.addEventListener('click', () => location.reload());
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
    // Right-click: build when a block is selected, otherwise dodge (melee).
    else if (e.button === 2) { if (ui.selectedBlock() != null) placeBlock(); else tryDodge(); }
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
    if (e.code === 'KeyC' && !chatOpen && !ui.anyMenuOpen()) { net.sendUseConsumable('medkit'); return; }
    if (e.code === 'KeyF' && !chatOpen && !ui.anyMenuOpen()) { net.sendUseConsumable('food'); return; }
    if (chatOpen || ui.anyMenuOpen()) return;
    // Class skills on Q/E/R — within easy reach of the WASD hand.
    if (e.code === 'KeyQ') { useSkillSlot(0); return; }
    if (e.code === 'KeyE') { useSkillSlot(1); return; }
    if (e.code === 'KeyR') { useSkillSlot(2); return; }
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
const mineState = { active: false, key: null, sendT: 0, swingT: 0 };
let ownSwing = 0;

// Break progress is authoritative on the SERVER and shared by all players: it
// streams 'crack' updates (stage 0..7, or -1 to clear). We just track the stage
// per block here for rendering.
const crackStages = new Map(); // "x,y,z" -> stage 0..7
function blockStageFrac(hit) {
  const st = crackStages.get(`${hit.x},${hit.y},${hit.z}`);
  return st === undefined ? 0 : (st + 1) / 8;
}

// Fire a visible shot at a block point (bow arrow / gun tracer / wand orb).
function shootAtBlock(w, point) {
  const from = camera.position.clone().addScaledVector(aimDirection(), 0.8);
  if (w.cat === 'magic') shootProjectile(from, aimDirection(), 0xc98bff, { to: point.clone(), size: 0.3, maxDist: 24, speed: 22 });
  else if (w.id === 'bow') shootArrow(from, point.clone().sub(from), { to: point.clone(), maxDist: 28, speed: 34 });
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
  const r = player.raycast(blockReach(w), blockReachH(w)); // mine/build only within the weapon's reach
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
    const from = camera.position.clone().addScaledVector(aimDirection(), 0.8);
    if (w.cat === 'magic') {
      shootProjectile(from, aimDirection(), 0xc98bff, { to: target.point.clone(), size: 0.3, maxDist: 24, speed: 18 });
    } else if (w.id === 'bow') {
      // A real arrow that flies to the target at a visible speed.
      shootArrow(from, target.point.clone().sub(from), { to: target.point.clone(), maxDist: w.reach * rangeMult(myProgress, w.cat), speed: 34 });
    } else if (w.cat === 'ranged') {
      shootTracer(camera.position.clone(), target.point, 0xffee88); // gun: fast bullet streak
    }
    return;
  }
  // No monster: weapon slot mines/shoots the block, a selected block builds.
  if (ui.selectedBlock() == null) {
    if (w.cat === 'melee') audio.play('swing');
    mineState.active = true;   // hold to mine (melee) or auto-fire at it (ranged)
    mineState.swingT = 0;      // swing/fire on the very next frame
    mineState.sendT = 0;       // and send the first mine tick immediately
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
  mineState.swingT -= dt;
  mineState.sendT -= dt;
  const r = player.raycast(blockReach(w), blockReachH(w)); // melee chips only adjacent blocks; ranged reaches further
  const t = r ? world.getBlock(r.hit.x, r.hit.y, r.hit.z) : B.AIR;
  const minable = r && t !== B.AIR && t !== B.BEDROCK;

  // Stream mining ticks to the server, which owns the break + cracks (shared by
  // all players). The bar shows the server's crack stage for the aimed block.
  if (minable && mineState.sendT <= 0) { mineState.sendT = 0.1; net.sendMine(r.hit.x, r.hit.y, r.hit.z); }

  if (ranged) {
    // Shooters fire on a cadence: at a block they shoot it; otherwise they still
    // throw a projectile out to their range that flies and fades — so the
    // wand/gun always "shoots" the same way, target or not.
    if (mineState.swingT <= 0) {
      mineState.swingT = 0.4;
      ownSwing = 1;
      audio.play(w.cat === 'magic' ? 'skillMagic' : 'skillRanged');
      if (minable) shootAtBlock(w, new THREE.Vector3(r.hit.x + 0.5, r.hit.y + 0.5, r.hit.z + 0.5));
      else throwShot(w);
    }
  } else if (minable && mineState.swingT <= 0) {
    ownSwing = 1; mineState.swingT = 0.45; // melee chop swing
  }
  setMineBar(minable ? blockStageFrac(r.hit) : 0);
}

// Throw a projectile in the aim direction with no target — it flies out to the
// weapon's range and fades (consistent with the on-target shot's look).
function throwShot(w) {
  const dir = aimDirection();
  const from = camera.position.clone().addScaledVector(dir, 0.8);
  const range = w.reach * rangeMult(myProgress, w.cat);
  if (w.cat === 'magic') shootProjectile(from, dir, 0xc98bff, { size: 0.3, maxDist: range, speed: 22 });
  else if (w.id === 'bow') shootArrow(from, dir, { maxDist: range, speed: 34 }); // flies out and drops at max range
  else shootTracer(camera.position.clone(), camera.position.clone().addScaledVector(dir, range), 0xffee88);
}

// Render a persistent crack overlay on EVERY damaged block, so the cracks stay
// visible whether or not you're currently aiming at the block. Overlays are
// removed when a block fully heals, breaks, or is otherwise gone.
function updateCracks() {
  if (!scene || !crackTextures) return;
  for (const [k, stage] of crackStages) {
    let mesh = crackOverlays.get(k);
    if (!mesh) {
      const [x, y, z] = k.split(',').map(Number);
      mesh = new THREE.Mesh(crackGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
      }));
      mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
      mesh.renderOrder = 2;
      scene.add(mesh);
      crackOverlays.set(k, mesh);
    }
    const tex = crackTextures[Math.min(crackTextures.length - 1, stage)];
    if (mesh.material.map !== tex) { mesh.material.map = tex; mesh.material.needsUpdate = true; }
  }
  // Drop overlays whose blocks no longer have a crack stage.
  for (const [k, mesh] of crackOverlays) {
    if (!crackStages.has(k)) { scene.remove(mesh); mesh.material.dispose(); crackOverlays.delete(k); }
  }
}

// Apply a server crack update: stage -1 clears the overlay (block broke or
// healed). On a break we play the break sound effect — but no text/notification.
function applyCrack(msg) {
  const k = `${msg.x},${msg.y},${msg.z}`;
  if (msg.stage < 0) {
    crackStages.delete(k);
    if (msg.broke && player) {
      const d = Math.hypot(msg.x + 0.5 - player.pos.x, msg.z + 0.5 - player.pos.z);
      if (d < 28) audio.play('break');
    }
  } else {
    crackStages.set(k, msg.stage);
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
  // Ranged/magic range extends with the relevant attribute (Dex/Int).
  const reach = w.reach * rangeMult(myProgress, w.cat);
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

// ---- target lock-on (mobile) ---------------------------------------------
// Toggle to keep the view pinned on a monster/player so you can move with the
// joystick (and attack/skill manually) while staying faced at the target.
let lockTarget = null;       // { id, kind } currently locked, or null
const LOCK_GRACE = 5;        // blocks of slack past weapon reach before the lock drops
function lockRange() {
  const w = equippedWeapon(myEquipment);
  return w.reach * rangeMult(myProgress, w.cat) + LOCK_GRACE;
}
function setLockBtn(on) { document.getElementById('btn-lock')?.classList.toggle('on', on); }
function clearLock() { lockTarget = null; setLockBtn(false); }
function toggleLock() {
  if (!player || player.dead) return;
  if (lockTarget) { clearLock(); ui.toast('🎯 Lock off'); return; }
  player.syncCamera(); // aim from the eye, not the pulled-back 3rd-person camera
  // Wide cone; range = current weapon's effective reach (+grace). cat 'melee'
  // stops findTarget re-applying the range multiplier we've already included.
  const t = findTarget({ reach: lockRange(), cat: 'melee', type: 'melee' });
  if (!t) { ui.toast('🎯 Aim at a monster or player, then tap to lock on'); return; }
  lockTarget = { id: t.id, kind: t.kind };
  setLockBtn(true);
  audio.play('skillBuff');
  ui.toast('🎯 Locked on — move freely; your view stays on the target');
}
// Each frame (before movement is resolved) point the view at the locked target,
// so joystick movement is relative to facing it. Drops the lock when the target
// is gone or moves beyond the equipped weapon's reach.
function updateLockOn() {
  if (!lockTarget) return;
  if (!player || player.dead) { clearLock(); return; }
  let tx, ty, tz;
  if (lockTarget.kind === 'mob') {
    const e = mobEntities.get(lockTarget.id);
    if (!e) { clearLock(); return; }
    const h = (MOB_TYPES[e.type] || MOB_TYPES.slime).height;
    tx = e.group.position.x; ty = e.group.position.y + h * 0.6; tz = e.group.position.z;
  } else {
    const r = remotePlayers.get(lockTarget.id);
    if (!r || !r.group) { clearLock(); return; }
    tx = r.group.position.x; ty = r.group.position.y + 1.0; tz = r.group.position.z;
  }
  const dx = tx - player.pos.x, dy = ty - (player.pos.y + 1.62), dz = tz - player.pos.z;
  const horiz = Math.hypot(dx, dz);
  if (Math.hypot(dx, dy, dz) > lockRange()) { clearLock(); ui.toast('🎯 Target out of range — lock released'); return; }
  player.yaw = Math.atan2(-dx, -dz);
  const lim = Math.PI / 2 - 0.01;
  player.pitch = Math.max(-lim, Math.min(lim, Math.atan2(dy, horiz)));
}

// ---- dodge / dash --------------------------------------------------------
// A quick evasive shift (boxer-style) in the movement-input direction, available
// to every player on an admin-tunable cooldown. The dash repositions you and the
// server grants brief i-frames, so it reliably evades an incoming hit.
let dodgeReady = 0;
function tryDodge() {
  if (!player || player.dead) return;
  const now = performance.now();
  if (now < dodgeReady) return;                            // on cooldown
  dodgeReady = now + (tuning.dodgeCdMs || 1000);
  clearLock(); // a dodge is a disengage — drop any target lock so it doesn't fight the dash
  // Direction from the joystick / WASD; with no input, lean straight back.
  const fwd = player.forwardDir();
  const rx = -fwd.z, rz = fwd.x;
  const f = player.input.forward, s = player.input.strafe;
  let dx, dz;
  if (Math.abs(f) > 0.05 || Math.abs(s) > 0.05) { dx = fwd.x * f + rx * s; dz = fwd.z * f + rz * s; }
  else { dx = -fwd.x; dz = -fwd.z; }
  player.startDash(dx, dz);
  net.sendDodge();  // ask the server for brief i-frames so the dash dodges the hit
  ownSwing = 1;
  audio.play('swing');
  dodgeBlur(260);   // quick green motion rings on the avatar
  dodgeFx();        // first-person whoosh (brief FOV punch)
}
function dodgeFx() {
  if (!camera) return;
  let t = 0;
  const tick = () => {
    t += 0.016;
    const k = Math.max(0, 1 - t / 0.26);
    camera.fov = 70 + 9 * k;
    camera.updateProjectionMatrix();
    if (t < 0.26) requestAnimationFrame(tick);
    else { camera.fov = 70; camera.updateProjectionMatrix(); }
  };
  requestAnimationFrame(tick);
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

// A real arrow that flies from `from` along `dir` at a visible speed and sticks
// where it lands (or fades at maxDist). `power` makes it bigger + glowing for
// the archer's Power Shot. Returns nothing.
const _zAxis = new THREE.Vector3(0, 0, 1);
function shootArrow(from, dir, { to = null, maxDist = 26, speed = 34, power = false, color = 0xe9d8a6 } = {}) {
  if (!scene) return;
  const d = dir.clone().normalize();
  const g = new THREE.Group();
  const sh = power ? 1.4 : 1;
  const mat = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: o != null, opacity: o == null ? 1 : o });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.035 * sh, 0.035 * sh, 0.7 * sh), mat(0x6b4f2a));
  g.add(shaft);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.07 * sh, 0.07 * sh, 0.16 * sh), mat(power ? 0xfff0a0 : 0xcfd6df));
  tip.position.z = 0.42 * sh; g.add(tip);
  for (const s of [-1, 1]) { // fletching
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12 * sh, 0.12 * sh), mat(power ? 0xffd34d : 0xdedede));
    f.position.set(s * 0.05 * sh, 0, -0.34 * sh); g.add(f);
  }
  if (power) { // radiant aura around a power shot
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 12), mat(0xffe066, 0.5));
    g.add(glow);
  }
  g.quaternion.setFromUnitVectors(_zAxis, d);
  g.position.copy(from);
  scene.add(g);
  let travelled = 0, lastT = performance.now();
  const step = () => {
    const now = performance.now(); const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    const adv = speed * dt; travelled += adv; g.position.addScaledVector(d, adv);
    if (power && Math.random() < 0.7) spawnSpark(g.position, 0xffe066); // glittering trail
    if (to && g.position.distanceTo(to) < 0.9) {
      spawnRing(to.clone(), power ? 2.0 : 1.0, power ? 0xffe066 : color);
      if (power) spawnBurst(to.clone(), 0xffe066);
      scene.remove(g); disposeGroup(g); return;
    }
    if (travelled >= maxDist) { fadeOutGroup(g); return; } // out of range: drop/fade
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Tiny fading spark (used for power-shot trail / bursts).
function spawnSpark(pos, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  m.position.copy(pos);
  scene.add(m);
  let t = 0;
  const tick = () => { t += 0.05; m.material.opacity = 0.9 * (1 - t / 0.4); m.scale.multiplyScalar(0.92);
    if (t < 0.4) requestAnimationFrame(tick); else { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } };
  requestAnimationFrame(tick);
}
function spawnBurst(pos, color) { for (let i = 0; i < 8; i++) spawnSpark(pos.clone().add(new THREE.Vector3((Math.random() - 0.5), Math.random() * 0.6, (Math.random() - 0.5))), color); }
function fadeOutGroup(g) {
  let t = 0;
  const tick = () => { t += 0.05; g.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity = 1 - t / 0.3; } });
    if (t < 0.3) requestAnimationFrame(tick); else { scene.remove(g); disposeGroup(g); } };
  requestAnimationFrame(tick);
}

// Render a projectile (from another player's attack/skill) flying from→to.
function renderShot(kind, from, to) {
  const dir = to.clone().sub(from); const dist = dir.length() + 2;
  switch (kind) {
    case 'arrow': shootArrow(from, dir, { to, maxDist: dist, speed: 34 }); break;
    case 'powerarrow': shootArrow(from, dir, { to, maxDist: dist, speed: 40, power: true }); break;
    case 'wandorb': shootProjectile(from, dir, 0xc98bff, { to, size: 0.3, maxDist: dist, speed: 18 }); break;
    case 'fireorb': shootProjectile(from, dir, 0xff7a2a, { to, size: 0.45, maxDist: dist, speed: 15 }); break;
    case 'gunbeam': gunBeam(from, to); break;
    case 'tracer': shootTracer(from, to, 0xffee88); break;
  }
}

// World-space aim direction from the camera (the way the player is pointing).
const _aimDir = new THREE.Vector3();
function aimDirection() { camera.getWorldDirection(_aimDir); return _aimDir.clone(); }


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
  const wEq = equippedWeapon(myEquipment);
  const r = player.raycast(blockReach(wEq), blockReachH(wEq)); // build within reach only
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
const requestedPickups = new Map(); // id -> next time (ms) we may re-ask to collect

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
  const now = performance.now();
  for (const [id, e] of pickups) {
    e.mesh.position.y = e.baseY + Math.sin(t * 3 + e.phase) * 0.18;
    if (!player || player.dead) continue;
    // Cylindrical proximity: a generous horizontal radius plus a tall vertical
    // tolerance so jumping over (or standing under) a floating pickup still
    // grabs it. The server allows up to 2.5 units (3D sphere) from its own
    // authoritative position, which can lag a fast/flying client — so we keep
    // re-asking on a short cooldown instead of giving up after one rejected try.
    const dx = e.x - player.pos.x;
    const dz = e.z - player.pos.z;
    const dy = e.y - player.pos.y; // pickup ground level vs. feet
    const near = dx * dx + dz * dz < 2.0 * 2.0 && dy > -1.6 && dy < 2.6;
    if (near && now >= (requestedPickups.get(id) || 0)) {
      requestedPickups.set(id, now + 150); // retry until the server confirms removal
      net.sendPickup(id);
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
// A quick pickup *effect* where a pickup / loot stash was collected — a sparkle
// burst plus a small icon that pops and fades right at the loot. No drifting
// text, so rapid looting never reads as a message blocking the player's view.
function lootPop(msg, icon, sparkColor) {
  if (!scene || !Number.isFinite(msg.x)) return;
  spawnBurst(new THREE.Vector3(msg.x, msg.y + 0.4, msg.z), sparkColor);
  const c = document.createElement('canvas'); c.width = c.height = 48;
  const g = c.getContext('2d');
  g.font = '34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(icon, 24, 26);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.position.set(msg.x, msg.y + 0.7, msg.z);
  sp.scale.set(0.5, 0.5, 0.5);
  scene.add(sp);
  let t = 0;
  const tick = () => {
    t += 0.05; const k = Math.min(1, t / 0.45);
    const s = 0.5 + k * 0.45; sp.scale.set(s, s, s);
    sp.position.y += 0.012; sp.material.opacity = 1 - k;
    if (t < 0.45) requestAnimationFrame(tick);
    else { scene.remove(sp); sp.material.map.dispose(); sp.material.dispose(); }
  };
  requestAnimationFrame(tick);
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
let bossId = null;
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
// The boss's health rides above its head (drawn like any mob's bar, just larger
// with a name) — no center-screen bar to block the view. We only track its id so
// we can play the win sting and the defeated banner.
function showBoss(mob) {
  audio.play('boss');
  bossId = mob.id;
  bossBanner('⚔️ ' + ((MOB_TYPES[mob.type] || {}).name || 'Boss') + ' has appeared!');
}
function hideBoss(victory) {
  if (bossId == null) return;
  bossId = null;
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
  // Health bar sprite above the mob. The boss gets a chunkier bar plus a name
  // plate so its status reads clearly while hovering above its head.
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 10;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(def.boss ? 2.8 : 1.2, def.boss ? 0.34 : 0.2, 1);
  sprite.position.y = H + (def.boss ? 0.5 : 0.35);
  g.add(sprite);
  if (def.boss) {
    const nc = document.createElement('canvas');
    nc.width = 256; nc.height = 48;
    const ng = nc.getContext('2d');
    ng.font = 'bold 30px sans-serif'; ng.textAlign = 'center'; ng.textBaseline = 'middle';
    ng.lineWidth = 6; ng.strokeStyle = 'rgba(0,0,0,0.85)'; ng.strokeText(def.name, 128, 24);
    ng.fillStyle = '#ffd0d0'; ng.fillText(def.name, 128, 24);
    const ns = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(nc), depthTest: false, transparent: true }));
    ns.scale.set(3.2, 0.6, 1);
    ns.position.y = H + 0.95;
    g.add(ns);
  }
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
const requestedLoot = new Map();     // id -> next time (ms) we may re-ask to collect

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
  const now = performance.now();
  for (const [id, e] of groundItems) {
    e.mesh.position.y = e.baseY + Math.sin(t * 2.2 + e.phase) * 0.16;
    if (!player || player.dead) continue;
    const dx = e.x - player.pos.x;
    const dy = e.y - (player.pos.y + 0.9);
    const dz = e.z - player.pos.z;
    // Re-ask on a short cooldown until the server confirms removal, so a single
    // rejected request (stale server-side position) doesn't abandon the loot.
    if (dx * dx + dy * dy + dz * dz < 2.1 * 2.1 && now >= (requestedLoot.get(id) || 0)) {
      requestedLoot.set(id, now + 150);
      net.sendCollectGround(id);
    }
  }
}

// ---------------------------------------------------------------- game loop
let last = performance.now();
function loop(now) {
  if (sessionEnded) return; // session taken over on another device: freeze the game
  requestAnimationFrame(loop);
  const dt = (now - last) / 1000;
  last = now;

  updateLockOn();   // pin the view on a locked target so movement is target-relative
  player.update(dt);
  if (player.inWater) swam = true;

  const radius = isTouchDevice() ? 3 : 5;
  world.update(player.pos.x, player.pos.z, radius, 2);

  updateMining(dt);   // raycasts from the first-person eye (before the camera pulls back)
  updateCracks();            // render the server's shared crack overlays
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
  updateAuras(now);
  updateSafeZones(now);
  updateSafeHud();
  dropShieldIfGuideClosed();
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
