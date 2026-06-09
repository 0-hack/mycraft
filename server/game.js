// Multiplayer game hub: tracks connected players, validates edits, runs the
// economy (collect materials → sell for cash), drops loot on death, hands out
// pickups, and persists everything. Returns a small controller the HTTP layer
// uses for admin actions.
import { WebSocketServer } from 'ws';
import { CONFIG } from './config.js';
import { verifyToken } from './auth.js';
import { stateQueries, groundQueries, userQueries } from './db.js';
import { getSettings, clientTuning } from './settings.js';
import { getAllEdits, setBlock, isSolidAt, getBlockType } from './world.js';
import { GEN, blockHardness, inSafeZone } from '../public/js/worldgen.js';
import {
  weaponStats, equippedWeapon, defenseOf, mitigate, upgradeCost,
  normalizeEquipment, defaultEquipment, classEquipment, WEAPONS, ARMOR, MAX_LEVEL, blockReach, blockReachH,
} from '../public/js/gear.js';
import {
  defaultProgress, normalizeProgress, addXp, maxHealth, damageMult,
  defenseBonus, attackCooldownMult, craftDiscount, nextXp, ATTRS, ATTR_CAP, CLASSES,
  classSkills, SKILL_CAP, critChance, CRIT_MULT, miningMult, rangeMult,
} from '../public/js/rpg.js';
import { MOB_TYPES, MOB_DROPS, pickMobType } from '../public/js/mobs.js';

// Blocks players are allowed to place (must match client BLOCKS palette,
// excluding air=0 and bedrock=1 and water=9 which are not placeable).
const PLACEABLE = new Set([2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
const SPAWN = { x: 8, y: 40, z: 8, yaw: 0, pitch: 0 };

// Weapon/armor stats come from the shared gear.js. Small slack added to the
// attacker's reach to tolerate latency between move updates.
const REACH_SLACK = 1.0;
// Player-vs-player damage is scaled down so duels last long enough to be decided
// by positioning and skill use rather than a single burst. PvE (mobs) is
// unaffected — this only touches damage dealt by one player to another.
const PVP_DMG_MULT = 0.6;
const ATTACK_COOLDOWN = 300;
const KILL_SCORE = 50;
// You can only be attacked by something on roughly your own level: fly/climb
// above this many blocks and grounded monsters/players can't reach you. Ground
// monsters also won't chase a target higher than this (they stay grounded).
const VERT_LIMIT = 3.0;
// How far above/below a monster a target can be before it gives up the chase
// (flying players quickly get out of reach).
const MAX_CHASE_DY = 4.0;

// Collectible pickups. medkit heals, food restores stamina (hunger).
const PICKUP_KINDS = {
  medkit: { heal: 8, hunger: 0 },
  food:   { heal: 2, hunger: 8 },
};
const PICKUP_GRAB = 2.5;
const LOOT_GRAB = 2.5;

function defaultState(userId) {
  return {
    user_id: userId,
    x: SPAWN.x, y: SPAWN.y, z: SPAWN.z, yaw: 0, pitch: 0,
    health: maxHealth(defaultProgress('soldier')), hunger: 20, xp: 0, level: 1, score: 0, cash: 0,
    blocks_mined: 0, blocks_placed: 0,
    inventory: JSON.stringify({}),
    achievements: JSON.stringify([]),
    appearance: null,
    equipment: JSON.stringify(defaultEquipment()),
    progress: JSON.stringify(defaultProgress('soldier')),
    consumables: JSON.stringify({}),
    spawn_x: null, spawn_y: null, spawn_z: null, // null = use default world spawn
    updated_at: Date.now(),
  };
}

// Resolve a player's respawn point: their saved custom spawn, or the city centre.
function respawnPoint(s) {
  if (Number.isFinite(s.spawn_x) && Number.isFinite(s.spawn_y) && Number.isFinite(s.spawn_z)) {
    return { x: s.spawn_x, y: s.spawn_y, z: s.spawn_z };
  }
  return { x: SPAWN.x, y: SPAWN.y, z: SPAWN.z };
}

// Live max health from the player's vitality.
function getMaxHp(s) { return maxHealth(safeParse(s.progress, null)); }

function loadState(userId) {
  const s = stateQueries.get.get(userId) || defaultState(userId);
  s.kills = s.kills || 0;
  s.cash = s.cash || 0;
  s.equipment = JSON.stringify(normalizeEquipment(safeParse(s.equipment, null)));
  s.progress = JSON.stringify(normalizeProgress(safeParse(s.progress, null)));
  s.consumables = JSON.stringify(safeParse(s.consumables, {}));
  if (s.spawn_x === undefined) { s.spawn_x = null; s.spawn_y = null; s.spawn_z = null; }
  if (s.health <= 0) s.health = getMaxHp(s); // never join already dead
  return s;
}

function saveState(state) {
  state.updated_at = Date.now();
  stateQueries.upsert.run(state);
}

export function attachGame(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Map(); // ws -> ctx
  const ground = new Map();  // id -> { id, x, y, z, cash, materials, owner_name, dropped_at }
  const mobs = new Map();    // id -> { id, type, x, y, z, yaw, health, maxHealth, target, lastAttack }
  // Authoritative block-break progress so cracks are shared by every player.
  const blockDamage = new Map(); // "x,y,z" -> { dmg, max, stage, t }
  const CRACK_STAGES = 8;
  const chatLog = [];        // recent chat for admin review (capped)
  let nextNetId = 1;
  let nextMobId = 1;

  // Load persisted loot back into memory.
  for (const row of groundQueries.all.all()) {
    ground.set(row.id, { ...row, materials: safeParse(row.materials, {}) });
  }

  function broadcast(obj, except) {
    const msg = JSON.stringify(obj);
    for (const [ws] of clients) {
      if (ws !== except && ws.readyState === 1) ws.send(msg);
    }
  }
  // Send only to players within `radius` blocks (horizontally) of (x,z). Used for
  // transient, local effects (e.g. block cracks) so we don't spam the whole
  // server with things only nearby players can see.
  function broadcastNear(x, z, radius, obj, except) {
    const r2 = radius * radius;
    const msg = JSON.stringify(obj);
    for (const [ws, c] of clients) {
      if (ws === except || ws.readyState !== 1) continue;
      const dx = c.state.x - x, dz = c.state.z - z;
      if (dx * dx + dz * dz <= r2) ws.send(msg);
    }
  }
  const CRACK_RADIUS = 48; // only players this close see a block's cracks
  // Tell everyone else to render a projectile flying from→to, so ranged/magic
  // attacks & skills are visible from other players' point of view.
  function broadcastShot(exceptWs, id, kind, a, b) {
    if (!kind) return;
    broadcast({ type: 'shot', id, kind, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z }, exceptWs);
  }
  function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function findByUserId(userId) {
    for (const c of clients.values()) if (c.user.id === userId) return c;
    return null;
  }
  function findByNetId(netId) {
    if (netId == null) return null;
    for (const c of clients.values()) if (c.netId === netId) return c;
    return null;
  }
  // Apply skill status effects (burn/slow/stun) onto a target's effects bag.
  function applyStatuses(effects, statuses, lvl, byNetId) {
    const now = Date.now();
    for (const st of statuses || []) {
      if (st.type === 'burn') effects.burn = { until: now + st.duration, mag: Math.round((st.mag || 3) * (1 + (lvl - 1) * 0.25)), by: byNetId, last: now };
      else if (st.type === 'slow') effects.slow = { until: now + st.duration, mag: st.mag || 0.4 };
      else if (st.type === 'stun') effects.stun = { until: now + st.duration };
    }
  }
  // Players take burn + slow (no stun, to avoid frustrating PvP lockouts).
  function applyPlayerStatus(ctx, statuses, lvl, byNetId) {
    for (const st of statuses || []) {
      if (st.type === 'burn') ctx.effects.burn = { until: Date.now() + st.duration, mag: Math.round((st.mag || 3) * (1 + (lvl - 1) * 0.25)), by: byNetId };
      else if (st.type === 'slow') send(ctx.ws, { type: 'buff', stat: 'speed', value: 1 - (st.mag || 0.4), duration: st.duration });
    }
  }

  // Whether a connected player may fly: admins always; everyone if wingsForAll;
  // otherwise only those individually granted wings by an admin.
  function computeCanFly(ctx) {
    if (getSettings().wingsForAll) return true;
    const u = userQueries.byId.get(ctx.user.id);
    return !!(u && (u.is_admin || u.can_fly));
  }
  // Recompute everyone's fly permission and push any changes (after a settings
  // or per-user grant change).
  function refreshFly() {
    for (const ctx of clients.values()) {
      const v = computeCanFly(ctx);
      ctx.canFly = v;
      send(ctx.ws, { type: 'canFly', value: v });
      broadcast({ type: 'playerFly', id: ctx.netId, value: v }, ctx.ws); // others render wings
    }
  }

  // Shielded = reading the new-player guide (immune + invisible). Protected =
  // shielded OR standing in a safe sanctuary; protected players can't be hurt or
  // targeted by anyone (players, monsters, the boss).
  function isShielded(ctx) { return !!ctx.shielded && (!ctx.shieldUntil || Date.now() < ctx.shieldUntil); }
  function isProtected(ctx) { return isShielded(ctx) || inSafeZone(ctx.state.x, ctx.state.z); }

  function roster() {
    return [...clients.values()].map((c) => ({
      id: c.netId, name: c.user.username,
      x: c.state.x, y: c.state.y, z: c.state.z,
      yaw: c.state.yaw, pitch: c.state.pitch,
      appearance: safeParse(c.state.appearance, null),
      equipment: normalizeEquipment(safeParse(c.state.equipment, null)),
      canFly: !!c.canFly, dead: !!c.dead, shielded: isShielded(c),
    }));
  }

  function groundPublic(g) {
    return { id: g.id, x: g.x, y: g.y, z: g.z, cash: g.cash,
      count: materialCount(g.materials), owner: g.owner_name };
  }
  function mobPublic(m) {
    return { id: m.id, type: m.type, x: m.x, y: m.y, z: m.z, yaw: m.yaw,
      health: m.health, maxHealth: m.maxHealth };
  }

  wss.on('connection', (ws) => {
    let ctx = null;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (ctx) ctx.lastSeen = Date.now(); // liveness for single-session checks

      if (!ctx) {
        if (msg.type !== 'auth') return ws.close();
        const payload = verifyToken(msg.token);
        if (!payload) return send(ws, { type: 'authError' }), ws.close();
        // Reject if the account was deleted or banned since the token was issued.
        const urow = userQueries.byId.get(payload.id);
        if (!urow || urow.banned) return send(ws, { type: 'authError' }), ws.close();
        // One session per account: reject this connection if the account is
        // already actively playing elsewhere. A session is "active" if it sent
        // anything in the last 25s; a stale (crashed/dropped) one is taken over.
        const existing = findByUserId(payload.id);
        if (existing) {
          const live = existing.ws.readyState === 1 && (Date.now() - (existing.lastSeen || 0) < 25000);
          if (live) { send(ws, { type: 'authError', reason: 'duplicate' }); return ws.close(4002, 'duplicate-session'); }
          // Stale session — take it over.
          existing.skipSave = true;
          send(existing.ws, { type: 'sessionReplaced' });
          clients.delete(existing.ws);
          broadcast({ type: 'playerLeave', id: existing.netId });
          try { existing.ws.close(4001, 'session-replaced'); } catch { /* ignore */ }
          const oldWs = existing.ws;
          setTimeout(() => { try { if (oldWs.readyState !== oldWs.CLOSED) oldWs.terminate(); } catch { /* ignore */ } }, 1500);
        }
        const state = loadState(payload.id);
        // Marina City has a flat street level (y=22); rescue any player whose
        // saved position predates the city (could be underground now) by
        // dropping them onto the street from the sky (spawn protection covers it).
        if (!(state.y > 23)) { state.x = SPAWN.x; state.y = SPAWN.y; state.z = SPAWN.z; }
        userQueries.touch.run(Date.now(), payload.id);
        ctx = {
          user: payload, state, ws, netId: nextNetId++,
          lastMove: 0, lastAttack: 0, dead: false, skipSave: false, lastSeen: Date.now(),
          muted: !!urow.muted, skillCd: {}, buffs: {}, effects: {}, lastChat: 0,
          invulnUntil: Date.now() + getSettings().spawnProtectSec * 1000, // spawn protection
        };
        ctx.canFly = computeCanFly(ctx);
        clients.set(ws, ctx);

        send(ws, {
          type: 'init',
          seed: CONFIG.WORLD_SEED,
          dayLength: CONFIG.DAY_LENGTH_MS,
          serverTime: Date.now(),
          selfId: ctx.netId,
          username: payload.username,
          firstTime: !urow.guide_seen, // show the new-player guide once per account
          isAdmin: !!userQueries.byId.get(payload.id)?.is_admin,
          state: publicState(state),
          prices: CONFIG.MATERIAL_PRICES,
          difficulty: getSettings().difficulty,
          tuning: clientTuning(),
          canFly: ctx.canFly,
          musicUrl: getSettings().musicUrl || '',
          edits: getAllEdits(),
          players: roster().filter((p) => p.id !== ctx.netId),
          pickups: [...pickups.values()],
          ground: [...ground.values()].map(groundPublic),
          mobs: [...mobs.values()].map(mobPublic),
          cracks: [...blockDamage].reduce((out, [key, e]) => {
            const [x, y, z] = key.split(',').map(Number);
            const dx = x - state.x, dz = z - state.z;
            if (dx * dx + dz * dz <= CRACK_RADIUS * CRACK_RADIUS) out.push({ x, y, z, stage: e.stage });
            return out;
          }, []),
        });
        broadcast({
          type: 'playerJoin',
          player: { id: ctx.netId, name: payload.username,
            x: state.x, y: state.y, z: state.z, yaw: state.yaw, pitch: state.pitch,
            appearance: safeParse(state.appearance, null),
            equipment: normalizeEquipment(safeParse(state.equipment, null)),
            canFly: !!ctx.canFly, dead: !!ctx.dead, shielded: isShielded(ctx) },
        }, ws);
        // Stock the surrounding map so there's always a supply to walk to —
        // top up toward the cap (bounded so a join can't spawn a huge burst).
        for (let i = 0; i < 16 && pickups.size < getSettings().pickupCap; i++) spawnPickup();
        return;
      }

      switch (msg.type) {
        case 'move': {
          const s = ctx.state;
          if ([msg.x, msg.y, msg.z].every(Number.isFinite)) {
            s.x = msg.x; s.y = msg.y; s.z = msg.z;
            s.yaw = msg.yaw || 0; s.pitch = msg.pitch || 0;
          }
          broadcast({ type: 'playerMove', id: ctx.netId,
            x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch }, ws);
          break;
        }
        case 'block': handleBlock(ctx, ws, msg); break;
        case 'mine': handleMine(ctx, ws, msg); break;
        case 'appearance': {
          const json = JSON.stringify(msg.appearance || {});
          if (json.length <= 2000) {
            ctx.state.appearance = json;
            broadcast({ type: 'playerAppearance', id: ctx.netId, appearance: msg.appearance }, ws);
          }
          break;
        }
        case 'sell': handleSell(ctx, ws); break;
        case 'collectGround': handleCollect(ctx, ws, msg); break;
        case 'stats': {
          if (Number.isFinite(msg.hunger)) ctx.state.hunger = clamp(msg.hunger, 0, 20);
          break;
        }
        case 'damage': {
          if (ctx.dead) break;
          let amt = Number(msg.amount);
          if (!Number.isFinite(amt) || amt <= 0) break;
          amt = Math.min(20, Math.ceil(amt));
          const cause = ['void', 'fall', 'starve'].includes(msg.cause) ? msg.cause : 'fall';
          applyDamage(ctx, amt, null, cause);
          break;
        }
        case 'attack': {
          if (ctx.dead) break;
          const now = Date.now();
          const prog = safeParse(ctx.state.progress, null);
          if (now - ctx.lastAttack < ATTACK_COOLDOWN * attackCooldownMult(prog)) break;
          ctx.lastAttack = now;
          const w = equippedWeapon(safeParse(ctx.state.equipment, null));
          // Let everyone else play the swing / fire animation — even inside a
          // sanctuary, so a player's swings are always visible to others.
          broadcast({ type: 'playerSwing', id: ctx.netId, cat: w.cat }, ws);
          // …but a sanctuary / shield is purely cosmetic here: no damage dealt.
          if (isProtected(ctx)) break;
          const s = ctx.state;
          const base = w.dmg * damageMult(prog, w.cat) * buffMult(ctx, 'dmg', 1);
          const rolled = critize(prog, base);
          const eyeY = s.y + 1.6; // shooter's eye
          const reach = w.reach * rangeMult(prog, w.cat); // ranged/magic range grows with dex/int
          const eye = { x: s.x, y: eyeY, z: s.z };
          const kind = shotKind(w);
          if (msg.targetType === 'mob') {
            const m = mobs.get(msg.target);
            if (!m) break;
            if (Math.abs(m.y - s.y) > VERT_LIMIT) break; // can't hit across a big height gap
            if (Math.hypot(m.x - s.x, m.y - s.y, m.z - s.z) > reach + REACH_SLACK) break;
            const mh = (MOB_TYPES[m.type] || MOB_TYPES.slime).height;
            if (losBlocked(s.x, eyeY, s.z, m.x, m.y + mh * 0.6, m.z)) break; // no hitting through walls
            broadcastShot(ws, ctx.netId, kind, eye, { x: m.x, y: m.y + mh * 0.6, z: m.z });
            hurtMob(m, Math.round(rolled.dmg), ctx, rolled.crit ? 'crit' : 'hit');
            break;
          }
          let target = null;
          for (const c of clients.values()) if (c.netId === msg.target) { target = c; break; }
          if (!target || target === ctx || target.dead) break;
          const ts = target.state;
          if (Math.abs(ts.y - s.y) > VERT_LIMIT) break; // only same-level players can be hit
          const dist = Math.hypot(ts.x - s.x, ts.y - s.y, ts.z - s.z);
          if (dist > reach + REACH_SLACK) break;
          broadcastShot(ws, ctx.netId, kind, eye, { x: ts.x, y: ts.y + 1.0, z: ts.z });
          if (losBlocked(s.x, eyeY, s.z, ts.x, ts.y + 1.0, ts.z)) break; // no hitting through walls
          const def = defenseOf(safeParse(ts.equipment, null)) + defenseBonus(safeParse(ts.progress, null)) + buffMult(target, 'def', 0);
          applyDamage(target, mitigate(rolled.dmg, def), ctx, 'combat', rolled.crit ? 'crit' : undefined);
          break;
        }
        case 'craft': handleCraft(ctx, ws, msg); break;
        case 'spendAttr': {
          const attr = msg.attr;
          if (!ATTRS.includes(attr)) break;
          const p = normalizeProgress(safeParse(ctx.state.progress, null));
          if (p.points <= 0 || p.attrs[attr] >= ATTR_CAP) break;
          p.points -= 1; p.attrs[attr] += 1;
          ctx.state.progress = JSON.stringify(p);
          if (attr === 'vit') { ctx.state.health = Math.min(maxHealth(p), ctx.state.health + 4); pushHealth(ctx); }
          send(ws, { type: 'stats', state: publicState(ctx.state) });
          break;
        }
        case 'setClass': {
          const cls = msg.cls;
          if (!CLASSES[cls]) break;
          const p = normalizeProgress(safeParse(ctx.state.progress, null));
          // Only choosable on a fresh character (no XP/points invested yet).
          if (!(p.level === 1 && p.points === 0 && p.xp === 0)) break;
          ctx.state.progress = JSON.stringify(defaultProgress(cls));
          ctx.state.health = maxHealth(safeParse(ctx.state.progress, null));
          // Hand out the class-appropriate loadout: favored weapon equipped,
          // plus a sword and an axe (the slot-1 quick-swap).
          const eq = normalizeEquipment(classEquipment(CLASSES[cls].favored));
          ctx.state.equipment = JSON.stringify(eq);
          pushHealth(ctx);
          send(ws, { type: 'stats', state: publicState(ctx.state) });
          broadcast({ type: 'playerEquipment', id: ctx.netId, equipment: eq }, ws);
          break;
        }
        case 'pickup': {
          if (ctx.dead) break;
          const p = pickups.get(msg.id);
          if (!p) break;
          const s = ctx.state;
          // Cylindrical reach: generous horizontal radius + tall vertical
          // tolerance, so walking or flying past (feet above/below the pickup)
          // still collects it.
          const dx = p.x - s.x, dy = p.y - s.y, dz = p.z - s.z;
          if (dx * dx + dz * dz > PICKUP_GRAB * PICKUP_GRAB || dy < -2.5 || dy > 3.5) break;
          const def = PICKUP_KINDS[p.kind] || PICKUP_KINDS.medkit;
          // Always bank pickups so the player decides when to use them — press Q
          // (medkit) / F (food) or the on-screen buttons to consume.
          const cons = safeParse(s.consumables, {});
          cons[p.kind] = (cons[p.kind] || 0) + 1;
          s.consumables = JSON.stringify(cons);
          pickups.delete(p.id);
          broadcast({ type: 'pickupRemove', id: p.id });
          send(ws, { type: 'pickupGot', kind: p.kind, heal: def.heal, hunger: def.hunger, stored: true, x: p.x, y: p.y, z: p.z });
          send(ws, { type: 'stats', state: publicState(s) });
          break;
        }
        case 'useConsumable': {
          if (ctx.dead) break;
          const kind = msg.kind;
          if (kind !== 'medkit' && kind !== 'food') break;
          const s = ctx.state;
          const cons = safeParse(s.consumables, {});
          if (!(cons[kind] > 0)) break;
          const mh = getMaxHp(s);
          if (kind === 'medkit' && s.health >= mh) break; // already full
          if (kind === 'food' && s.hunger >= 20) break;
          const def = PICKUP_KINDS[kind];
          cons[kind] -= 1; if (!cons[kind]) delete cons[kind];
          s.consumables = JSON.stringify(cons);
          if (def.heal) s.health = clamp(s.health + def.heal, 0, mh);
          if (def.hunger) s.hunger = clamp(s.hunger + def.hunger, 0, 20);
          pushHealth(ctx, { hunger: s.hunger });
          send(ws, { type: 'stats', state: publicState(s) });
          break;
        }
        case 'respawn': {
          const s = ctx.state;
          const sp = respawnPoint(s); // saved "Set spawn here" point, or city centre
          s.x = sp.x; s.y = sp.y; s.z = sp.z;
          s.health = getMaxHp(s); s.hunger = 20;
          ctx.dead = false;
          ctx.invulnUntil = Date.now() + getSettings().spawnProtectSec * 1000; // protection on respawn
          send(ws, { type: 'respawn', x: s.x, y: s.y, z: s.z });
          send(ws, { type: 'stats', state: publicState(s) });
          broadcast({ type: 'playerDead', id: ctx.netId, dead: false }, ws); // others stand them back up
          broadcast({ type: 'playerMove', id: ctx.netId, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch }, ws);
          break;
        }
        case 'setSpawn': {
          // You can only save your respawn point inside a safe sanctuary.
          if (ctx.dead) break;
          const s = ctx.state;
          if (![s.x, s.y, s.z].every(Number.isFinite)) break;
          if (!inSafeZone(s.x, s.z)) { send(ws, { type: 'spawnDenied' }); break; }
          s.spawn_x = s.x; s.spawn_y = s.y; s.spawn_z = s.z;
          saveState(s);
          send(ws, { type: 'spawnSet', x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z) });
          break;
        }
        case 'guide': {
          // While reading the new-player guide the player is shielded: immune to
          // damage and invisible/untargetable to others. Auto-expires for safety.
          const on = !!msg.open;
          ctx.shielded = on;
          ctx.shieldUntil = on ? Date.now() + 5 * 60 * 1000 : 0;
          if (!on) userQueries.setGuideSeen.run(ctx.user.id); // the guide has been shown — never auto-show again
          broadcast({ type: 'playerShield', id: ctx.netId, on }, ws);
          break;
        }
        case 'chat': {
          const text = String(msg.text || '').slice(0, 200).trim();
          if (!text) break;
          if (ctx.muted) { send(ws, { type: 'chat', name: '', text: 'You are muted.', system: true }); break; }
          const now = Date.now();
          if (now - ctx.lastChat < getSettings().chatMinIntervalMs) {
            send(ws, { type: 'chat', name: '', text: 'You are sending messages too fast.', system: true });
            break;
          }
          ctx.lastChat = now;
          chatLog.push({ ts: now, user: ctx.user.username, userId: ctx.user.id, text });
          if (chatLog.length > 200) chatLog.shift();
          broadcast({ type: 'chat', name: ctx.user.username, text });
          break;
        }
        case 'useSkill': handleSkill(ctx, ws, msg); break;
        case 'spendSkill': {
          const slot = msg.slot | 0;
          const p = normalizeProgress(safeParse(ctx.state.progress, null));
          const skill = classSkills(p.class)[slot];
          if (!skill) break;
          const cur = p.skills[skill.id] || 0;
          if (p.skillPoints <= 0 || cur >= SKILL_CAP) break;
          p.skillPoints -= 1; p.skills[skill.id] = cur + 1;
          ctx.state.progress = JSON.stringify(p);
          send(ws, { type: 'stats', state: publicState(ctx.state) });
          break;
        }
      }
    });

    ws.on('close', () => {
      if (ctx) {
        if (!ctx.skipSave) saveState(ctx.state);
        clients.delete(ws);
        broadcast({ type: 'playerLeave', id: ctx.netId });
      }
    });
  });

  // ---- block mining / placing + economy ----------------------------------
  function handleBlock(ctx, ws, msg) {
    const { action } = msg;
    const x = Math.round(msg.x), y = Math.round(msg.y), z = Math.round(msg.z);
    if (![x, y, z].every(Number.isFinite)) return;
    if (y < 1 || y > 63) return;
    if (ctx.dead) return;

    const s = ctx.state;
    // Breaking/placing is gated by the equipped weapon's reach, same as mining:
    // a tight horizontal limit plus a generous 3D cap (so you can dig down).
    const wEq = equippedWeapon(safeParse(s.equipment, null));
    if (Math.hypot(x + 0.5 - s.x, z + 0.5 - s.z) > blockReachH(wEq) + 1.0) return;
    if (Math.hypot(x + 0.5 - s.x, y + 0.5 - (s.y + 1.4), z + 0.5 - s.z) > blockReach(wEq) + 1.5) return;
    if (action === 'break') {
      setBlock(x, y, z, 0);
      s.blocks_mined += 1;
      const w = equippedWeapon(safeParse(s.equipment, null));
      s.score += 5 + (w.mine || 0);
      gainXp(ctx, 3);
      // Collect the mined block into the player's stash, capped per type so it
      // isn't an infinite supply — players must keep mining to keep building.
      const mt = msg.mt;
      if (CONFIG.MATERIAL_PRICES[mt]) {
        const cap = getSettings().brickCap;
        const inv = safeParse(s.inventory, {});
        inv[mt] = Math.min(cap, (inv[mt] || 0) + 1);
        s.inventory = JSON.stringify(inv);
      }
      broadcast({ type: 'block', x, y, z, t: 0 });
    } else if (action === 'place') {
      const t = msg.t;
      if (!PLACEABLE.has(t)) return;
      // Placing consumes one block of that type from the player's stash.
      const inv = safeParse(s.inventory, {});
      if (!(inv[t] > 0)) { send(ws, { type: 'placeDenied', x, y, z }); send(ws, { type: 'stats', state: publicState(s) }); return; }
      inv[t] -= 1; if (!inv[t]) delete inv[t];
      s.inventory = JSON.stringify(inv);
      setBlock(x, y, z, t);
      s.blocks_placed += 1;
      s.score += 1;
      gainXp(ctx, 1);
      broadcast({ type: 'block', x, y, z, t });
    } else return;
    send(ws, { type: 'stats', state: publicState(s) });
  }

  // Authoritative, shared block breaking. The client streams 'mine' ticks while
  // chipping a block; the server accumulates damage (rate = weapon power ×
  // strength), broadcasts crack stages so EVERY player sees them, and breaks the
  // block into the miner's inventory when it's worn through.
  function handleMine(ctx, ws, msg) {
    if (ctx.dead) return;
    const x = Math.round(msg.x), y = Math.round(msg.y), z = Math.round(msg.z);
    if (![x, y, z].every(Number.isFinite) || y < 1 || y > 63) return;
    const s = ctx.state;
    const w = equippedWeapon(safeParse(s.equipment, null));
    // Must be within the weapon's reach (small slack for latency / eye height).
    // Horizontal is the tight gate (melee = right next to the brick); the 3D cap
    // is generous so digging straight down still works.
    if (Math.hypot(x + 0.5 - s.x, z + 0.5 - s.z) > blockReachH(w) + 1.0) return;
    if (Math.hypot(x + 0.5 - s.x, y + 0.5 - (s.y + 1.4), z + 0.5 - s.z) > blockReach(w) + 1.5) return;
    const type = getBlockType(x, y, z);
    if (!isSolidAt(x, y, z) || type === 1 /* bedrock */) return;

    const rate = (1 + (w.mine || 0) * 0.4) * miningMult(safeParse(s.progress, null));
    const now = Date.now();
    const k = `${x},${y},${z}`;
    let e = blockDamage.get(k);
    const max = blockHardness(type);
    if (!e) { e = { dmg: 0, max, stage: 0, t: now }; blockDamage.set(k, e); }
    e.max = max;
    const dt = Math.min(0.25, (now - (ctx.lastMine || now)) / 1000);
    ctx.lastMine = now;
    e.dmg += rate * dt;
    e.t = now;

    if (e.dmg >= max) {
      blockDamage.delete(k);
      setBlock(x, y, z, 0);
      broadcast({ type: 'block', x, y, z, t: 0 }); // world edit: everyone (consistency)
      broadcastNear(x, z, CRACK_RADIUS, { type: 'crack', x, y, z, stage: -1, broke: true }); // clear overlay + play break SFX nearby
      s.blocks_mined += 1;
      s.score += 5 + (w.mine || 0);
      gainXp(ctx, 3);
      if (CONFIG.MATERIAL_PRICES[type]) {
        const cap = getSettings().brickCap;
        const inv = safeParse(s.inventory, {});
        inv[type] = Math.min(cap, (inv[type] || 0) + 1);
        s.inventory = JSON.stringify(inv);
      }
      send(ws, { type: 'stats', state: publicState(s) });
    } else {
      const stage = Math.min(CRACK_STAGES - 1, Math.floor((e.dmg / max) * CRACK_STAGES));
      if (stage !== e.stage) { e.stage = stage; broadcastNear(x, z, CRACK_RADIUS, { type: 'crack', x, y, z, stage }); }
    }
  }

  // Idle blocks slowly recover and their cracks fade (only nearby players care).
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of blockDamage) {
      if (now - e.t < 6000) continue;
      e.dmg -= e.max * 0.4;             // heal a chunk every tick once left alone
      const [x, y, z] = k.split(',').map(Number);
      if (e.dmg <= 0) {
        blockDamage.delete(k);
        broadcastNear(x, z, CRACK_RADIUS, { type: 'crack', x, y, z, stage: -1 });
      } else {
        const stage = Math.min(CRACK_STAGES - 1, Math.floor((e.dmg / e.max) * CRACK_STAGES));
        if (stage !== e.stage) {
          e.stage = stage;
          broadcastNear(x, z, CRACK_RADIUS, { type: 'crack', x, y, z, stage });
        }
      }
    }
  }, 1000);

  function handleSell(ctx, ws) {
    const s = ctx.state;
    const inv = safeParse(s.inventory, {});
    const mult = getSettings().sellMultiplier;
    let earned = 0;
    for (const [type, count] of Object.entries(inv)) {
      const price = CONFIG.MATERIAL_PRICES[type] || 0;
      earned += Math.floor(price * count * mult);
    }
    if (earned <= 0 && materialCount(inv) === 0) { send(ws, { type: 'sold', earned: 0, cash: s.cash }); return; }
    s.cash += earned;
    s.inventory = JSON.stringify({});
    send(ws, { type: 'sold', earned, cash: s.cash });
    send(ws, { type: 'stats', state: publicState(s) });
  }

  // Spend cash + raw materials (any types). Returns false if unaffordable.
  function spend(s, cost) {
    const inv = safeParse(s.inventory, {});
    let total = 0;
    for (const c of Object.values(inv)) total += c;
    if (s.cash < cost.cash || total < cost.materials) return false;
    s.cash -= cost.cash;
    let need = cost.materials;
    for (const k of Object.keys(inv)) {
      if (need <= 0) break;
      const take = Math.min(inv[k], need);
      inv[k] -= take; need -= take;
      if (!inv[k]) delete inv[k];
    }
    s.inventory = JSON.stringify(inv);
    return true;
  }

  function handleCraft(ctx, ws, msg) {
    if (ctx.dead) return;
    const s = ctx.state;
    const eq = normalizeEquipment(safeParse(s.equipment, null));
    const disc = craftDiscount(safeParse(s.progress, null)); // Artisan pays less
    const cost = (lvl) => {
      const c = upgradeCost(lvl);
      return { cash: Math.round(c.cash * (1 - disc)), materials: Math.ceil(c.materials * (1 - disc)) };
    };
    const { kind, action } = msg;

    if (kind === 'weapon') {
      const type = msg.item;
      if (!WEAPONS[type] || !WEAPONS[type].craftable) return;
      if (action === 'equip') {
        if (!eq.weapons[type]) return;
        eq.weapon = type;
      } else {
        const cur = eq.weapons[type] || 0;
        if (action === 'craft' && cur !== 0) return;
        if (action === 'upgrade' && cur === 0) return;
        if (cur >= MAX_LEVEL) return;
        if (!spend(s, cost(cur))) { send(ws, { type: 'craftFail' }); return; }
        eq.weapons[type] = cur + 1;
        if (action === 'craft') eq.weapon = type; // auto-equip newly crafted
      }
    } else if (kind === 'armor') {
      const slot = msg.slot;
      if (!ARMOR[slot]) return;
      const cur = eq[slot] || 0;
      if (cur >= MAX_LEVEL) return;
      if (!spend(s, cost(cur))) { send(ws, { type: 'craftFail' }); return; }
      eq[slot] = cur + 1;
    } else return;

    s.equipment = JSON.stringify(eq);
    send(ws, { type: 'crafted', action, kind });
    send(ws, { type: 'stats', state: publicState(s) });
    broadcast({ type: 'playerEquipment', id: ctx.netId, equipment: eq }, ws);
  }

  function handleCollect(ctx, ws, msg) {
    if (ctx.dead) return;
    const g = ground.get(msg.id);
    if (!g) return;
    const s = ctx.state;
    // Cylindrical reach (see pickups): walking/flying past should still grab it.
    const dx = g.x - s.x, dy = g.y - s.y, dz = g.z - s.z;
    if (dx * dx + dz * dz > LOOT_GRAB * LOOT_GRAB || dy < -2.5 || dy > 3.5) return;
    s.cash += g.cash;
    const inv = safeParse(s.inventory, {});
    for (const [type, count] of Object.entries(g.materials)) inv[type] = (inv[type] || 0) + count;
    s.inventory = JSON.stringify(inv);
    removeGround(g.id);
    send(ws, { type: 'looted', cash: g.cash, count: materialCount(g.materials), owner: g.owner_name, x: g.x, y: g.y, z: g.z });
    send(ws, { type: 'stats', state: publicState(s) });
  }

  // Award XP; on level-up grant attribute points and full-heal.
  function gainXp(ctx, amount) {
    const s = ctx.state;
    const p = normalizeProgress(safeParse(s.progress, null));
    const before = p.level;
    addXp(p, amount);
    s.progress = JSON.stringify(p);
    s.level = p.level; s.xp = p.xp; // keep legacy columns synced for the leaderboard
    if (p.level > before && !ctx.dead) {
      s.health = maxHealth(p);
      send(ctx.ws, { type: 'levelup', level: p.level, points: p.points });
      pushHealth(ctx);
    }
  }

  // ---- combat / death ----------------------------------------------------
  function pushHealth(ctx, extra = {}) {
    send(ctx.ws, { type: 'health', health: ctx.state.health, dead: ctx.dead, ...extra });
  }

  function buffMult(ctx, stat, fallback) {
    const b = ctx.buffs && ctx.buffs[stat];
    return (b && b.until > Date.now()) ? b.value : fallback;
  }
  const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  // Use an active class skill (server-authoritative cooldowns + effects).
  function handleSkill(ctx, ws, msg) {
    if (ctx.dead) return;
    const slot = msg.slot | 0;
    const p = normalizeProgress(safeParse(ctx.state.progress, null));
    const skill = classSkills(p.class)[slot];
    if (!skill) return;
    const lvl = p.skills[skill.id] || 0;
    if (lvl <= 0) return; // not learned
    // No offensive skills from a sanctuary / while shielded (self heal/buff ok).
    if ((skill.kind === 'nuke' || skill.kind === 'aoe') && isProtected(ctx)) return;
    const now = Date.now();
    const cfg = getSettings();
    if (now - (ctx.skillCd[skill.id] || 0) < skill.cd * cfg.skillCdMult) return;
    ctx.skillCd[skill.id] = now;
    const s = ctx.state;
    // Thrown AoE skills (grenade/bomb/volley) detonate at an aimed spot, not on
    // the caster. Clamp the requested point to the skill's throw range and block
    // throws straight through a wall, then centre the blast there.
    let center = { x: s.x, y: s.y, z: s.z };
    if (skill.kind === 'aoe' && skill.throw && msg.aim) {
      const maxR = skill.throw * cfg.skillRangeMult;
      let ax = Number(msg.aim.x), ay = Number(msg.aim.y), az = Number(msg.aim.z);
      if ([ax, ay, az].every(Number.isFinite)) {
        const dx = ax - s.x, dy = ay - s.y, dz = az - s.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > maxR && d > 0) { const k = maxR / d; ax = s.x + dx * k; ay = s.y + dy * k; az = s.z + dz * k; }
        if (!losBlocked(s.x, s.y + 1.6, s.z, ax, ay + 0.5, az)) center = { x: ax, y: ay, z: az };
      }
    }
    broadcast({ type: 'skillFx', id: ctx.netId, skill: skill.id, kind: skill.kind, dur: skill.duration || 0, x: center.x, y: center.y, z: center.z }, ws);
    const val = skill.base + lvl * skill.per;
    const nukeRange = 36 * cfg.skillRangeMult;

    const basePower = val * damageMult(p, skill.cat) * buffMult(ctx, 'dmg', 1) * cfg.skillDmgMult;
    if (skill.kind === 'nuke') {
      const r = critize(p, basePower); const fx = r.crit ? 'crit' : 'skill'; const power = Math.round(r.dmg);
      const eyeY = s.y + 1.6;
      const skKind = skill.id === 'powershot' ? 'powerarrow' : skill.id === 'headshot' ? 'gunbeam' : skill.id === 'fireball' ? 'fireorb' : null;
      if (msg.targetType === 'mob') {
        const m = mobs.get(msg.target);
        const mh = m ? (MOB_TYPES[m.type] || MOB_TYPES.slime).height : 1;
        if (m && Math.abs(m.y - s.y) <= VERT_LIMIT && dist3(s, m) <= nukeRange &&
            !losBlocked(s.x, eyeY, s.z, m.x, m.y + mh * 0.6, m.z)) {
          broadcastShot(ws, ctx.netId, skKind, { x: s.x, y: eyeY, z: s.z }, { x: m.x, y: m.y + mh * 0.6, z: m.z });
          applyStatuses(m.effects, skill.status, lvl, ctx.netId); hurtMob(m, power, ctx, fx);
        }
      } else {
        let t = null; for (const c of clients.values()) if (c.netId === msg.target) t = c;
        if (t && t !== ctx && !t.dead && Math.abs(t.state.y - s.y) <= VERT_LIMIT && dist3(s, t.state) <= nukeRange &&
            !losBlocked(s.x, eyeY, s.z, t.state.x, t.state.y + 1.0, t.state.z)) {
          broadcastShot(ws, ctx.netId, skKind, { x: s.x, y: eyeY, z: s.z }, { x: t.state.x, y: t.state.y + 1.0, z: t.state.z });
          const def = defenseOf(safeParse(t.state.equipment, null)) + defenseBonus(safeParse(t.state.progress, null)) + buffMult(t, 'def', 0);
          applyPlayerStatus(t, skill.status, lvl, ctx.netId);
          applyDamage(t, mitigate(power, def), ctx, 'combat', r.crit ? 'crit' : undefined);
        }
      }
    } else if (skill.kind === 'aoe') {
      const rad = (skill.radius + lvl * 0.4) * cfg.skillRangeMult;
      for (const m of [...mobs.values()]) if (dist3(center, m) <= rad) {
        const r = critize(p, basePower);
        applyStatuses(m.effects, skill.status, lvl, ctx.netId); hurtMob(m, Math.round(r.dmg), ctx, r.crit ? 'crit' : 'skill');
      }
      for (const c of clients.values()) {
        if (c === ctx || c.dead || dist3(center, c.state) > rad) continue;
        const r = critize(p, basePower);
        const def = defenseOf(safeParse(c.state.equipment, null)) + defenseBonus(safeParse(c.state.progress, null)) + buffMult(c, 'def', 0);
        applyPlayerStatus(c, skill.status, lvl, ctx.netId);
        applyDamage(c, mitigate(r.dmg, def), ctx, 'combat', r.crit ? 'crit' : undefined);
      }
    } else if (skill.kind === 'heal') {
      const before = s.health;
      s.health = Math.min(getMaxHp(s), s.health + Math.round(val));
      pushHealth(ctx, { heal: s.health - before });
      send(ws, { type: 'stats', state: publicState(s) });
    } else if (skill.kind === 'buff') {
      ctx.buffs[skill.buffStat] = { value: val, until: now + skill.duration };
      if (skill.buffStat === 'speed') send(ws, { type: 'buff', stat: 'speed', value: val, duration: skill.duration });
    }
  }

  function applyDamage(target, dmg, attacker, cause, fx) {
    const ts = target.state;
    if (target.dead || ts.health <= 0) return;
    // Spawn protection negates ALL damage (fall + attacks) for the window.
    if (target.invulnUntil && target.invulnUntil > Date.now()) return;
    // Reading the guide, or inside a safe sanctuary → immune.
    if (isProtected(target)) return;
    // PvP damage (player attacker, combat cause) is softened for fairer duels.
    if (attacker && attacker !== target && cause === 'combat') dmg = Math.max(1, Math.round(dmg * PVP_DMG_MULT));
    ts.health = Math.max(0, ts.health - dmg);
    target.dead = ts.health <= 0;
    pushHealth(target, { hit: true, by: attacker?.user.username, dmg: Math.round(dmg), fx });
    broadcast({ type: 'playerHurt', id: target.netId }, target.ws); // others show a pain face
    if (target.dead) handleDeath(target, attacker, cause);
  }

  // Roll a critical hit based on the attacker's dexterity.
  function critize(prog, dmg) {
    if (Math.random() < critChance(prog)) return { dmg: dmg * CRIT_MULT, crit: true };
    return { dmg, crit: false };
  }

  function handleDeath(target, attacker, cause) {
    broadcast({ type: 'playerDead', id: target.netId, dead: true }); // others lay the avatar down
    dropLoot(target);
    let text;
    if (attacker && attacker !== target) {
      attacker.state.kills = (attacker.state.kills || 0) + 1;
      attacker.state.score += KILL_SCORE;
      gainXp(attacker, 40);
      send(attacker.ws, { type: 'kill', victim: target.user.username, score: KILL_SCORE });
      send(attacker.ws, { type: 'stats', state: publicState(attacker.state) });
      text = `💀 ${target.user.username} was slain by ${attacker.user.username}`;
    } else if (cause === 'void' || cause === 'fall' || cause === 'starve' || cause === 'burning') {
      const how = cause === 'void' ? 'fell out of the world'
        : cause === 'fall' ? 'fell to their death'
        : cause === 'burning' ? 'burned to death' : 'starved to death';
      text = `💀 ${target.user.username} ${how}`;
    } else {
      text = `💀 ${target.user.username} was slain by ${cause || 'the world'}`;
    }
    broadcast({ type: 'chat', name: '', text, system: true });
  }

  // Create a loot bag on the ground that anyone alive can collect.
  function spawnGroundLoot(x, y, z, cash, materials, owner) {
    if (cash <= 0 && materialCount(materials) === 0) return;
    const dropped_at = Date.now();
    const info = groundQueries.insert.run(round1(x), round1(y), round1(z), cash,
      JSON.stringify(materials), owner, dropped_at);
    const g = { id: info.lastInsertRowid, x: round1(x), y: round1(y), z: round1(z),
      cash, materials, owner_name: owner, dropped_at };
    ground.set(g.id, g);
    broadcast({ type: 'groundItemSpawn', item: groundPublic(g) });
  }

  // Drop the player's wealth (cash + materials) on the spot, then zero it out.
  function dropLoot(target) {
    const s = target.state;
    spawnGroundLoot(s.x, s.y, s.z, s.cash, safeParse(s.inventory, {}), target.user.username);
    // Wealth is reset on death (kept: score/level/xp/achievements).
    s.cash = 0;
    s.inventory = JSON.stringify({});
  }

  function removeGround(id) {
    if (!ground.has(id)) return;
    ground.delete(id);
    groundQueries.delete.run(id);
    broadcast({ type: 'groundItemRemove', id });
  }

  // ---- pickups -----------------------------------------------------------
  const pickups = new Map();
  let nextPickupId = 1;

  // Find a reachable ground spot to drop a pickup, scattered across the whole
  // region players currently occupy (their bounding box + a wide margin) rather
  // than bunched around one player. Only accepts street / sidewalk / park / low
  // building floors with head-room — never deep water, never a tall rooftop — so
  // anything spawned is walkable-to on foot.
  function findScatterSpot(arr) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of arr) {
      const s = c.state;
      if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
      if (s.z < minZ) minZ = s.z; if (s.z > maxZ) maxZ = s.z;
    }
    const M = 60; // margin so pickups spread well beyond the players themselves
    minX -= M; maxX += M; minZ -= M; maxZ += M;
    for (let tries = 0; tries < 28; tries++) {
      const x = round1(minX + Math.random() * (maxX - minX));
      const z = round1(minZ + Math.random() * (maxZ - minZ));
      const y = mobFeetY(x, z, GEN.WORLD_HEIGHT);
      if (y < GEN.GROUND + 1 || y > GEN.GROUND + 5) continue; // skip water pits & tall roofs
      const bx = Math.floor(x), bz = Math.floor(z);
      if (getBlockType(bx, y - 1, bz) === 9) continue;        // standing on water
      if (isSolidAt(bx, y, bz) || isSolidAt(bx, y + 1, bz)) continue; // need head-room
      return { x, y, z };
    }
    return null;
  }

  function spawnPickup(forceKind, force = false) {
    const cfg = getSettings();
    const arr = [...clients.values()];
    if (!arr.length) return null;
    if (!force && pickups.size >= cfg.pickupCap) return null;
    const kinds = Object.keys(PICKUP_KINDS).filter((k) =>
      (k === 'medkit' && cfg.medkitEnabled) || (k === 'food' && cfg.foodEnabled));
    if (forceKind && PICKUP_KINDS[forceKind]) kinds.length = 0, kinds.push(forceKind);
    if (!kinds.length) return null;
    const kind = kinds[(Math.random() * kinds.length) | 0];
    let px, py, pz;
    const spot = findScatterSpot(arr);
    if (spot) {
      px = spot.x; py = spot.y; pz = spot.z;
    } else {
      // Fallback: drop near a random player, still grounded to the real surface.
      const anchor = arr[(Math.random() * arr.length) | 0].state;
      const ang = Math.random() * Math.PI * 2;
      const r = 6 + Math.random() * 14;
      px = round1(anchor.x + Math.cos(ang) * r);
      pz = round1(anchor.z + Math.sin(ang) * r);
      py = mobFeetY(px, pz, GEN.WORLD_HEIGHT);
    }
    const p = { id: nextPickupId++, kind, x: px, y: py, z: pz };
    pickups.set(p.id, p);
    broadcast({ type: 'pickupSpawn', pickup: p });
    return p;
  }

  // ---- monsters (PvE) ----------------------------------------------------
  function spawnMob(forceType, capBonus = 0, force = false) {
    const cfg = getSettings();
    if (!cfg.mobEnabled && !force) return null;
    // A forced (admin) deploy can anchor near any connected player, even a
    // momentarily dead one, and ignores the natural population cap below.
    const arr = force ? [...clients.values()] : [...clients.values()].filter((c) => !c.dead);
    // Population scales with the number of online players (and night surge).
    const cap = Math.min(cfg.mobCap, arr.length * cfg.mobPerPlayer) + capBonus;
    if (!arr.length) return null;
    if (!force && mobs.size >= cap) return null;
    const anchor = arr[(Math.random() * arr.length) | 0].state;
    const type = forceType && MOB_TYPES[forceType] ? forceType : pickMobType();
    const def = MOB_TYPES[type];
    const hp = Math.max(1, Math.round(def.hp * cfg.mobPower));
    // Pick an open spot near the anchor — retry a few times so monsters don't
    // spawn trapped inside a building.
    let sx, sz;
    for (let i = 0; i < 8; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 12 + Math.random() * 14;
      sx = round1(anchor.x + Math.cos(ang) * r);
      sz = round1(anchor.z + Math.sin(ang) * r);
      if (!mobBlocked(sx, sz, anchor.y)) break;
    }
    const m = { id: nextMobId++, type,
      x: sx, y: round1(anchor.y), z: sz,
      yaw: 0, health: hp, maxHealth: hp, target: null, lastAttack: 0, effects: {}, vy: 0 };
    mobs.set(m.id, m);
    broadcast({ type: 'mobSpawn', mob: mobPublic(m) });
    return m;
  }

  // Damage a mob; aggro it, and on death award XP + drop loot to the killer
  // (attacker may be null, e.g. damage-over-time from someone who left).
  function hurtMob(m, dmg, attacker, fx = 'hit') {
    if (!mobs.has(m.id)) return;
    m.health -= dmg;
    if (attacker) m.target = attacker.netId;
    if (m.health <= 0) {
      mobs.delete(m.id);
      broadcast({ type: 'mobDead', id: m.id, dmg, fx });
      const def = MOB_TYPES[m.type];
      if (attacker) {
        gainXp(attacker, def.xp);
        attacker.state.score += def.xp;
        send(attacker.ws, { type: 'stats', state: publicState(attacker.state) });
      }
      const mat = {}; mat[MOB_DROPS[(Math.random() * MOB_DROPS.length) | 0]] = 1 + (Math.random() * 3 | 0);
      spawnGroundLoot(m.x, m.y, m.z, def.cash, mat, def.name);
      if (def.boss) broadcast({ type: 'chat', name: '', text: `🏆 The ${def.name} was defeated${attacker ? ' by ' + attacker.user.username : ''}!`, system: true });
    } else {
      broadcast({ type: 'mobHit', id: m.id, health: m.health, dmg, fx });
    }
  }

  function playerLevel(ctx) { return normalizeProgress(safeParse(ctx.state.progress, null)).level; }

  function mobStatusCodes(m, now) {
    const e = m.effects, codes = [];
    if (e.burn && e.burn.until > now) codes.push('b');
    if (e.slow && e.slow.until > now) codes.push('s');
    if (e.stun && e.stun.until > now) codes.push('z');
    return codes.length ? codes : undefined;
  }

  // The boss's slam shatters player-built blocks in a vertical column around the
  // impact, so it can break open walls players hide behind.
  function smashBlocks(cx, cy, cz, radius) {
    const r = Math.ceil(radius);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        const bx = Math.floor(cx) + dx, bz = Math.floor(cz) + dz;
        // Break the walls just above the ground (never the street/ground fill).
        for (let by = Math.max(GEN.GROUND + 1, Math.floor(cy)); by <= Math.floor(cy) + 3; by++) {
          if (isSolidAt(bx, by, bz)) {
            setBlock(bx, by, bz, 0);
            broadcast({ type: 'block', x: bx, y: by, z: bz, t: 0 });
          }
        }
      }
    }
  }

  function mobTick(dt) {
    if (!mobs.size) return;
    const cfg = getSettings();
    const players = [...clients.values()].filter((c) => !c.dead);
    const moved = [];
    const now = Date.now();
    for (const m of mobs.values()) {
      const def = MOB_TYPES[m.type];
      mobGravity(m, dt); // every monster stays glued to the real ground surface
      // Passive monsters (e.g. slimes) never chase or attack — they just wander.
      if (def.passive) {
        wanderMob(m, dt);
        moved.push({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, st: mobStatusCodes(m, now) });
        continue;
      }
      // Keep the current target only while it's within leash range AND on
      // roughly our level — a player who flies/climbs out of reach is dropped
      // so monsters don't pointlessly chase someone in the air.
      let tgt = null;
      if (m.target != null) {
        const c = players.find((p) => p.netId === m.target);
        if (c && !isProtected(c) && Math.hypot(c.state.x - m.x, c.state.z - m.z) <= def.leash && Math.abs(c.state.y - m.y) <= MAX_CHASE_DY) tgt = c;
        else m.target = null;
      }
      if (!tgt) {
        let best = null, bd = def.aggro;
        for (const c of players) {
          // Strong monsters ignore low-level players unless provoked.
          if (def.minLevel && playerLevel(c) < def.minLevel) continue;
          if (isProtected(c)) continue; // can't see/target a sheltered or shielded player
          if (Math.abs(c.state.y - m.y) > MAX_CHASE_DY) continue; // can't reach a flyer — ignore
          const d = Math.hypot(c.state.x - m.x, c.state.z - m.z);
          if (d < bd) { bd = d; best = c; }
        }
        if (best) { tgt = best; m.target = best.netId; }
      }
      if (!tgt) {
        // Lost interest: wander, and despawn if everyone is far away.
        let near = Infinity;
        for (const c of players) near = Math.min(near, Math.hypot(c.state.x - m.x, c.state.z - m.z));
        if (near > 80) { mobs.delete(m.id); broadcast({ type: 'mobRemove', id: m.id }); continue; }
        wanderMob(m, dt);
        moved.push({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, st: mobStatusCodes(m, now) });
        continue;
      }
      // Frozen/stunned monsters can't move or attack.
      if (m.effects.stun && m.effects.stun.until > now) { moved.push({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, st: mobStatusCodes(m, now) }); continue; }

      // Boss: telegraphed ground-slam AoE that players must dodge out of.
      if (def.boss) {
        if (m.tele) {
          if (now >= m.tele.until) {                       // detonate
            const tl = m.tele; m.tele = null;
            broadcast({ type: 'bossSlam', x: tl.x, y: tl.y, z: tl.z, radius: tl.radius });
            smashBlocks(tl.x, tl.y, tl.z, Math.min(tl.radius, 4)); // boss breaks open walls
            for (const c of players) {
              if (c.dead) continue;
              if (Math.hypot(c.state.x - tl.x, c.state.z - tl.z) > tl.radius) continue;
              if (Math.abs(c.state.y - tl.y) > VERT_LIMIT) continue; // safe if hiding underground / well above
              const d = defenseOf(safeParse(c.state.equipment, null)) + defenseBonus(safeParse(c.state.progress, null)) + buffMult(c, 'def', 0);
              applyDamage(c, mitigate(tl.dmg, d), null, 'the ' + def.name + "'s slam");
            }
          } else {                                          // winding up: rooted
            m.yaw = Math.atan2(tgt.state.x - m.x, tgt.state.z - m.z);
            moved.push({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, st: mobStatusCodes(m, now) });
            continue;
          }
        } else if (now - (m.lastSlam || 0) > 6000) {        // start a new slam
          const radius = 5.5;
          // The slam lands at the boss's (surface) level, so players who dig
          // underground drop below it and are safe (vertical check on detonate).
          m.tele = { x: tgt.state.x, y: m.y, z: tgt.state.z, radius, until: now + 1500, dmg: def.dmg * 2.5 * cfg.mobPower };
          m.lastSlam = now;
          broadcast({ type: 'bossTelegraph', x: m.tele.x, y: m.tele.y, z: m.tele.z, radius, duration: 1500 });
        }
      }

      const slow = (m.effects.slow && m.effects.slow.until > now) ? m.effects.slow.mag : 0;
      const dx = tgt.state.x - m.x, dz = tgt.state.z - m.z;
      const dist = Math.hypot(dx, dz);
      m.yaw = Math.atan2(dx, dz);
      if (dist > def.reach * 0.8) {
        const step = Math.min(dist, def.speed * (1 - slow) * dt);
        const nx = round1(m.x + dx / (dist || 1) * step);
        const nz = round1(m.z + dz / (dist || 1) * step);
        // Monsters can't walk through player-built walls/bricks (axis-separated
        // so they can slide along them). The boss smashes through via its slam.
        if (!mobBlocked(nx, m.z, m.y)) m.x = nx;
        if (!mobBlocked(m.x, nz, m.y)) m.z = nz;
      }
      // Can only attack a target on roughly the same level (not one flying above).
      const dy = tgt.state.y - m.y;
      if (dist <= def.reach && Math.abs(dy) <= VERT_LIMIT && now - m.lastAttack > 1200) {
        m.lastAttack = now;
        broadcast({ type: 'mobAttack', id: m.id }); // play the lunge/swing on clients
        const def2 = defenseOf(safeParse(tgt.state.equipment, null)) + defenseBonus(safeParse(tgt.state.progress, null)) + buffMult(tgt, 'def', 0);
        applyDamage(tgt, mitigate(def.dmg * cfg.mobPower, def2), null, 'a ' + def.name);
      }
      moved.push({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, st: mobStatusCodes(m, now) });
    }
    if (moved.length) broadcast({ type: 'mobs', mobs: moved });
  }

  // Spawning surges at night (tied to the day/night cycle).
  function sunLevel() {
    const phase = (Date.now() % CONFIG.DAY_LENGTH_MS) / CONFIG.DAY_LENGTH_MS;
    return Math.sin(phase * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
  }
  let lastMob = 0;
  setInterval(() => {
    const cfg = getSettings();
    if (!cfg.mobEnabled) return;
    const night = sunLevel() < 0.35;
    const interval = cfg.mobIntervalMs * (night ? 0.5 : 1);
    const capBonus = night ? Math.ceil(cfg.mobCap * 0.6) : 0;
    if (Date.now() - lastMob >= interval) { if (spawnMob(undefined, capBonus)) lastMob = Date.now(); }
  }, 1000);
  setInterval(() => mobTick(0.15), 150);

  // A boss appears periodically for everyone to team up against.
  function spawnBoss() {
    if (!getSettings().mobEnabled) return;
    if (![...clients.values()].some((c) => !c.dead)) return;
    for (const m of mobs.values()) if (m.type === 'boss') return; // one at a time
    if (spawnMob('boss', 999)) {
      broadcast({ type: 'chat', name: '', text: `⚔️ A ${MOB_TYPES.boss.name} has appeared! Band together to bring it down!`, system: true });
    }
  }
  setInterval(spawnBoss, 5 * 60 * 1000);

  // Damage-over-time (burn) for mobs and players.
  setInterval(() => {
    const now = Date.now();
    for (const m of [...mobs.values()]) {
      const b = m.effects.burn;
      if (b && b.until > now) hurtMob(m, b.mag, findByNetId(b.by), 'burn');
      else if (b) delete m.effects.burn;
    }
    for (const ctx of clients.values()) {
      if (ctx.dead) continue;
      const b = ctx.effects.burn;
      if (b && b.until > now) applyDamage(ctx, b.mag, findByNetId(b.by), 'burning');
      else if (b) delete ctx.effects.burn;
    }
  }, 1000);

  // ---- periodic jobs -----------------------------------------------------
  let lastPickup = 0;
  setInterval(() => {
    const cfg = getSettings();
    if (Date.now() - lastPickup < cfg.pickupIntervalMs) return;
    // Top up a few at a time so a high cap refills the map quickly instead of
    // trickling one pickup every interval.
    let spawned = 0;
    for (let i = 0; i < 4 && pickups.size < cfg.pickupCap; i++) if (spawnPickup()) spawned++;
    if (spawned) lastPickup = Date.now();
  }, 1000);

  // Regen / starvation derived from hunger.
  setInterval(() => {
    for (const ctx of clients.values()) {
      if (ctx.dead) continue;
      const s = ctx.state;
      const mh = getMaxHp(s);
      let changed = false;
      // Safe sanctuary / portal zone: fully restore health & hunger so players
      // can recover by stepping inside.
      if (inSafeZone(s.x, s.z)) {
        if (s.health < mh) { s.health = mh; changed = true; }
        if (s.hunger < 20) { s.hunger = 20; changed = true; }
      } else if (s.hunger >= 16 && s.health < mh) { s.health = Math.min(mh, s.health + 1); changed = true; }
      else if (s.hunger === 0 && s.health > 1) { s.health = Math.max(1, s.health - 1); changed = true; }
      if (changed) pushHealth(ctx, { hunger: s.hunger });
    }
  }, 3000);

  // Despawn loot older than the configured lifetime.
  setInterval(() => {
    const cutoff = Date.now() - getSettings().dropLifetimeMs;
    for (const g of [...ground.values()]) if (g.dropped_at < cutoff) removeGround(g.id);
  }, 60 * 1000);

  // Purge inactive (non-admin, offline) accounts.
  setInterval(() => {
    const cutoff = Date.now() - getSettings().inactiveDays * 24 * 60 * 60 * 1000;
    for (const u of userQueries.inactiveBefore.all(cutoff)) {
      if (findByUserId(u.id)) continue; // currently online → active
      stateQueries.delete.run(u.id);
      userQueries.delete.run(u.id);
    }
  }, 60 * 60 * 1000);

  // Autosave + activity heartbeat.
  setInterval(() => {
    for (const ctx of clients.values()) {
      saveState(ctx.state);
      userQueries.touch.run(Date.now(), ctx.user.id);
    }
  }, CONFIG.AUTOSAVE_INTERVAL_MS);

  // ---- admin controller (used by the HTTP layer) -------------------------
  const controller = {
    wss,
    onlinePlayers() {
      return [...clients.values()].map((c) => ({
        userId: c.user.id, username: c.user.username, netId: c.netId,
        x: Math.round(c.state.x), y: Math.round(c.state.y), z: Math.round(c.state.z),
        health: c.state.health, cash: c.state.cash, dead: c.dead,
      }));
    },
    groundItems() { return [...ground.values()].map(groundPublic); },
    mobList() { return [...mobs.values()].map(mobPublic); },
    deploy(kind, n = 1) {
      let made = 0;
      for (let i = 0; i < n; i++) {
        let r;
        // Admin deploys force through the enable toggles and population caps;
        // they only need a player online to anchor near.
        if (kind === 'boss') r = spawnMob('boss', 999, true);
        else if (kind === 'mob' || MOB_TYPES[kind]) r = spawnMob(MOB_TYPES[kind] ? kind : undefined, 0, true);
        else r = spawnPickup(kind, true);
        if (r) made++;
      }
      return made;
    },
    // Reset a user's progress to a fresh state (online or offline).
    resetUser(userId) {
      const fresh = defaultState(userId);
      const c = findByUserId(userId);
      if (c) {
        Object.assign(c.state, { ...fresh, kills: 0 });
        c.dead = false;
        saveState(c.state);
        send(c.ws, { type: 'respawn', x: SPAWN.x, y: SPAWN.y, z: SPAWN.z });
        send(c.ws, { type: 'stats', state: publicState(c.state) });
        pushHealth(c);
      } else {
        saveState(fresh);
      }
    },
    // Remove a user entirely; disconnect them if online.
    deleteUser(userId) {
      const c = findByUserId(userId);
      if (c) { c.skipSave = true; send(c.ws, { type: 'authError' }); c.ws.close(); clients.delete(c.ws); }
      stateQueries.delete.run(userId);
      userQueries.delete.run(userId);
    },
    recentChat() { return chatLog.slice(-120); },
    broadcastTuning() { broadcast({ type: 'tuning', tuning: clientTuning() }); },
    broadcastMusic(url) { broadcast({ type: 'music', url: url || '' }); },
    refreshFly() { refreshFly(); },
    setWings(userId, on) {
      userQueries.setWings.run(on ? 1 : 0, userId);
      const c = findByUserId(userId);
      if (c) {
        c.canFly = computeCanFly(c);
        send(c.ws, { type: 'canFly', value: c.canFly });
        broadcast({ type: 'playerFly', id: c.netId, value: c.canFly }, c.ws);
      }
    },
    setBanned(userId, banned) {
      userQueries.setBanned.run(banned ? 1 : 0, userId);
      if (banned) { const c = findByUserId(userId); if (c) { c.skipSave = true; send(c.ws, { type: 'authError' }); c.ws.close(); clients.delete(c.ws); } }
    },
    setMuted(userId, muted) {
      userQueries.setMuted.run(muted ? 1 : 0, userId);
      const c = findByUserId(userId);
      if (c) { c.muted = !!muted; send(c.ws, { type: 'chat', name: '', text: muted ? 'You have been muted by an admin.' : 'You have been unmuted.', system: true }); }
    },
  };

  return controller;
}

function publicState(s) {
  const prog = normalizeProgress(safeParse(s.progress, null));
  return {
    x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch,
    health: s.health, hunger: s.hunger, xp: prog.xp, level: prog.level,
    score: s.score, cash: s.cash || 0, blocksMined: s.blocks_mined, blocksPlaced: s.blocks_placed,
    kills: s.kills || 0, nextLevelXp: nextXp(prog),
    inventory: safeParse(s.inventory, {}),
    achievements: safeParse(s.achievements, []),
    appearance: safeParse(s.appearance, null),
    equipment: normalizeEquipment(safeParse(s.equipment, null)),
    progress: prog,
    maxHealth: maxHealth(prog),
    consumables: safeParse(s.consumables, {}),
    spawnSet: Number.isFinite(s.spawn_x),
  };
}

function materialCount(materials) {
  let n = 0;
  for (const c of Object.values(materials || {})) n += c;
  return n;
}

function safeParse(str, fallback) {
  if (typeof str !== 'string') return str || fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// What projectile a basic attack with this weapon looks like (null = melee).
function shotKind(w) {
  if (w.id === 'bow') return 'arrow';
  if (w.cat === 'magic') return 'wandorb';
  if (w.cat === 'ranged') return 'tracer';
  return null;
}

// Is the line from (ax,ay,az) to (bx,by,bz) blocked by a solid block before it
// reaches the target's cell? Used so players can't shoot/hit through walls.
function losBlocked(ax, ay, az, bx, by, bz) {
  const dirx = bx - ax, diry = by - ay, dirz = bz - az;
  const len = Math.hypot(dirx, diry, dirz);
  if (len < 0.001) return false;
  const dx = dirx / len, dy = diry / len, dz = dirz / len;
  let x = Math.floor(ax), y = Math.floor(ay), z = Math.floor(az);
  const tgX = Math.floor(bx), tgY = Math.floor(by), tgZ = Math.floor(bz);
  const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
  const tDX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDZ = dz === 0 ? Infinity : Math.abs(1 / dz);
  let tMX = dx === 0 ? Infinity : ((stepX > 0 ? x + 1 - ax : ax - x) * tDX);
  let tMY = dy === 0 ? Infinity : ((stepY > 0 ? y + 1 - ay : ay - y) * tDY);
  let tMZ = dz === 0 ? Infinity : ((stepZ > 0 ? z + 1 - az : az - z) * tDZ);
  let guard = 0;
  while (guard++ < 256) {
    if (tMX < tMY && tMX < tMZ) { x += stepX; if (tMX > len) return false; tMX += tDX; }
    else if (tMY < tMZ) { y += stepY; if (tMY > len) return false; tMY += tDY; }
    else { z += stepZ; if (tMZ > len) return false; tMZ += tDZ; }
    if (x === tgX && y === tgY && z === tgZ) return false;
    if (isSolidAt(x, y, z)) return true;
  }
  return false;
}

// Whether something solid (a procedural building/wall or a player-placed block)
// blocks a monster standing at (x,z). Checks the two body cells just above the
// surface the mob stands on, so walls of any reasonable height stop them.
function mobBlocked(x, z, y) {
  if (inSafeZone(x, z)) return true; // monsters (and the boss) cannot enter sanctuaries
  const bx = Math.floor(x), bz = Math.floor(z);
  const by = Math.round(y); // standing level (feet rest on the block below this)
  return isSolidAt(bx, by, bz) || isSolidAt(bx, by + 1, bz);
}

// The surface a mob at (x,z) should rest its feet on: scan downward starting
// from the block directly BELOW its feet (never above), so a mob can't "climb"
// a wall it's standing against — it only finds the ground holding it up. Using
// the real terrain keeps monsters glued to streets/lobbies, never floating
// after a flying player.
function mobFeetY(x, z, fromY) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let y = Math.ceil(fromY) - 1; y >= 1; y--) {
    if (isSolidAt(bx, y, bz)) return y + 1; // stand on top of the first solid below
  }
  return GEN.GROUND + 1;
}

// Monsters obey gravity: they fall to the surface beneath them and never hover
// in the air (so they can't levitate after a flyer) and never climb walls.
const MOB_GRAVITY = 26;
function mobGravity(m, dt) {
  const gy = mobFeetY(m.x, m.z, m.y);
  if (m.y > gy) {                    // above the ground: fall
    m.vy = (m.vy || 0) - MOB_GRAVITY * dt;
    m.y = round1(m.y + m.vy * dt);
    if (m.y <= gy) { m.y = gy; m.vy = 0; }
  } else {                           // on/at the ground: snap to it (no climbing)
    m.y = gy; m.vy = 0;
  }
}

// Idle drifting for passive / de-aggroed monsters so they feel alive.
function wanderMob(m, dt) {
  const now = Date.now();
  if (!m.wUntil || now > m.wUntil) {
    m.wYaw = Math.random() * Math.PI * 2;
    m.wMove = Math.random() < 0.5;
    m.wUntil = now + 2000 + Math.random() * 3000;
  }
  if (m.wMove) {
    const sp = 0.7;
    const nx = round1(m.x + Math.sin(m.wYaw) * sp * dt);
    const nz = round1(m.z + Math.cos(m.wYaw) * sp * dt);
    if (!mobBlocked(nx, m.z, m.y)) m.x = nx;
    else m.wUntil = 0; // hit a wall: pick a new heading next tick
    if (!mobBlocked(m.x, nz, m.y)) m.z = nz;
    else m.wUntil = 0;
    m.yaw = m.wYaw;
  }
}

function round1(v) { return Math.round(v * 10) / 10; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
