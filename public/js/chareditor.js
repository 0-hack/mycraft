// Character customisation screen: a rotating 3D preview plus controls for
// hairstyle, face, accessories and per-part colours, with a randomise button.
import * as THREE from 'three';
import {
  buildCharacter, defaultAppearance, randomAppearance, normalizeAppearance,
  HAIR_STYLES, FACES, ACCESSORIES, BAGS,
} from './character.js';
import { CLASSES } from './rpg.js';

const FIELDS = ['skin', 'hair', 'hairColor', 'face', 'shirt', 'pants', 'shoes',
  'accessory', 'accessoryColor', 'bag', 'bagColor'];

export class CharacterEditor {
  constructor() {
    this.appearance = defaultAppearance();
    this.onSave = null;
    this._inited = false;
    this._running = false;
    this._rot = 0;
    this._auto = true;
  }

  _initOnce() {
    if (this._inited) return;
    this._inited = true;
    this.el = document.getElementById('character');
    const canvas = document.getElementById('char-canvas');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121a30);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 1.25, 3.4);
    this.camera.lookAt(0, 1.05, 0);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.group = null;

    fillSelect('c-hair', HAIR_STYLES);
    fillSelect('c-face', FACES);
    fillSelect('c-accessory', ACCESSORIES);
    fillSelect('c-bag', BAGS);

    const classSel = document.getElementById('c-class');
    classSel.innerHTML = Object.entries(CLASSES)
      .map(([id, c]) => `<option value="${id}">${c.icon} ${c.name}</option>`).join('');
    const showClassDesc = () => {
      this.cls = classSel.value;
      document.getElementById('c-class-desc').textContent = CLASSES[this.cls].desc;
    };
    classSel.onchange = showClassDesc;
    this._showClassDesc = showClassDesc;
    this._classSel = classSel;

    for (const id of FIELDS) {
      const node = document.getElementById('c-' + id);
      const apply = () => { this.appearance[id] = node.value; this._rebuild(); };
      node.addEventListener('input', apply);
      node.addEventListener('change', apply);
    }
    document.getElementById('c-random').onclick = () => {
      this.appearance = randomAppearance(); this._sync(); this._rebuild();
    };
    document.getElementById('c-save').onclick = () => {
      const a = normalizeAppearance(this.appearance);
      const cls = this.cls;
      this.close();
      if (this.onSave) this.onSave(a, cls);
    };

    // Drag to spin (pauses auto-rotate).
    let dragging = false, lastX = 0;
    canvas.addEventListener('pointerdown', (e) => { dragging = true; this._auto = false; lastX = e.clientX; });
    addEventListener('pointermove', (e) => {
      if (dragging) { this._rot += (e.clientX - lastX) * 0.01; lastX = e.clientX; }
    });
    addEventListener('pointerup', () => { dragging = false; });

    addEventListener('resize', () => this._resize());
  }

  _sync() {
    for (const id of FIELDS) document.getElementById('c-' + id).value = this.appearance[id];
  }
  _rebuild() {
    if (this.group) this.scene.remove(this.group);
    // Preview the look only (bare hands, no armor).
    this.group = buildCharacter(this.appearance, { weapon: 'fist', weapons: {} });
    this.scene.add(this.group);
  }
  _resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || 320, h = c.clientHeight || 360;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  open(appearance, cls, onSave) {
    this._initOnce();
    this.appearance = normalizeAppearance(appearance || randomAppearance());
    this.onSave = onSave;
    this.cls = CLASSES[cls] ? cls : 'soldier';
    this._classSel.value = this.cls;
    this._showClassDesc();
    this._auto = true;
    this._sync();
    this._rebuild();
    this.el.classList.remove('hidden');
    this._resize();
    if (!this._running) { this._running = true; this._loop(); }
  }
  close() { this.el.classList.add('hidden'); this._running = false; }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());
    if (this._auto) this._rot += 0.01;
    if (this.group) this.group.rotation.y = this._rot;
    this.renderer.render(this.scene, this.camera);
  }
}

function fillSelect(id, list) {
  document.getElementById(id).innerHTML = list
    .map((v) => `<option value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('');
}
