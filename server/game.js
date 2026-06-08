// Multiplayer game hub: tracks connected players, validates edits, runs the
// economy (collect materials → sell for cash), drops loot on death, hands out
// pickups, and persists everything. Returns a small controller the HTTP layer
// uses for admin actions.
import { WebSocketServer } from 'ws';
import { CONFIG } from './config.js';
import { verifyToken } from './auth.js';
import { stateQueries, groundQueries, userQueries } from './db.js';
import { getSettings, clientTuning } from './settings.js';
import { getAllEdits, setBlock } from './world.js';
import {
  weaponStats, equippedWeapon, defenseOf, mitigate, upgradeCost,
  normalizeEquipment, defaultEquipment, classEquipment, WEAPONS, ARMOR, MAX_LEVEL,
} from '../public/js/gear.js';
import {
  defaultProgress, normalizeProgress, addXp, maxHealth, damageMult,
  defenseBonus, attackCooldownMult, craftDiscount, nextXp, ATTRS, ATTR_CAP, CLASSES,
  classSkills, SKILL_CAP, critChance, CRIT_MULT,
} from '../public/js/rpg.js';
import { MOB_TYPES, MOB_DROPS, pickMobType } from '../public/js/mobs.js';

// Blocks players are allowed to place (must match client BLOCKS palette,
// excluding air=0 and bedrock=1 and water=9 which are not placeable).
const PLACEABLE = new Set([2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
const SPAWN = { x: 8, y: 40, z: 8, yaw: 0, pitch: 0 };

// Weapon/armor stats come from the shared gear.js. Small slack added to the
// attacker's reach to tolerate latency between move updates.
const REACH_SLACK = 1.5;
const ATTACK_COOLDOWN = 300;
const KILL_SCORE = 50;

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
    }
  }

  function roster() {
    return [...clients.values()].map((c) => ({
      id: c.netId, name: c.user.username,
      x: c.state.x, y: c.state.y, z: c.state.z,
      yaw: c.state.yaw, pitch: c.state.pitch,
      appearance: safeParse(c.state.appearance, null),
      equipment: normalizeEquipment(safeParse(c.state.equipment, null)),
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

      if (!ctx) {
        if (msg.type !== 'auth') return ws.close();
        const payload = verifyToken(msg.token);
        if (!payload) return send(ws, { type: 'authError' }), ws.close();
        // Reject if the account was deleted or banned since the token was issued.
        const urow = userQueries.byId.get(payload.id);
        if (!urow || urow.banned) return send(ws, { type: 'authError' }), ws.close();
        const state = loadState(payload.id);
        // Marina City has a flat street level (y=22); rescue any player whose
        // saved position predates the city (could be underground now) by
        // dropping them onto the street from the sky (spawn protection covers it).
        if (!(state.y > 23)) { state.x = SPAWN.x; state.y = SPAWN.y; state.z = SPAWN.z; }
        userQueries.touch.run(Date.now(), payload.id);
        ctx = {
          user: payload, state, ws, netId: nextNetId++,
          lastMove: 0, lastAttack: 0, dead: false, skipSave: false,
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
          isAdmin: !!userQueries.byId.get(payload.id)?.is_admin,
          state: publicState(state),
          prices: CONFIG.MATERIAL_PRICES,
          difficulty: getSettings().difficulty,
          tuning: clientTuning(),
          canFly: ctx.canFly,
          edits: getAllEdits(),
          players: roster().filter((p) => p.id !== ctx.netId),
          pickups: [...pickups.values()],
          ground: [...ground.values()].map(groundPublic),
          mobs: [...mobs.values()].map(mobPublic),
        });
        broadcast({
          type: 'playerJoin',
          player: { id: ctx.netId, name: payload.username,
            x: state.x, y: state.y, z: state.z, yaw: state.yaw, pitch: state.pitch,
            appearance: safeParse(state.appearance, null),
            equipment: normalizeEquipment(safeParse(state.equipment, null)) },
        }, ws);
        for (let i = 0; i < 3; i++) spawnPickup();
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
          // Let everyone else play the swing / fire animation.
          broadcast({ type: 'playerSwing', id: ctx.netId, cat: w.cat }, ws);
          const s = ctx.state;
          const base = w.dmg * damageMult(prog, w.cat) * buffMult(ctx, 'dmg', 1);
          const rolled = critize(prog, base);
          if (msg.targetType === 'mob') {
            const m = mobs.get(msg.target);
            if (!m) break;
            if (Math.hypot(m.x - s.x, m.y - s.y, m.z - s.z) > w.reach + REACH_SLACK) break;
            hurtMob(m, Math.round(rolled.dmg), ctx, rolled.crit ? 'crit' : 'hit');
            break;
          }
          let target = null;
          for (const c of clients.values()) if (c.netId === msg.target) { target = c; break; }
          if (!target || target === ctx || target.dead) break;
          const ts = target.state;
          const dist = Math.hypot(ts.x - s.x, ts.y - s.y, ts.z - s.z);
          if (dist > w.reach + REACH_SLACK) break;
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
          const dx = p.x - s.x, dy = p.y - s.y, dz = p.z - s.z;
          if (dx * dx + dy * dy + dz * dz > PICKUP_GRAB * PICKUP_GRAB) break;
          const def = PICKUP_KINDS[p.kind] || PICKUP_KINDS.medkit;
          // If the relevant bar is already full, bank it in the bag; else use now.
          const full = p.kind === 'medkit' ? s.health >= getMaxHp(s) : s.hunger >= 20;
          let stored = false;
          if (full) {
            const cons = safeParse(s.consumables, {});
            cons[p.kind] = (cons[p.kind] || 0) + 1;
            s.consumables = JSON.stringify(cons);
            stored = true;
          } else {
            if (def.heal) s.health = clamp(s.health + def.heal, 0, getMaxHp(s));
            if (def.hunger) s.hunger = clamp(s.hunger + def.hunger, 0, 20);
            pushHealth(ctx, { hunger: s.hunger });
          }
          pickups.delete(p.id);
          broadcast({ type: 'pickupRemove', id: p.id });
          send(ws, { type: 'pickupGot', kind: p.kind, heal: def.heal, hunger: def.hunger, stored });
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
          break;
        }
        case 'setSpawn': {
          // Remember the player's current position as their respawn point.
          if (ctx.dead) break;
          const s = ctx.state;
          if (![s.x, s.y, s.z].every(Number.isFinite)) break;
          s.spawn_x = s.x; s.spawn_y = s.y; s.spawn_z = s.z;
          saveState(s);
          send(ws, { type: 'spawnSet', x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z) });
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
    if (action === 'break') {
      setBlock(x, y, z, 0);
      s.blocks_mined += 1;
      const w = equippedWeapon(safeParse(s.equipment, null));
      s.score += 5 + (w.mine || 0);
      gainXp(ctx, 3);
      // Collect the mined material into the player's inventory.
      const mt = msg.mt;
      if (CONFIG.MATERIAL_PRICES[mt]) {
        const inv = safeParse(s.inventory, {});
        inv[mt] = (inv[mt] || 0) + 1;
        s.inventory = JSON.stringify(inv);
      }
      broadcast({ type: 'block', x, y, z, t: 0 });
    } else if (action === 'place') {
      const t = msg.t;
      if (!PLACEABLE.has(t)) return;
      setBlock(x, y, z, t);
      s.blocks_placed += 1;
      s.score += 1;
      gainXp(ctx, 1);
      broadcast({ type: 'block', x, y, z, t });
    } else return;
    send(ws, { type: 'stats', state: publicState(s) });
  }

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
    const dx = g.x - s.x, dy = g.y - s.y, dz = g.z - s.z;
    if (dx * dx + dy * dy + dz * dz > LOOT_GRAB * LOOT_GRAB) return;
    s.cash += g.cash;
    const inv = safeParse(s.inventory, {});
    for (const [type, count] of Object.entries(g.materials)) inv[type] = (inv[type] || 0) + count;
    s.inventory = JSON.stringify(inv);
    removeGround(g.id);
    send(ws, { type: 'looted', cash: g.cash, count: materialCount(g.materials), owner: g.owner_name });
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
    const now = Date.now();
    const cfg = getSettings();
    if (now - (ctx.skillCd[skill.id] || 0) < skill.cd * cfg.skillCdMult) return;
    ctx.skillCd[skill.id] = now;
    const s = ctx.state;
    broadcast({ type: 'skillFx', id: ctx.netId, skill: skill.id, kind: skill.kind, x: s.x, y: s.y, z: s.z }, ws);
    const val = skill.base + lvl * skill.per;
    const nukeRange = 36 * cfg.skillRangeMult;

    const basePower = val * damageMult(p, skill.cat) * buffMult(ctx, 'dmg', 1) * cfg.skillDmgMult;
    if (skill.kind === 'nuke') {
      const r = critize(p, basePower); const fx = r.crit ? 'crit' : 'skill'; const power = Math.round(r.dmg);
      if (msg.targetType === 'mob') {
        const m = mobs.get(msg.target);
        if (m && dist3(s, m) <= nukeRange) { applyStatuses(m.effects, skill.status, lvl, ctx.netId); hurtMob(m, power, ctx, fx); }
      } else {
        let t = null; for (const c of clients.values()) if (c.netId === msg.target) t = c;
        if (t && t !== ctx && !t.dead && dist3(s, t.state) <= nukeRange) {
          const def = defenseOf(safeParse(t.state.equipment, null)) + defenseBonus(safeParse(t.state.progress, null)) + buffMult(t, 'def', 0);
          applyPlayerStatus(t, skill.status, lvl, ctx.netId);
          applyDamage(t, mitigate(power, def), ctx, 'combat', r.crit ? 'crit' : undefined);
        }
      }
    } else if (skill.kind === 'aoe') {
      const rad = (skill.radius + lvl * 0.4) * cfg.skillRangeMult;
      for (const m of [...mobs.values()]) if (dist3(s, m) <= rad) {
        const r = critize(p, basePower);
        applyStatuses(m.effects, skill.status, lvl, ctx.netId); hurtMob(m, Math.round(r.dmg), ctx, r.crit ? 'crit' : 'skill');
      }
      for (const c of clients.values()) {
        if (c === ctx || c.dead || dist3(s, c.state) > rad) continue;
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
    ts.health = Math.max(0, ts.health - dmg);
    target.dead = ts.health <= 0;
    pushHealth(target, { hit: true, by: attacker?.user.username, dmg: Math.round(dmg), fx });
    if (target.dead) handleDeath(target, attacker, cause);
  }

  // Roll a critical hit based on the attacker's dexterity.
  function critize(prog, dmg) {
    if (Math.random() < critChance(prog)) return { dmg: dmg * CRIT_MULT, crit: true };
    return { dmg, crit: false };
  }

  function handleDeath(target, attacker, cause) {
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

  function spawnPickup(forceKind) {
    const cfg = getSettings();
    const arr = [...clients.values()];
    if (!arr.length || pickups.size >= cfg.pickupCap) return null;
    const kinds = Object.keys(PICKUP_KINDS).filter((k) =>
      (k === 'medkit' && cfg.medkitEnabled) || (k === 'food' && cfg.foodEnabled));
    if (forceKind && PICKUP_KINDS[forceKind]) kinds.length = 0, kinds.push(forceKind);
    if (!kinds.length) return null;
    const anchor = arr[(Math.random() * arr.length) | 0].state;
    const kind = kinds[(Math.random() * kinds.length) | 0];
    const ang = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * 14;
    const p = { id: nextPickupId++, kind,
      x: round1(anchor.x + Math.cos(ang) * r),
      y: round1(anchor.y + 0.5),
      z: round1(anchor.z + Math.sin(ang) * r) };
    pickups.set(p.id, p);
    broadcast({ type: 'pickupSpawn', pickup: p });
    return p;
  }

  // ---- monsters (PvE) ----------------------------------------------------
  function spawnMob(forceType, capBonus = 0) {
    const cfg = getSettings();
    if (!cfg.mobEnabled) return null;
    const arr = [...clients.values()].filter((c) => !c.dead);
    // Population scales with the number of online players (and night surge).
    const cap = Math.min(cfg.mobCap, arr.length * cfg.mobPerPlayer) + capBonus;
    if (!arr.length || mobs.size >= cap) return null;
    const anchor = arr[(Math.random() * arr.length) | 0].state;
    const type = forceType && MOB_TYPES[forceType] ? forceType : pickMobType();
    const def = MOB_TYPES[type];
    const ang = Math.random() * Math.PI * 2;
    const r = 12 + Math.random() * 14;
    const hp = Math.max(1, Math.round(def.hp * cfg.mobPower));
    const m = { id: nextMobId++, type,
      x: round1(anchor.x + Math.cos(ang) * r), y: round1(anchor.y), z: round1(anchor.z + Math.sin(ang) * r),
      yaw: 0, health: hp, maxHealth: hp, target: null, lastAttack: 0, effects: {} };
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

  function mobTick(dt) {
    if (!mobs.size) return;
    const cfg = getSettings();
    const players = [...clients.values()].filter((c) => !c.dead);
    const moved = [];
    const now = Date.now();
    for (const m of mobs.values()) {
      const def = MOB_TYPES[m.type];
      // Passive monsters (e.g. slimes) never chase or attack — they just wander.
      if (def.passive) {
        wanderMob(m, dt);
        moved.push({ id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, st: mobStatusCodes(m, now) });
        continue;
      }
      // Keep the current target only while it's within leash range, else give up.
      let tgt = null;
      if (m.target != null) {
        const c = players.find((p) => p.netId === m.target);
        if (c && Math.hypot(c.state.x - m.x, c.state.z - m.z) <= def.leash) tgt = c;
        else m.target = null;
      }
      if (!tgt) {
        let best = null, bd = def.aggro;
        for (const c of players) {
          // Strong monsters ignore low-level players unless provoked.
          if (def.minLevel && playerLevel(c) < def.minLevel) continue;
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
            for (const c of players) {
              if (c.dead) continue;
              if (Math.hypot(c.state.x - tl.x, c.state.z - tl.z) > tl.radius) continue;
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
          m.tele = { x: tgt.state.x, y: tgt.state.y, z: tgt.state.z, radius, until: now + 1500, dmg: def.dmg * 2.5 * cfg.mobPower };
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
        m.x = round1(m.x + dx / (dist || 1) * step);
        m.z = round1(m.z + dz / (dist || 1) * step);
      }
      m.y = round1(m.y + (tgt.state.y - m.y) * Math.min(1, dt * 4));
      if (dist <= def.reach && now - m.lastAttack > 1200) {
        m.lastAttack = now;
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
    if (Date.now() - lastPickup >= cfg.pickupIntervalMs) {
      if (spawnPickup()) lastPickup = Date.now();
    }
  }, 1000);

  // Regen / starvation derived from hunger.
  setInterval(() => {
    for (const ctx of clients.values()) {
      if (ctx.dead) continue;
      const s = ctx.state;
      const mh = getMaxHp(s);
      let changed = false;
      if (s.hunger >= 16 && s.health < mh) { s.health = Math.min(mh, s.health + 1); changed = true; }
      else if (s.hunger === 0 && s.health > 1) { s.health = Math.max(1, s.health - 1); changed = true; }
      if (changed) pushHealth(ctx);
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
        if (kind === 'boss') r = spawnMob('boss', 999);           // bosses bypass the cap
        else if (kind === 'mob' || MOB_TYPES[kind]) r = spawnMob(MOB_TYPES[kind] ? kind : undefined);
        else r = spawnPickup(kind);
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
    kick(userId) {
      const c = findByUserId(userId);
      if (c) { c.skipSave = true; c.ws.close(); clients.delete(c.ws); }
    },
    recentChat() { return chatLog.slice(-120); },
    broadcastTuning() { broadcast({ type: 'tuning', tuning: clientTuning() }); },
    refreshFly() { refreshFly(); },
    setWings(userId, on) {
      userQueries.setWings.run(on ? 1 : 0, userId);
      const c = findByUserId(userId);
      if (c) { c.canFly = computeCanFly(c); send(c.ws, { type: 'canFly', value: c.canFly }); }
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
    m.x = round1(m.x + Math.sin(m.wYaw) * sp * dt);
    m.z = round1(m.z + Math.cos(m.wYaw) * sp * dt);
    m.yaw = m.wYaw;
  }
}

function round1(v) { return Math.round(v * 10) / 10; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
