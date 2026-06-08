// HUD + screens: login, hotbar, vitals, XP, chat, achievements, leaderboard,
// backpack/economy and account actions.
import { blockSwatch, BLOCK_NAMES } from './blocks.js';
import { HOTBAR, DEFAULT_SLOT } from './items.js';
import { isTouchDevice } from './mobile.js';
import { WEAPONS, ARMOR, ARMOR_SLOTS, MAX_LEVEL, weaponStats, defenseOf, agilityOf, upgradeCost } from './gear.js';
import { CLASSES, ATTRS, ATTR_INFO, ATTR_CAP, LEVEL_CAP, nextXp, defenseBonus, classSkills, SKILL_CAP } from './rpg.js';

export const ACHIEVEMENTS = [
  { id: 'first_block', name: '🪓 Getting Wood', test: (s) => s.blocksMined >= 1 },
  { id: 'miner10', name: '⛏️ Apprentice Miner', test: (s) => s.blocksMined >= 10 },
  { id: 'miner100', name: '💎 Master Miner', test: (s) => s.blocksMined >= 100 },
  { id: 'builder', name: '🏗️ Architect', test: (s) => s.blocksPlaced >= 50 },
  { id: 'level5', name: '⭐ Seasoned Crafter', test: (s) => s.level >= 5 },
  { id: 'swimmer', name: '🏊 Fish Out of Water', test: (s) => s.swam },
  { id: 'slayer', name: '⚔️ Warrior', test: (s) => s.kills >= 1 },
  { id: 'score1000', name: '🏆 High Roller', test: (s) => s.score >= 1000 },
];

export class UI {
  constructor() {
    this.el = (id) => document.getElementById(id);
    this.selected = 0;
    this.unlocked = new Set();
    this.prices = {};
    this.inventory = {};
    this.buildHotbar();
  }

  // ---- Login screen ----
  bindAuth({ onLogin, onRegister }) {
    const msg = this.el('auth-msg');
    const show = (text, ok) => { msg.textContent = text; msg.className = ok ? 'ok' : 'err'; };
    const creds = () => ({
      username: this.el('auth-user').value.trim(),
      password: this.el('auth-pass').value,
    });
    this.el('btn-login').onclick = async () => {
      const { username, password } = creds();
      const r = await onLogin(username, password);
      if (r?.error) show(r.error, false);
    };
    this.el('btn-register').onclick = async () => {
      const { username, password } = creds();
      const r = await onRegister(username, password);
      if (r?.error) show(r.error, false);
      else show('Account created! Joining world…', true);
    };
    this.el('auth-pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.el('btn-login').click();
    });
  }

  showAuth(show) { this.el('auth').classList.toggle('hidden', !show); }
  hideAuthAndPlay(username) {
    this.showAuth(false);
    this.el('hud').classList.remove('hidden');
    this.el('whoami').textContent = username;
  }

  // ---- Hotbar: an empty "mine" slot, then the placeable blocks ----
  // On touch only a small window of slots is shown; arrows scroll through the
  // rest. On desktop the whole bar is shown and number keys / wheel select.
  buildHotbar() {
    const bar = this.el('hotbar');
    bar.innerHTML = '';
    this.slotCount = HOTBAR.length + 1;
    this.touch = isTouchDevice();

    // The track holds every slot; on touch it slides inside a clipped viewport.
    const track = document.createElement('div');
    track.id = 'hotbar-track';
    this._hotTrack = track;

    // Slot 0 = weapon/mine slot: holds your equipped weapon (used to attack &
    // mine). Tapping it again swaps the weapon with your axe.
    const mine = document.createElement('div');
    mine.className = 'slot mine-slot';
    mine.title = 'Equipped weapon — attack & mine. Press 1 again to swap ⇄ 🪓 Axe';
    mine.innerHTML = '<span class="ico" id="held-weapon-ico">⚔️</span><span class="num">1</span>';
    mine.onclick = () => { if (this.selected === 0) this.switchWeapon(); else this.selectSlot(0); };
    track.appendChild(mine);
    HOTBAR.forEach((type, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const img = document.createElement('img');
      img.src = blockSwatch(type);
      slot.appendChild(img);
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = i + 2;
      slot.appendChild(num);
      slot.onclick = () => this.selectSlot(i + 1);
      track.appendChild(slot);
    });

    if (this.touch) {
      const arrow = (cls, dir) => {
        const b = document.createElement('button');
        b.className = 'hb-arrow ' + cls;
        b.textContent = dir < 0 ? '‹' : '›';
        b.onclick = () => this.cycleSlot(dir);
        return b;
      };
      const view = document.createElement('div');
      view.id = 'hotbar-view';
      view.appendChild(track);
      bar.append(arrow('left', -1), view, arrow('right', 1));
    } else {
      bar.appendChild(track);
    }
    this.selectSlot(0); // default: mine mode
  }

  selectSlot(i) {
    this.selected = (i + this.slotCount) % this.slotCount;
    const slots = [...this._hotTrack.children];
    slots.forEach((s, idx) => s.classList.toggle('active', idx === this.selected));
    // On touch, slide the track so the selected slot sits in the centre of the
    // 3-slot window. Pitch = slot layout width (offsetWidth ignores the active
    // scale transform) + the 5px flex gap.
    if (this.touch && slots.length) {
      const pitch = slots[0].offsetWidth + 5;
      this._hotTrack.style.transform = `translateX(${(1 - this.selected) * pitch}px)`;
    }
  }

  cycleSlot(dir) { this.selectSlot(this.selected + dir); }
  // null = weapon/mine slot (attack & mine); otherwise the block to place.
  selectedBlock() { return this.selected === 0 ? null : HOTBAR[this.selected - 1]; }

  // The weapon/mine slot reflects the equipped weapon's icon. Tapping it again
  // (or pressing 1 when it's already active) asks the game to swap to the axe.
  bindWeaponSwitch(fn) { this._onWeaponSwitch = fn; }
  switchWeapon() { if (this._onWeaponSwitch) this._onWeaponSwitch(); }
  setHeldWeapon(type) {
    const ico = this.el('held-weapon-ico');
    if (ico) ico.textContent = (WEAPONS[type] || WEAPONS.fist).icon || '⚔️';
  }

  // ---- Vitals (health + food bars) ----
  updateVitals(player) {
    const mh = player.maxHealth || 20;
    this.el('hp-fill').style.width = Math.max(0, Math.min(100, player.health / mh * 100)) + '%';
    this.el('food-fill').style.width = Math.max(0, Math.min(100, player.hunger / 20 * 100)) + '%';
    const stam = this.el('stam-fill');
    stam.style.width = Math.max(0, Math.min(100, player.stamina * 100)) + '%';
    stam.classList.toggle('cd', player.staminaLocked);
    this.updateConsumeButtons(player);
  }

  // Quick-use medkit/food buttons: show counts; disable at 0 or when that bar is full.
  updateConsumeButtons(player) {
    const c = this.consumables || {};
    const mk = c.medkit || 0, fd = c.food || 0;
    const mh = player.maxHealth || 20;
    this.el('cm-n').textContent = mk;
    this.el('cf-n').textContent = fd;
    this.el('cons-medkit').disabled = mk <= 0 || player.health >= mh;
    this.el('cons-food').disabled = fd <= 0 || player.hunger >= 20;
  }

  updateStats(s) {
    this.el('score').textContent = s.score;
    this.el('level').textContent = s.level;
    this.el('mined').textContent = s.blocksMined;
    if (typeof s.cash === 'number') { this.cash = s.cash; this.el('cash').textContent = s.cash; }
    this.el('xp-pct').textContent = Math.round(Math.max(0, Math.min(100, (s.xp / s.nextLevelXp) * 100))) + '%';
    if (s.inventory) this.inventory = s.inventory;
    if (s.equipment) this.equipment = s.equipment;
    if (s.progress) this.progress = s.progress;
    if (s.consumables) this.consumables = s.consumables;
    if (this.isBagOpen()) this.renderBag();
    if (this.isCharOpen()) this.renderCharsheet();
  }

  // ---- Windows: bag / character / settings ----
  setPrices(prices) { this.prices = prices || {}; }
  setEquipment(e) { this.equipment = e; if (this.isBagOpen()) this.renderBag(); }
  setProgress(p) { this.progress = p; if (this.isBagOpen()) this.renderBag(); if (this.isCharOpen()) this.renderCharsheet(); }
  setAdmin(isAdmin) { this.el('admin-link').classList.toggle('hidden', !isAdmin); }
  isOpen(id) { return !this.el(id).classList.contains('hidden'); }
  isBagOpen() { return this.isOpen('inventory'); }
  isCharOpen() { return this.isOpen('charsheet'); }
  anyMenuOpen() { return this.isBagOpen() || this.isCharOpen() || this.isOpen('settings'); }
  materialTotal() { let n = 0; for (const c of Object.values(this.inventory || {})) n += c; return n; }

  bindMenu({ onSell, onLogout, onDelete, onCustomize, onEquip, onCraft, onSpend, onUpgradeSkill, onUseConsumable }) {
    this._onEquip = onEquip;
    this._onCraft = onCraft;
    this._onSpend = onSpend;
    this._onUpgradeSkill = onUpgradeSkill;
    this._onUseConsumable = onUseConsumable;
    this.el('btn-bag').onclick = () => this.toggleBag();
    this.el('btn-name').onclick = () => this.openPanel('settings');
    this.el('btn-char').onclick = () => this.openPanel('charsheet');
    this.el('btn-sell').onclick = () => onSell();
    this.el('cons-medkit').onclick = () => onUseConsumable('medkit');
    this.el('cons-food').onclick = () => onUseConsumable('food');
    this.el('btn-customize').onclick = () => { this.closeAll(); onCustomize(); };
    this.el('btn-logout').onclick = () => onLogout();
    this.el('btn-delete-account').onclick = () => {
      if (confirm('Delete your account permanently? This cannot be undone.')) onDelete();
    };
    for (const t of ['items', 'gear', 'craft']) this.el('tab-' + t).onclick = () => this.switchTab(t);
    for (const b of document.querySelectorAll('.panel-exit')) b.onclick = () => this.closePanel(b.dataset.close);
    this.tab = 'items';
  }

  openPanel(id) {
    this.closeAll();
    this.el(id).classList.remove('hidden');
    if (this.onMenuOpen) this.onMenuOpen();
    if (id === 'inventory') this.switchTab(this.tab || 'items');
    else if (id === 'charsheet') this.renderCharsheet();
  }
  closePanel(id) { this.el(id).classList.add('hidden'); }
  closeAll() { for (const id of ['inventory', 'charsheet', 'settings']) this.el(id).classList.add('hidden'); }
  toggleBag(force) {
    const open = force !== undefined ? force : !this.isBagOpen();
    if (open) this.openPanel('inventory'); else this.closePanel('inventory');
  }

  switchTab(name) {
    this.tab = name;
    for (const t of ['items', 'gear', 'craft']) {
      this.el('tab-' + t).classList.toggle('active', t === name);
      this.el('panel-' + t).classList.toggle('hidden', t !== name);
    }
    this.renderBag();
  }

  renderBag() {
    if (this.tab === 'items') this.renderItems();
    else if (this.tab === 'gear') this.renderGear();
    else this.renderCraft();
  }

  renderCharsheet() { this.renderChar(); this.renderSkills(); }

  renderSkills() {
    const p = this.progress; if (!p) return;
    this.el('skill-points').textContent = p.skillPoints || 0;
    const list = this.el('skill-list');
    list.innerHTML = '';
    classSkills(p.class).forEach((sk, slot) => {
      const lvl = (p.skills && p.skills[sk.id]) || 0;
      const row = document.createElement('div');
      row.className = 'gear-row';
      const keyHint = ['Z', 'X', 'C'][slot];
      row.innerHTML = `<span>${sk.icon} <b>${sk.name}</b> <small>Lv ${lvl}/${SKILL_CAP} · key ${keyHint}</small>` +
        `<br><small style="color:#8aa0c6">${sk.blurb || ''}</small></span>`;
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = lvl === 0 ? 'Learn' : (lvl >= SKILL_CAP ? 'Max' : 'Upgrade');
      b.disabled = (p.skillPoints || 0) <= 0 || lvl >= SKILL_CAP;
      b.onclick = () => this._onUpgradeSkill && this._onUpgradeSkill(slot);
      row.appendChild(b);
      list.appendChild(row);
    });
  }

  renderChar() {
    const p = this.progress; if (!p) return;
    const cls = CLASSES[p.class] || CLASSES.soldier;
    const need = nextXp(p);
    const pct = need ? Math.min(100, p.xp / need * 100) : 100;
    this.el('char-info').innerHTML =
      `<b>${cls.icon} ${cls.name}</b> &nbsp; Level <b>${p.level}</b>/${LEVEL_CAP}` +
      `<br><small>${cls.desc}</small>`;
    this.el('char-xp').style.width = pct + '%';
    this.el('char-xp-label').textContent = need ? `${p.xp} / ${need} XP` : 'MAX LEVEL';
    this.el('char-points').textContent = p.points;

    const al = this.el('char-attrs');
    al.innerHTML = '';
    for (const a of ATTRS) {
      const info = ATTR_INFO[a];
      const row = document.createElement('div');
      row.className = 'gear-row';
      row.innerHTML = `<span>${info.icon} ${info.name} <b>${p.attrs[a]}</b> <small>${info.desc}</small></span>`;
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = '＋';
      b.disabled = p.points <= 0 || p.attrs[a] >= ATTR_CAP;
      b.onclick = () => this._onSpend && this._onSpend(a);
      row.appendChild(b);
      al.appendChild(row);
    }
  }

  renderItems() {
    // Consumables (medkit / food) with Use buttons.
    const cl = this.el('cons-list');
    const c = this.consumables || {};
    const defs = [['medkit', '🩹 Healing patch', '+8 ❤️'], ['food', '🍗 Food', '+8 🍗']];
    cl.innerHTML = '';
    let any = false;
    for (const [kind, name, eff] of defs) {
      const n = c[kind] || 0;
      if (n <= 0) continue;
      any = true;
      const row = document.createElement('div');
      row.className = 'gear-row';
      row.innerHTML = `<span>${name} ×${n} <small>${eff}</small></span>`;
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = 'Use';
      b.onclick = () => this._onUseConsumable && this._onUseConsumable(kind);
      row.appendChild(b);
      cl.appendChild(row);
    }
    if (!any) cl.innerHTML = '<div class="gear-row"><span><small>None — picked-up patches/food are saved here when your bars are full.</small></span></div>';

    const body = this.el('inv-body');
    const entries = Object.entries(this.inventory).filter(([, n]) => n > 0);
    body.innerHTML = entries.length ? '' : '<tr><td colspan="4">Empty — go mine some blocks!</td></tr>';
    let total = 0;
    for (const [type, count] of entries) {
      const unit = this.prices[type] || 0;
      const value = unit * count;
      total += value;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><img class="mat" src="${blockSwatch(Number(type))}"> ${BLOCK_NAMES[type] || ('#' + type)}</td>` +
        `<td>${count}</td><td>💰${unit}</td><td>💰${value}</td>`;
      body.appendChild(tr);
    }
    this.el('inv-total').textContent = total;
  }

  renderGear() {
    const e = this.equipment; if (!e) return;
    const w = weaponStats(e.weapon, (e.weapons && e.weapons[e.weapon]) || 1);
    const def = Math.round(defenseOf(e) + defenseBonus(this.progress || {}));
    const agi = agilityOf(e);
    this.el('gear-summary').innerHTML =
      `🗡 <b>${w.dmg}</b> dmg &nbsp; 🛡 <b>${def}</b> def (−${Math.min(80, def * 4)}%) &nbsp; 👟 <b>+${Math.round(agi * 6)}%</b> speed`;

    // Paper-doll: what's equipped, laid out on a body.
    const slot = (cls, icon, label, lvl) =>
      `<div class="pd-slot ${cls} ${lvl ? '' : 'empty'}"><span class="pd-ic">${icon}</span>` +
      `<span class="pd-lb">${label}</span><small>${lvl ? 'Lv' + lvl : '—'}</small></div>`;
    this.el('paperdoll').innerHTML =
      slot('pd-helmet', ARMOR.helmet.icon, 'Helmet', e.helmet) +
      slot('pd-weapon', w.icon, w.name, w.level) +
      slot('pd-chest', ARMOR.chest.icon, 'Chest', e.chest) +
      slot('pd-legs', ARMOR.legs.icon, 'Legs', e.legs) +
      slot('pd-boots', ARMOR.boots.icon, 'Boots', e.boots);

    // Owned weapons → tap to equip.
    const wl = this.el('gear-weapons');
    wl.innerHTML = '';
    for (const [type, lvl] of Object.entries(e.weapons || {})) {
      const st = weaponStats(type, lvl);
      const row = document.createElement('div');
      row.className = 'gear-row' + (e.weapon === type ? ' equipped' : '');
      row.innerHTML = `<span>${st.icon} ${st.name} <small>Lv${lvl} · ${st.dmg}dmg · ${st.cat}</small></span>`;
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = e.weapon === type ? 'Equipped' : 'Equip';
      b.disabled = e.weapon === type;
      b.onclick = () => this._onEquip && this._onEquip(type);
      row.appendChild(b);
      wl.appendChild(row);
    }
  }

  renderCraft() {
    const e = this.equipment; if (!e) return;
    const list = this.el('craft-list');
    list.innerHTML = `<p class="hint">You have 💰${this.cash || 0} and ${this.materialTotal()} materials. Crafting spends cash + raw materials.</p>`;

    const makeRow = (icon, name, sub, label, cost, cb) => {
      const row = document.createElement('div');
      row.className = 'gear-row';
      row.innerHTML = `<span>${icon} ${name} <small>${sub}</small></span>`;
      const b = document.createElement('button');
      b.className = 'small';
      if (cost) {
        const ok = (this.cash || 0) >= cost.cash && this.materialTotal() >= cost.materials;
        b.textContent = `${label} (💰${cost.cash}+${cost.materials}🎒)`;
        b.disabled = !ok;
      } else { b.textContent = label; b.disabled = true; }
      b.onclick = cb;
      row.appendChild(b);
      list.appendChild(row);
    };

    // Weapons.
    for (const [type, def] of Object.entries(WEAPONS)) {
      if (!def.craftable) continue;
      const lvl = (e.weapons && e.weapons[type]) || 0;
      if (lvl === 0) {
        makeRow(def.icon, def.name, `craft Lv1 · ${weaponStats(type, 1).dmg}dmg · ${def.type}`,
          'Craft', upgradeCost(0), () => this._onCraft && this._onCraft({ kind: 'weapon', item: type, action: 'craft' }));
      } else if (lvl < MAX_LEVEL) {
        makeRow(def.icon, def.name, `Lv${lvl}→${lvl + 1} · ${weaponStats(type, lvl + 1).dmg}dmg`,
          'Upgrade', upgradeCost(lvl), () => this._onCraft && this._onCraft({ kind: 'weapon', item: type, action: 'upgrade' }));
      } else {
        makeRow(def.icon, def.name, `Lv${MAX_LEVEL} · maxed`, 'Maxed', null);
      }
    }
    // Armor.
    for (const slot of ARMOR_SLOTS) {
      const a = ARMOR[slot], lvl = e[slot] || 0;
      if (lvl < MAX_LEVEL) {
        makeRow(a.icon, a.name, `Lv${lvl}→${lvl + 1}`, lvl === 0 ? 'Craft' : 'Upgrade',
          upgradeCost(lvl), () => this._onCraft && this._onCraft({ kind: 'armor', slot, action: 'upgrade' }));
      } else {
        makeRow(a.icon, a.name, `Lv${MAX_LEVEL} · maxed`, 'Maxed', null);
      }
    }
  }

  // ---- Achievements ----
  checkAchievements(stats) {
    for (const a of ACHIEVEMENTS) {
      if (!this.unlocked.has(a.id) && a.test(stats)) {
        this.unlocked.add(a.id);
        this.toast(`Achievement unlocked!\n${a.name}`);
      }
    }
  }
  primeAchievements(list) { (list || []).forEach((id) => this.unlocked.add(id)); }

  toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    this.el('toasts').appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3500);
  }

  // ---- Chat ----
  addChat(name, text, system) {
    const line = document.createElement('div');
    line.className = 'chat-line' + (system ? ' system' : '');
    line.innerHTML = system ? `<i>${escapeHtml(text)}</i>`
      : `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
    const log = this.el('chat-log');
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 60) log.removeChild(log.firstChild);
  }

  // ---- Death + counts ----
  showDeath(show) { this.el('death').classList.toggle('hidden', !show); }
  setOnline(n) { this.el('online').textContent = n; }

  // ---- Leaderboard ----
  async toggleLeaderboard(fetchFn) {
    const panel = this.el('leaderboard');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    const leaders = await fetchFn();
    const body = this.el('lb-body');
    body.innerHTML = leaders.length ? '' : '<tr><td colspan="4">No scores yet</td></tr>';
    leaders.forEach((l, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(l.username)}</td><td>${l.score}</td><td>${l.level}</td>`;
      body.appendChild(tr);
    });
    panel.classList.remove('hidden');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
