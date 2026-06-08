// Auth (REST) + multiplayer (WebSocket) client.
export class Network {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.connected = false;
  }

  on(type, fn) { this.handlers[type] = fn; }
  emit(type, data) { if (this.handlers[type]) this.handlers[type](data); }

  async register(username, password) {
    return this._auth('/api/register', username, password);
  }
  async login(username, password) {
    return this._auth('/api/login', username, password);
  }
  async _auth(url, username, password) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return res.json();
  }

  async leaderboard() {
    try {
      const res = await fetch('/api/leaderboard');
      return (await res.json()).leaders || [];
    } catch { return []; }
  }

  connect(token) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.send({ type: 'auth', token });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.emit(msg.type, msg);
    });
    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.emit('disconnect', {});
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendMove(p) {
    this.send({ type: 'move', x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, pitch: p.pitch });
  }
  sendBlock(action, x, y, z, t, tool, mt) {
    this.send({ type: 'block', action, x, y, z, t, tool, mt });
  }
  // Stream while chipping a block; the server accumulates the break + cracks.
  sendMine(x, y, z) { this.send({ type: 'mine', x, y, z }); }
  sendStats(hunger) { this.send({ type: 'stats', hunger }); }
  sendDamage(amount, cause) { this.send({ type: 'damage', amount, cause }); }
  sendAttack(target, weapon, targetType) { this.send({ type: 'attack', target, weapon, targetType }); }
  sendPickup(id) { this.send({ type: 'pickup', id }); }
  sendCollectGround(id) { this.send({ type: 'collectGround', id }); }
  sendSell() { this.send({ type: 'sell' }); }
  sendUseConsumable(kind) { this.send({ type: 'useConsumable', kind }); }
  sendCraft(req) { this.send({ type: 'craft', ...req }); }
  sendSpendAttr(attr) { this.send({ type: 'spendAttr', attr }); }
  sendSpendSkill(slot) { this.send({ type: 'spendSkill', slot }); }
  sendSkill(slot, target, targetType) { this.send({ type: 'useSkill', slot, target, targetType }); }
  sendSetClass(cls) { this.send({ type: 'setClass', cls }); }
  sendAppearance(appearance) { this.send({ type: 'appearance', appearance }); }
  sendRespawn() { this.send({ type: 'respawn' }); }
  sendSetSpawn() { this.send({ type: 'setSpawn' }); }
  sendChat(text) { this.send({ type: 'chat', text }); }

  // Delete the logged-in player's own account.
  async deleteAccount(token) {
    try {
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      return res.json();
    } catch { return { error: 'Network error.' }; }
  }
}
