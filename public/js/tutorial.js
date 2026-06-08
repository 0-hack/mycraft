// First-time interactive tutorial overlay. Pure instructional cards (no effect
// on the live world) with a Skip option. Text adapts to touch vs desktop.
import { isTouchDevice } from './mobile.js';

const KEY = 'vc_tutorial';
export const tutorialSeen = () => localStorage.getItem(KEY) === '1';

export class Tutorial {
  constructor() { this._init = false; this.i = 0; this.steps = []; }

  _build() {
    const t = isTouchDevice();
    const k = (touch, desk) => (t ? touch : desk);
    this.steps = [
      { icon: '🏙️', title: 'Welcome to Marina City!',
        body: 'A blocky multiplayer metropolis of glass towers, neon supertrees and a marina bay. Mine the skyline for steel, glass &amp; marble, build your base, fight monsters that roam the streets, and level up. Here\'s a 1-minute tour — tap Skip anytime.' },
      { icon: '🕹️', title: 'Move & look',
        body: k('Use the <b>left joystick</b> to walk. <b>Drag the right side</b> of the screen to look; a quick <b>tap on the right = jump</b>.',
                'Walk with <b>WASD</b> or <b>arrow keys</b>, hold <b>Shift</b> to sprint, <b>Space</b> to jump. Click the screen, then move the <b>mouse</b> to look.') },
      { icon: '🧍', title: 'See yourself',
        body: k('Tap <b>👁</b> to switch between first-person and third-person view to admire your character & gear.',
                'Press <b>V</b> to toggle first-person / third-person view to see your character & gear.') },
      { icon: '⛏️', title: 'Mine blocks',
        body: k('Aim at a block and <b>hold the ⛏ button</b> to mine it.', 'Aim at a block and <b>hold left-click</b> to mine it.') +
              ' Tougher blocks take longer — a pickaxe is faster. Mined blocks become <b>materials</b> you can sell.' },
      { icon: '🧱', title: 'Build',
        body: k('Pick a block from the <b>hotbar</b> (tap a slot), then tap <b>🧱</b> to place it.',
                'Pick a block from the <b>hotbar</b> (number keys or scroll), then <b>right-click</b> to place it.') +
              ' Salvage towers for <b>steel, marble &amp; neon</b>, then build walls to protect your loot!' },
      { icon: '⚔️', title: 'Fight monsters',
        body: 'Aim at a monster and ' + k('tap <b>⛏</b>', '<b>left-click</b>') +
              ' to attack. On the minimap, <span style="color:#e25555">red dots</span> are monsters. ' +
              '<b style="color:#6fcf6f">Slimes are harmless</b> — perfect first targets for easy XP & loot!' },
      { icon: '✨', title: 'Class skills',
        body: k('Tap the <b>skill buttons</b> above the hotbar to cast your 3 class skills.',
                'Press <b>Z / X / C</b> to cast your 3 class skills.') +
              ' Learn & upgrade them in <b>Bag → Skills</b> using skill points.' },
      { icon: '⚔️', title: 'Your weapon & axe',
        body: 'Your class starts with the weapon that suits it (a mage gets a <b>wand</b>, an archer a <b>bow</b>, and so on). ' +
              k('Tap <b>hotbar slot 1</b> again to swap between your weapon and your <b>🪓 axe</b>.',
                'Press <b>1</b> (or tap slot 1) to swap between your weapon and your <b>🪓 axe</b> — handy for chopping & mining.') },
      { icon: '🎒', title: 'Bag, Character & Settings',
        body: k('Open your <b>🎒 Bag</b> (sell materials, equip gear, craft), your <b>⭐ Character</b> (spend attribute & skill points), and <b>⚙ Settings</b> from the top bar.',
                'Keys: <b>B</b> = Bag (sell, gear, craft), <b>K</b> = Character (spend <b>attribute &amp; skill points</b>), <b>O</b> = Settings. You can also click the top-bar buttons.') },
      { icon: '⭐', title: 'Level up',
        body: 'Earn <b>XP</b> by mining, building and fighting. Every level grants <b>attribute points</b> (Strength, Dexterity, etc.) ' +
              'and a <b>skill point</b> — spend them in the Bag to grow your chosen class.' },
      { icon: '💀', title: 'Risk & survival',
        body: 'When you die, your <b>cash & materials drop</b> where you fell — anyone can grab them. Pick up <b>🩹 medkits</b> & <b>🍗 food</b> to recover. ' +
              'Set a custom <b>📍 respawn point</b> from <b>⚙ Settings</b> so you come back where you choose. ' +
              'A <b>boss</b> appears now and then: <b>dodge its red slam circle!</b>' },
      { icon: '✅', title: 'You\'re ready!',
        body: 'New players get a few seconds of <b>spawn protection</b>. ' + k('Mute sound from the Bag.', 'Press <b>M</b> to mute, <b>Enter</b> to chat.') +
              ' Reopen this guide anytime from <b>Bag → How to play</b>. Have fun!' },
    ];
  }

  _once() {
    if (this._init) return;
    this._init = true;
    this.el = document.getElementById('tutorial');
    document.getElementById('tut-skip').onclick = () => this.close();
    document.getElementById('tut-back').onclick = () => this.go(this.i - 1);
    document.getElementById('tut-next').onclick = () => {
      if (this.i >= this.steps.length - 1) this.close();
      else this.go(this.i + 1);
    };
  }

  open() { this._once(); this._build(); this.i = 0; this.el.classList.remove('hidden'); this.render(); }
  close() { if (this.el) this.el.classList.add('hidden'); localStorage.setItem(KEY, '1'); }
  go(n) { this.i = Math.max(0, Math.min(this.steps.length - 1, n)); this.render(); }

  render() {
    const s = this.steps[this.i];
    document.getElementById('tut-icon').textContent = s.icon;
    document.getElementById('tut-title').textContent = s.title;
    document.getElementById('tut-body').innerHTML = s.body;
    document.getElementById('tut-back').style.visibility = this.i === 0 ? 'hidden' : 'visible';
    document.getElementById('tut-next').textContent = this.i >= this.steps.length - 1 ? '▶ Play' : 'Next';
    document.getElementById('tut-dots').innerHTML =
      this.steps.map((_, j) => `<span class="${j === this.i ? 'on' : ''}"></span>`).join('');
  }
}
