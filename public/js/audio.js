// Procedural sound effects via the Web Audio API — no asset files, so the game
// stays fully offline. Synthesizes short blips/noise for game events.
let ctx = null, master = null;
let enabled = localStorage.getItem('vc_sound') !== '0';

function ensure() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
}

// Browsers require a user gesture before audio can start.
export function resume() { ensure(); if (ctx && ctx.state === 'suspended') ctx.resume(); }
export function isEnabled() { return enabled; }
export function setEnabled(v) { enabled = !!v; localStorage.setItem('vc_sound', enabled ? '1' : '0'); if (enabled) resume(); }
export function toggle() { setEnabled(!enabled); return enabled; }

function env(g, t, a, d, peak) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function tone({ freq = 440, type = 'sine', dur = 0.15, gain = 0.3, attack = 0.005, slideTo = null, delay = 0 }) {
  if (!enabled) return; ensure(); if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  env(g, t, attack, dur, gain);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + attack + dur + 0.03);
}
function noise({ dur = 0.2, gain = 0.3, type = 'lowpass', freq = 1000, delay = 0 }) {
  if (!enabled) return; ensure(); if (!ctx) return;
  const t = ctx.currentTime + delay;
  const n = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * dur), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  n.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
  const g = ctx.createGain(); env(g, t, 0.004, dur, gain);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + dur + 0.03);
}
const arp = (notes, { type = 'square', dur = 0.14, gain = 0.22, step = 0.09 } = {}) =>
  notes.forEach((f, i) => tone({ freq: f, type, dur, gain, delay: i * step }));

const SFX = {
  swing: () => noise({ dur: 0.1, gain: 0.14, type: 'highpass', freq: 900 }),
  hit: () => { tone({ freq: 170, type: 'square', dur: 0.08, gain: 0.22, slideTo: 90 }); noise({ dur: 0.07, gain: 0.12, freq: 500 }); },
  break: () => noise({ dur: 0.18, gain: 0.22, type: 'lowpass', freq: 1100 }),
  place: () => tone({ freq: 300, type: 'square', dur: 0.08, gain: 0.16, slideTo: 380 }),
  hurt: () => tone({ freq: 220, type: 'sawtooth', dur: 0.18, gain: 0.24, slideTo: 110 }),
  heal: () => { tone({ freq: 520, type: 'sine', dur: 0.18, gain: 0.2, slideTo: 880 }); },
  pickup: () => { tone({ freq: 660, type: 'square', dur: 0.07, gain: 0.18 }); tone({ freq: 990, type: 'square', dur: 0.1, gain: 0.18, delay: 0.07 }); },
  coin: () => { tone({ freq: 880, type: 'square', dur: 0.06, gain: 0.18 }); tone({ freq: 1320, type: 'square', dur: 0.09, gain: 0.18, delay: 0.06 }); },
  level: () => arp([523, 659, 784, 1047]),
  craft: () => { tone({ freq: 320, type: 'square', dur: 0.05, gain: 0.2 }); noise({ dur: 0.07, gain: 0.18, type: 'bandpass', freq: 2200, delay: 0.04 }); },
  skillMagic: () => tone({ freq: 300, type: 'sine', dur: 0.3, gain: 0.22, slideTo: 1300 }),
  skillRanged: () => tone({ freq: 950, type: 'square', dur: 0.12, gain: 0.2, slideTo: 300 }),
  skillMelee: () => { noise({ dur: 0.2, gain: 0.22, freq: 600 }); tone({ freq: 130, type: 'square', dur: 0.16, gain: 0.18 }); },
  skillBuff: () => arp([392, 523, 659], { dur: 0.12, step: 0.06 }),
  mobDie: () => tone({ freq: 200, type: 'sawtooth', dur: 0.2, gain: 0.18, slideTo: 60 }),
  death: () => arp([440, 330, 220, 160], { type: 'sawtooth', dur: 0.25, gain: 0.24, step: 0.12 }),
  boss: () => { tone({ freq: 90, type: 'sawtooth', dur: 0.7, gain: 0.3, slideTo: 55 }); tone({ freq: 120, type: 'square', dur: 0.6, gain: 0.18, delay: 0.1 }); },
  bossWin: () => arp([523, 659, 784, 1047, 1319], { dur: 0.16, step: 0.1 }),
  warn: () => { tone({ freq: 300, type: 'square', dur: 0.5, gain: 0.16, slideTo: 600 }); },
  slam: () => { noise({ dur: 0.35, gain: 0.3, type: 'lowpass', freq: 320 }); tone({ freq: 80, type: 'sawtooth', dur: 0.3, gain: 0.28, slideTo: 40 }); },
};

export function play(name) { const f = SFX[name]; if (f) f(); }

// ---------------------------------------------------------------- background music
// A gentle, procedural ambient loop (no asset files). A slow chord pad plus a
// sparse arpeggio melody, scheduled a beat ahead so it stays glitch-free.
let musicOn = localStorage.getItem('vc_music') !== '0';
let musicGain = null;       // dedicated bus so music volume is independent of SFX
let musicTimer = null;
let musicStep = 0;
const BEAT = 0.5;           // seconds per step (~120 BPM feel, halved)
// A wistful i–VI–III–VII progression in A minor (root notes, Hz).
const CHORDS = [
  [220.00, 261.63, 329.63], // Am
  [174.61, 220.00, 261.63], // F
  [261.63, 329.63, 392.00], // C
  [196.00, 246.94, 293.66], // G
];
const MELODY = [440.00, 523.25, 659.25, 587.33, 523.25, 440.00, 392.00, 493.88];

export function musicEnabled() { return musicOn; }

function musicTick() {
  if (!musicOn || !ctx) return;
  const t = ctx.currentTime + 0.05;
  const bar = (musicStep >> 3) % CHORDS.length;   // change chord every 8 steps
  const chord = CHORDS[bar];
  // Soft pad: hold the chord across the start of each bar.
  if (musicStep % 8 === 0) {
    for (const f of chord) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(f, t);
      const dur = BEAT * 8;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.6);
      g.gain.linearRampToValueAtTime(0.04, t + dur - 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(musicGain);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }
  // Sparse arpeggio melody, every other step.
  if (musicStep % 2 === 0) {
    const f = MELODY[(musicStep >> 1) % MELODY.length];
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f, t);
    const dur = BEAT * 1.4;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + dur + 0.05);
  }
  musicStep = (musicStep + 1) % (8 * CHORDS.length);
}

export function startMusic() {
  if (!musicOn) return;
  ensure();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (!musicGain) { musicGain = ctx.createGain(); musicGain.gain.value = 0.6; musicGain.connect(master); }
  if (musicTimer) return; // already running
  musicStep = 0;
  musicTick();
  musicTimer = setInterval(musicTick, BEAT * 1000);
}
export function stopMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
}
export function setMusicEnabled(v) {
  musicOn = !!v;
  localStorage.setItem('vc_music', musicOn ? '1' : '0');
  if (musicOn) startMusic(); else stopMusic();
}
export function toggleMusic() { setMusicEnabled(!musicOn); return musicOn; }
