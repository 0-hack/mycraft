// First-person player: movement input, AABB-vs-voxel physics, swimming,
// fall damage and block raycasting (DDA voxel traversal).
import * as THREE from 'three';
import { isSolid, isLiquid, B } from './blocks.js';

const HALF_W = 0.3;
const HEIGHT = 1.8;
const EYE = 1.62;
const GRAVITY = 28;
const JUMP_SPEED = 9;
const WALK = 5.2;
const SPRINT = 8.0;
const FLY_SPEED = 8.0;     // vertical climb speed while flying (wings)
const REACH = 6;
const SPRINT_DRAIN = 5;   // seconds of sprint to fully deplete stamina
const SPRINT_REFILL = 7;  // seconds to fully refill

export class Player {
  constructor(camera, world, spawn) {
    this.camera = camera;
    this.world = world;
    this.pos = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.inWater = false;
    this.health = 20;
    this.hunger = 20;
    this.dead = false;
    this.input = { forward: 0, strafe: 0, jump: false, sprint: false };
    this.speedMul = 1;     // boots agility + speed attribute − armour weight
    this.maxHealth = 20;   // raised by vitality
    this.hungerMul = 1;    // lowered by endurance
    this.stamina = 1;      // 0..1 sprint reserve
    this.staminaLocked = false; // forced cooldown after depletion
    this._effSprint = false;    // actually sprinting this frame
    this.fallStart = this.pos.y;
    this.canFly = false;   // granted by the server (admin / wings permission)
    this.flying = false;   // actively holding jump to fly this frame
    // Players spawn in the air and drop to the ground; that first landing must
    // never deal fall damage. Cleared the moment we first touch ground.
    this.spawnFalling = true;
    this._hungerTimer = 0;
    // Health is server-authoritative (so PvP is fair). Environmental damage is
    // still detected here and reported through this hook; regen/heals come from
    // the server via setHealth().
    this.onDamage = null;
  }

  look(dx, dy) {
    this.yaw -= dx;
    this.pitch -= dy;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  forwardDir() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  collides(x, y, z) {
    const minX = Math.floor(x - HALF_W), maxX = Math.floor(x + HALF_W);
    const minY = Math.floor(y), maxY = Math.floor(y + HEIGHT);
    const minZ = Math.floor(z - HALF_W), maxZ = Math.floor(z + HALF_W);
    for (let bx = minX; bx <= maxX; bx++)
      for (let by = minY; by <= maxY; by++)
        for (let bz = minZ; bz <= maxZ; bz++)
          if (isSolid(this.world.getBlock(bx, by, bz))) return true;
    return false;
  }

  update(dt) {
    if (this.dead) return;
    dt = Math.min(dt, 0.05); // clamp to avoid tunneling on lag spikes

    // Are we submerged?
    const head = this.world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y + EYE), Math.floor(this.pos.z));
    this.inWater = isLiquid(head) ||
      isLiquid(this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z)));

    // Sprint costs stamina; depleting it forces a cooldown until it refills.
    const wantSprint = this.input.sprint && (this.input.forward !== 0 || this.input.strafe !== 0);
    this._effSprint = wantSprint && !this.staminaLocked && this.stamina > 0;
    if (this._effSprint) {
      this.stamina = Math.max(0, this.stamina - dt / (this.staminaDrainSec || SPRINT_DRAIN));
      if (this.stamina <= 0) this.staminaLocked = true;
    } else {
      this.stamina = Math.min(1, this.stamina + dt / (this.staminaRefillSec || SPRINT_REFILL));
      if (this.staminaLocked && this.stamina >= 1) this.staminaLocked = false;
    }

    // Horizontal movement relative to yaw.
    const speed = (this._effSprint ? SPRINT : WALK) * (this.inWater ? 0.6 : 1) * this.speedMul;
    const fwd = this.forwardDir();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3();
    move.addScaledVector(fwd, this.input.forward);
    move.addScaledVector(right, this.input.strafe);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
    this.vel.x = move.x;
    this.vel.z = move.z;

    // Gravity / buoyancy / flight.
    if (this.inWater) {
      this.vel.y += -GRAVITY * 0.25 * dt;
      this.vel.y = Math.max(this.vel.y, -3);
      if (this.input.jump) this.vel.y = 4; // swim up
      this.flying = false;
    } else if (this.canFly) {
      // Creative-style wings: hold jump to climb, otherwise drift down gently
      // and hover. No gravity slam, so flight feels smooth.
      this.flying = true;
      if (this.input.jump) this.vel.y = FLY_SPEED;
      else this.vel.y = Math.max(this.vel.y - GRAVITY * 0.25 * dt, -FLY_SPEED * 0.5);
    } else {
      this.flying = false;
      this.vel.y -= GRAVITY * dt;
      if (this.input.jump && this.onGround) {
        this.vel.y = JUMP_SPEED;
        this.onGround = false;
      }
    }

    // Axis-separated collision resolution.
    const np = this.pos.clone();

    np.x += this.vel.x * dt;
    if (this.collides(np.x, this.pos.y, this.pos.z)) np.x = this.pos.x;

    np.z += this.vel.z * dt;
    if (this.collides(np.x, this.pos.y, np.z)) np.z = this.pos.z;

    const prevY = this.pos.y;
    np.y += this.vel.y * dt;
    if (this.collides(np.x, np.y, np.z)) {
      if (this.vel.y < 0) {
        this.onGround = true;
        if (this.spawnFalling) { this.spawnFalling = false; this.fallStart = this.pos.y; }
        else if (!this.canFly) this.handleFallDamage(prevY); // wings ignore fall damage
      }
      np.y = this.pos.y;
      this.vel.y = 0;
    } else {
      this.onGround = false;
    }

    this.pos.copy(np);
    if (this.onGround || this.inWater) this.fallStart = this.pos.y;

    // Void / fell out of world.
    if (this.pos.y < -5) this.hurt(20, 'void');

    this.survivalTick(dt);

    this.syncCamera();
  }

  // Place the camera at the player's eye looking along yaw/pitch. In third
  // person the render code pulls the camera back AFTER this; combat code calls
  // syncCamera() again first so raycasts always originate from the real eye.
  syncCamera() {
    this.camera.position.set(this.pos.x, this.pos.y + EYE, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }

  handleFallDamage(prevY) {
    const fall = this.fallStart - prevY;
    if (fall > 3.5 && !this.inWater) {
      this.hurt(Math.floor(fall - 3), 'fall');
    }
    this.fallStart = this.pos.y;
  }

  survivalTick(dt) {
    // Hunger slowly drains; movement drains a bit faster. (Regen/starvation is
    // resolved server-side from this hunger value.)
    this._hungerTimer += dt * (this._effSprint ? 1.8 : 1) * this.hungerMul;
    if (this._hungerTimer > 6) {
      this._hungerTimer = 0;
      this.hunger = Math.max(0, this.hunger - 1);
    }
  }

  // Locally predict environmental damage for instant feedback, then let the
  // server confirm via setHealth(). Combat/heals never go through here.
  hurt(amount, cause) {
    if (this.dead || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this.dead = true;
    if (this.onDamage) this.onDamage(amount, cause);
  }

  // Authoritative health/dead state pushed by the server.
  setHealth(health, dead) {
    this.health = Math.max(0, Math.min(this.maxHealth || 20, health));
    this.dead = !!dead;
  }

  respawn(spawn) {
    this.pos.set(spawn.x, spawn.y, spawn.z);
    this.vel.set(0, 0, 0);
    this.health = 20;
    this.hunger = 20;
    this.dead = false;
    this.fallStart = spawn.y;
    this.spawnFalling = true; // suppress fall damage on the respawn drop
  }

  // DDA voxel raycast from the camera. Returns { hit, place } block coords.
  raycast() {
    const origin = this.camera.position.clone();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = Math.sign(dir.x), stepY = Math.sign(dir.y), stepZ = Math.sign(dir.z);
    const tDelta = new THREE.Vector3(
      dir.x === 0 ? Infinity : Math.abs(1 / dir.x),
      dir.y === 0 ? Infinity : Math.abs(1 / dir.y),
      dir.z === 0 ? Infinity : Math.abs(1 / dir.z));
    const tMax = new THREE.Vector3(
      dir.x === 0 ? Infinity : ((stepX > 0 ? (x + 1 - origin.x) : (origin.x - x)) * tDelta.x),
      dir.y === 0 ? Infinity : ((stepY > 0 ? (y + 1 - origin.y) : (origin.y - y)) * tDelta.y),
      dir.z === 0 ? Infinity : ((stepZ > 0 ? (z + 1 - origin.z) : (origin.z - z)) * tDelta.z));

    let prev = { x, y, z };
    let dist = 0;
    while (dist < REACH) {
      const block = this.world.getBlock(x, y, z);
      if (isSolid(block)) {
        return { hit: { x, y, z }, place: prev };
      }
      prev = { x, y, z };
      if (tMax.x < tMax.y && tMax.x < tMax.z) { x += stepX; dist = tMax.x; tMax.x += tDelta.x; }
      else if (tMax.y < tMax.z) { y += stepY; dist = tMax.y; tMax.y += tDelta.y; }
      else { z += stepZ; dist = tMax.z; tMax.z += tDelta.z; }
    }
    return null;
  }

  // Prevent placing a block inside the player's own AABB.
  canPlaceAt(bx, by, bz) {
    const minX = Math.floor(this.pos.x - HALF_W), maxX = Math.floor(this.pos.x + HALF_W);
    const minY = Math.floor(this.pos.y), maxY = Math.floor(this.pos.y + HEIGHT);
    const minZ = Math.floor(this.pos.z - HALF_W), maxZ = Math.floor(this.pos.z + HALF_W);
    return !(bx >= minX && bx <= maxX && by >= minY && by <= maxY && bz >= minZ && bz <= maxZ);
  }
}
