// Sound effects for the board. Table sounds are recorded clips from Kenney's CC0 packs (Casino Audio,
// Impact Sounds; board/sfx/*.ogg, licenses there); interface sounds (turn, win/lose) and anything whose
// clip hasn't loaded yet are synthesized with the Web Audio API.
// window.Sfx.play(name, delayMs) - names: shuffle, deal, draw, roll, unit, program, gear, sell, spend,
// flip, attack, block, defeat, blip, steal, turn, yourturn, win, lose. Sfx.setOn(bool) / Sfx.setVolume(0..1); both persist in
// localStorage. The audio context starts on the first click or key press (browsers require a gesture).
'use strict';
(() => {
  let ctx = null, master = null, noiseBuf = null;
  let on = localStorage.getItem('eddies_board_sound') !== 'off';
  let vol = +(localStorage.getItem('eddies_board_volume') ?? 0.6);

  function init() {
    if (ctx) return ctx.state === 'suspended' ? ctx.resume() : null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = vol;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    loadClips();
  }

  // ── recorded clips: each sound is one or more layers, each a random pick of its variants ──
  const n = (base, k, from = 1, pad = 0) => Array.from({ length: k }, (_, i) => `${base}${String(i + from).padStart(pad, '0')}.ogg`);
  const CLIPS = {
    // the user's recordings (board/sfx/user-*.mp3): `at`/`dur` cut the part we use (seconds), `exact`
    // plays at normal speed so the animations timed to them (TIMING below) stay in sync
    shuffle: [{ files: ['user-riffle-full.mp3'], at: 3.15, dur: 0.66, gain: 1, exact: true }],   // its second riffle only
    deal: [{ files: ['user-draw.mp3'], at: 0.17, dur: 0.36, gain: 0.8, exact: true }],
    draw: [{ files: ['user-draw.mp3'], at: 0.17, dur: 0.36, gain: 1, exact: true }],
    roll: [{ files: ['user-dice.mp3'], at: 0.04, dur: 0.78, gain: 1, exact: true }],
    unit: [{ files: n('card-place-', 4), gain: 0.9 }, { files: n('impactSoft_medium_', 5, 0, 3), gain: 0.5 }],
    program: [{ files: n('card-shove-', 4), gain: 0.85 }],
    gear: [{ files: n('impactMetal_light_', 5, 0, 3), gain: 0.6 }, { files: n('card-place-', 4), gain: 0.4 }],
    sell: [{ files: n('chip-lay-', 3), gain: 0.8 }],
    spend: [{ files: n('chips-collide-', 4), gain: 0.55 }],
    flip: [{ files: ['user-flip.mp3'], at: 0.30, dur: 0.47, gain: 1, exact: true }],
    attack: [{ files: n('impactPunch_medium_', 5, 0, 3), gain: 0.55 }],
    block: [{ files: n('impactPlate_medium_', 5, 0, 3), gain: 0.5 }],
    defeat: [{ files: n('impactPunch_heavy_', 5, 0, 3), gain: 0.65 }],
    blip: [{ files: n('dice-grab-', 2), gain: 0.6 }],
    steal: [{ files: n('dice-grab-', 2), gain: 0.7 }, { files: n('card-slide-', 8), gain: 0.4 }],
  };
  const buffers = new Map();   // file -> AudioBuffer (missing = not loaded / failed)
  const BASE = (document.currentScript?.src || '').replace(/[^/]*$/, '') + 'sfx/';
  function loadClips() {
    const files = new Set(Object.values(CLIPS).flat().flatMap(l => l.files));
    for (const f of files) fetch(BASE + f).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then(a => ctx.decodeAudioData(a)).then(b => buffers.set(f, b)).catch(() => { /* synth fallback */ });
  }
  // play a sound from clips at time t; false if any layer isn't loaded (then the synth plays instead)
  function clip(name, t) {
    const layers = CLIPS[name];
    if (!layers) return false;
    const picks = layers.map(l => ({ l, b: buffers.get(l.files[Math.floor(Math.random() * l.files.length)]) }));
    if (picks.some(x => !x.b)) return false;
    for (const { l, b } of picks) {
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.playbackRate.value = l.exact ? 1 : 0.94 + Math.random() * 0.12;   // a little variety between repeats
      const g = ctx.createGain();
      g.gain.value = l.gain;
      src.connect(g).connect(master);
      if (l.dur) {   // a cut: short fade at the end so it doesn't click
        g.gain.setValueAtTime(l.gain, t + l.dur - 0.04);
        g.gain.linearRampToValueAtTime(0.0001, t + l.dur);
        src.start(t, l.at || 0, l.dur);
      } else src.start(t, l.at || 0);
    }
    return true;
  }
  // when things happen inside the cut clips (ms from the sound's start) - app.js times animations to these
  const TIMING = {
    shuffle: 640,      // the riffle cascade: cards fall from 0 to ~640 ms, hardest at the end
    drawPeak: 220,     // the swish's loudest moment (card leaving the pile)
    rollSettle: 560,   // dice: the last real bounce (the die comes to rest)
    flipPeak: 220,     // the flip's snap (card edge-on)
  };
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, init, { capture: true });

  // ── building blocks ──
  function env(t, peak, attack, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(master);
    return g;
  }
  // filtered noise burst: type lowpass/bandpass/highpass, f = cutoff (Hz), optional sweep to f2
  function noise(t, { dur = 0.08, gain = 0.4, type = 'bandpass', f = 2000, f2 = null, q = 1, attack = 0.004 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const flt = ctx.createBiquadFilter();
    flt.type = type; flt.Q.value = q;
    flt.frequency.setValueAtTime(f, t);
    if (f2) flt.frequency.exponentialRampToValueAtTime(f2, t + dur);
    src.connect(flt).connect(env(t, gain, attack, dur));
    src.start(t, Math.random() * 0.5, dur + attack + 0.05);
  }
  // pitched tone, optional glide to f2
  function tone(t, { f = 440, f2 = null, dur = 0.12, gain = 0.25, type = 'sine', attack = 0.005 } = {}) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    o.connect(env(t, gain, attack, dur));
    o.start(t); o.stop(t + attack + dur + 0.05);
  }
  const jit = (x, r = 0.15) => x * (1 + (Math.random() * 2 - 1) * r);

  // ── the sounds ──
  const S = {
    // riffle: two runs of quick card flicks, a short pause, then the bridge
    shuffle(t) {
      for (let r = 0; r < 2; r++) {
        const t0 = t + r * 0.95;
        noise(t0, { dur: 0.12, gain: 0.18, type: 'lowpass', f: 900 });                 // the split
        for (let i = 0; i < 26; i++) noise(t0 + 0.22 + i * 0.018 + Math.random() * 0.006, { dur: 0.02, gain: jit(0.22, 0.3), f: jit(3200, 0.25), q: 2.5 });
        noise(t0 + 0.75, { dur: 0.09, gain: 0.25, type: 'lowpass', f: 700 });          // squared up
      }
    },
    deal(t) { noise(t, { dur: 0.13, gain: 0.16, type: 'bandpass', f: 1800, f2: 4200, q: 0.8, attack: 0.02 }); },
    draw(t) { noise(t, { dur: 0.18, gain: 0.2, type: 'bandpass', f: 1400, f2: 3800, q: 0.7, attack: 0.03 }); tone(t + 0.05, { f: 880, f2: 1320, dur: 0.12, gain: 0.05 }); },
    // dice: a rattle of clicks slowing down, then the landing
    roll(t) {
      let dt = 0;
      for (let i = 0; i < 11; i++) { dt += 0.035 + i * 0.012; noise(t + dt, { dur: 0.018, gain: jit(0.3, 0.3), f: jit(2600, 0.3), q: 4 }); tone(t + dt, { f: jit(1900, 0.2), dur: 0.02, gain: 0.04, type: 'triangle' }); }
      noise(t + dt + 0.12, { dur: 0.08, gain: 0.35, type: 'lowpass', f: 600 });
      tone(t + dt + 0.12, { f: 160, f2: 90, dur: 0.12, gain: 0.25 });
    },
    unit(t) { tone(t, { f: 120, f2: 55, dur: 0.22, gain: 0.45 }); noise(t, { dur: 0.1, gain: 0.25, type: 'lowpass', f: 900 }); tone(t + 0.02, { f: 440, f2: 660, dur: 0.15, gain: 0.05, type: 'triangle' }); },
    program(t) { tone(t, { f: 300, f2: 1400, dur: 0.22, gain: 0.12, type: 'sawtooth' }); noise(t, { dur: 0.22, gain: 0.12, type: 'highpass', f: 3000, f2: 7000 }); tone(t + 0.18, { f: 1760, dur: 0.12, gain: 0.06 }); },
    gear(t) { [620, 930, 1460].forEach((f, i) => tone(t + i * 0.004, { f: jit(f, 0.03), dur: 0.25, gain: 0.08, type: 'square' })); noise(t, { dur: 0.05, gain: 0.3, f: 4000, q: 3 }); },
    sell(t) { tone(t, { f: 1320, dur: 0.09, gain: 0.12, type: 'triangle' }); tone(t + 0.07, { f: 1980, dur: 0.22, gain: 0.12, type: 'triangle' }); },
    spend(t) { noise(t, { dur: 0.05, gain: 0.18, f: 2200, q: 2 }); tone(t, { f: 700, f2: 500, dur: 0.06, gain: 0.05, type: 'triangle' }); },
    flip(t) { [784, 988, 1319].forEach((f, i) => tone(t + i * 0.07, { f, dur: 0.3, gain: 0.09, type: 'triangle' })); noise(t, { dur: 0.1, gain: 0.12, f: 2500 }); },
    attack(t) { noise(t, { dur: 0.25, gain: 0.25, type: 'bandpass', f: 600, f2: 3000, q: 0.8, attack: 0.05 }); tone(t + 0.22, { f: 180, f2: 70, dur: 0.15, gain: 0.35 }); },
    defeat(t) { tone(t, { f: 220, f2: 40, dur: 0.45, gain: 0.35, type: 'sawtooth' }); noise(t, { dur: 0.35, gain: 0.3, type: 'lowpass', f: 1500, f2: 200 }); },
    blip(t) { tone(t, { f: 990, f2: 1180, dur: 0.08, gain: 0.08, type: 'square' }); },
    steal(t) { noise(t, { dur: 0.3, gain: 0.22, type: 'bandpass', f: 4000, f2: 600, q: 1.2, attack: 0.03 }); tone(t + 0.25, { f: 520, dur: 0.15, gain: 0.08, type: 'triangle' }); },
    // turn change: a falling two-note chime; your own turn starting: a rising one
    turn(t) { tone(t, { f: 660, dur: 0.16, gain: 0.08, type: 'triangle' }); tone(t + 0.13, { f: 495, dur: 0.26, gain: 0.08, type: 'triangle' }); },
    yourturn(t) { tone(t, { f: 523, dur: 0.14, gain: 0.1, type: 'triangle' }); tone(t + 0.12, { f: 784, dur: 0.3, gain: 0.1, type: 'triangle' }); },
    block(t) { noise(t, { dur: 0.08, gain: 0.35, type: 'lowpass', f: 1200 }); tone(t, { f: 260, f2: 200, dur: 0.12, gain: 0.2, type: 'square' }); },
    win(t) { [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.12, { f, dur: 0.35, gain: 0.12, type: 'triangle' })); },
    lose(t) { [392, 330, 262].forEach((f, i) => tone(t + i * 0.18, { f, dur: 0.4, gain: 0.12, type: 'triangle' })); },
  };

  window.Sfx = {
    TIMING,
    play(name, delayMs = 0) {
      if (!on || (!S[name] && !CLIPS[name])) return;
      init();
      if (!ctx || ctx.state !== 'running') return;   // no gesture yet
      const t = ctx.currentTime + Math.max(0, delayMs) / 1000;
      try { if (!clip(name, t)) S[name](t); } catch { /* never break the board */ }
    },
    setOn(v) { on = !!v; localStorage.setItem('eddies_board_sound', on ? 'on' : 'off'); },
    setVolume(v) { vol = Math.max(0, Math.min(1, +v)); localStorage.setItem('eddies_board_volume', vol); if (master) master.gain.value = vol; },
    get on() { return on; }, get volume() { return vol; },
    names: Object.keys(S), clips: () => buffers.size,
  };

  // the page's sound controls, if it has them: #snd-btn (on/off) and #snd-vol (0-100)
  addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('snd-btn'), rng = document.getElementById('snd-vol');
    const show = () => { if (btn) { btn.textContent = on ? '🔊' : '🔇'; btn.title = on ? 'Sound on (M)' : 'Sound off (M)'; } if (rng) rng.disabled = !on; };
    if (btn) btn.onclick = () => { window.Sfx.setOn(!on); show(); if (on) window.Sfx.play('blip'); };
    if (rng) { rng.value = Math.round(vol * 100); rng.oninput = () => window.Sfx.setVolume(rng.value / 100); rng.onchange = () => window.Sfx.play('flip'); }
    addEventListener('keydown', e => { if (e.key.toLowerCase() === 'm' && !e.target.matches?.('input, select, textarea') && !e.ctrlKey && !e.metaKey) { btn ? btn.click() : window.Sfx.setOn(!on); } });
    show();
  });
})();
