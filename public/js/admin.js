// Admin panel client: signs in with an admin account, then views/edits the
// live settings, deploys objects, and manages accounts via the /api/admin API.
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'jc_admin_token';

let token = localStorage.getItem(TOKEN_KEY);

function show(view) {
  $('login').classList.toggle('hidden', view !== 'login');
  $('dash').classList.toggle('hidden', view !== 'dash');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  if (res.status === 403 || res.status === 401) { signOut(); throw new Error('Not authorised'); }
  return res.json();
}

function msg(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

// ---- auth ----
$('a-login').onclick = async () => {
  const username = $('a-user').value.trim();
  const password = $('a-pass').value;
  const res = await (await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })).json();
  if (res.error) return msg('login-msg', res.error, false);
  if (!res.isAdmin) return msg('login-msg', 'That account is not an admin.', false);
  token = res.token;
  localStorage.setItem(TOKEN_KEY, token);
  start();
};

function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  token = null;
  show('login');
}
$('logout').onclick = signOut;
$('refresh').onclick = () => load();

// ---- settings ----
function fillSettings(s) {
  $('s-difficulty').value = s.difficulty;
  $('s-sellMultiplier').value = s.sellMultiplier;
  $('s-pickupCap').value = s.pickupCap;
  $('s-pickupInterval').value = Math.round(s.pickupIntervalMs / 1000);
  $('s-dropLifetime').value = Math.round(s.dropLifetimeMs / 3600000);
  $('s-inactiveDays').value = s.inactiveDays;
  $('s-mobCap').value = s.mobCap;
  $('s-mobInterval').value = Math.round(s.mobIntervalMs / 1000);
  $('s-mobPower').value = s.mobPower;
  $('s-chatInterval').value = (s.chatMinIntervalMs / 1000);
  $('s-brickCap').value = s.brickCap;
  $('s-medkit').checked = !!s.medkitEnabled;
  $('s-food').checked = !!s.foodEnabled;
  $('s-mob').checked = !!s.mobEnabled;
  $('s-wingsForAll').checked = !!s.wingsForAll;
  // Player / combat tuning
  $('s-spawnProtect').value = s.spawnProtectSec;
  $('s-hungerDrain').value = s.hungerDrainMult;
  $('s-staminaDrain').value = s.staminaDrainSec;
  $('s-staminaRefill').value = s.staminaRefillSec;
  $('s-moveSpeed').value = s.moveSpeedMult;
  $('s-skillDmg').value = s.skillDmgMult;
  $('s-skillRange').value = s.skillRangeMult;
  $('s-skillCd').value = s.skillCdMult;
}

$('s-save').onclick = async () => {
  const settings = {
    difficulty: $('s-difficulty').value,
    sellMultiplier: Number($('s-sellMultiplier').value),
    pickupCap: Number($('s-pickupCap').value),
    pickupIntervalMs: Number($('s-pickupInterval').value) * 1000,
    dropLifetimeMs: Number($('s-dropLifetime').value) * 3600000,
    inactiveDays: Number($('s-inactiveDays').value),
    mobCap: Number($('s-mobCap').value),
    mobIntervalMs: Number($('s-mobInterval').value) * 1000,
    mobPower: Number($('s-mobPower').value),
    chatMinIntervalMs: Math.round(Number($('s-chatInterval').value) * 1000),
    brickCap: Number($('s-brickCap').value),
    medkitEnabled: $('s-medkit').checked ? 1 : 0,
    foodEnabled: $('s-food').checked ? 1 : 0,
    mobEnabled: $('s-mob').checked ? 1 : 0,
    wingsForAll: $('s-wingsForAll').checked ? 1 : 0,
  };
  const res = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ settings }) });
  if (res.settings) { fillSettings(res.settings); msg('settings-msg', 'Saved ✓', true); }
};

$('s-save2').onclick = async () => {
  const settings = {
    spawnProtectSec: Number($('s-spawnProtect').value),
    hungerDrainMult: Number($('s-hungerDrain').value),
    staminaDrainSec: Number($('s-staminaDrain').value),
    staminaRefillSec: Number($('s-staminaRefill').value),
    moveSpeedMult: Number($('s-moveSpeed').value),
    skillDmgMult: Number($('s-skillDmg').value),
    skillRangeMult: Number($('s-skillRange').value),
    skillCdMult: Number($('s-skillCd').value),
  };
  const res = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ settings }) });
  if (res.settings) { fillSettings(res.settings); msg('tuning-msg', 'Saved ✓ — applied live to players.', true); }
};

// Re-apply the preset preview when difficulty changes (server is source of truth on save).
$('s-difficulty').onchange = () => msg('settings-msg', 'Save to apply the ' + $('s-difficulty').value + ' preset.', true);

// ---- deploy ----
$('d-medkit').onclick = () => deploy('medkit');
$('d-food').onclick = () => deploy('food');
$('d-mob').onclick = () => deploy('mob');
$('d-boss').onclick = () => deploy('boss');
async function deploy(kind) {
  const n = kind === 'boss' ? 1 : (Number($('d-count').value) || 1);
  const res = await api('/api/admin/deploy', { method: 'POST', body: JSON.stringify({ kind, n }) });
  msg('deploy-msg', res.deployed ? `Deployed ${res.deployed} ${kind}(s) — need a player online to anchor near.` : 'Nothing deployed (no players online?).', !!res.deployed);
  load();
}

// ---- users ----
async function userAction(action, id) {
  if (action === 'delete' && !confirm('Delete this account permanently?')) return;
  if (action === 'reset' && !confirm('Reset this player to a fresh state?')) return;
  if (action === 'ban' && !confirm('Ban this account? They will be disconnected and unable to log in.')) return;
  const res = await api('/api/admin/user', { method: 'POST', body: JSON.stringify({ action, id }) });
  if (res.error) msg('global-msg', res.error, false);
  else { msg('global-msg', `${action} ✓`, true); load(); }
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function render(data) {
  fillSettings(data.settings);

  $('online-count').textContent = data.online.length;
  $('online-body').innerHTML = data.online.map((p) =>
    `<tr><td>${esc(p.username)}</td><td>${p.x}, ${p.y}, ${p.z}</td><td>${p.health}</td><td>💰${p.cash}</td></tr>`
  ).join('') || '<tr><td colspan="4">No one online.</td></tr>';

  $('mob-count').textContent = (data.mobs || []).length;
  $('ground-count').textContent = data.ground.length;

  $('chat-body').innerHTML = (data.chat || []).length
    ? (data.chat).map((c) => {
        const t = new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div><span style="color:#6a7da0">${t}</span> <b>${esc(c.user)}:</b> ${esc(c.text)}</div>`;
      }).join('')
    : '<div style="color:#6a7da0">No chat yet.</div>';
  $('chat-body').scrollTop = $('chat-body').scrollHeight;
  $('ground-body').innerHTML = data.ground.map((g) =>
    `<tr><td>${esc(g.owner || '—')}</td><td>${g.x}, ${g.y}, ${g.z}</td><td>💰${g.cash}</td><td>${g.count}</td></tr>`
  ).join('') || '<tr><td colspan="4">No loot on the ground.</td></tr>';

  $('users-body').innerHTML = data.users.map((u) => {
    const tags = (u.is_admin ? ' <span class="tag admin">admin</span>' : '') +
      (u.banned ? ' <span class="tag" style="background:#b23a3a">banned</span>' : '') +
      (u.muted ? ' <span class="tag" style="background:#7a5e34">muted</span>' : '');
    const promote = u.is_admin
      ? `<button class="small secondary" data-act="demote" data-id="${u.id}">Demote</button>`
      : `<button class="small secondary" data-act="promote" data-id="${u.id}">Promote</button>`;
    const ban = u.banned
      ? `<button class="small secondary" data-act="unban" data-id="${u.id}">Unban</button>`
      : `<button class="small danger" data-act="ban" data-id="${u.id}">Ban</button>`;
    const mute = u.muted
      ? `<button class="small secondary" data-act="unmute" data-id="${u.id}">Unmute</button>`
      : `<button class="small secondary" data-act="mute" data-id="${u.id}">Mute</button>`;
    const wings = u.can_fly
      ? `<button class="small secondary" data-act="unwings" data-id="${u.id}">Remove wings</button>`
      : `<button class="small secondary" data-act="wings" data-id="${u.id}">🪽 Grant wings</button>`;
    const wingTag = u.can_fly ? ' <span class="tag" style="background:#2c5e8a">wings</span>' : '';
    return `<tr><td>${esc(u.username)}${tags}${wingTag}</td><td>${fmtDate(u.last_active)}</td>` +
      `<td>${u.score ?? 0}</td><td>💰${u.cash ?? 0}</td><td>` +
      `<button class="small" data-act="reset" data-id="${u.id}">Reset</button> ` +
      `<button class="small secondary" data-act="kick" data-id="${u.id}">Kick</button> ` +
      mute + ` ` + wings + ` ` + ban + ` ` + promote + ` ` +
      `<button class="small danger" data-act="delete" data-id="${u.id}">Delete</button></td></tr>`;
  }).join('') || '<tr><td colspan="5">No accounts.</td></tr>';

  for (const btn of $('users-body').querySelectorAll('button[data-act]')) {
    btn.onclick = () => userAction(btn.dataset.act, Number(btn.dataset.id));
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function load() {
  try {
    const data = await api('/api/admin/overview');
    render(data);
  } catch { /* signOut already handled */ }
}

let timer = null;
function start() {
  show('dash');
  load();
  clearInterval(timer);
  timer = setInterval(load, 5000); // live-ish refresh
}

if (token) start(); else show('login');
