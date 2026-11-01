// ============================================================
// RepoVerse — Ambient score
// An original, procedurally generated dark orchestral loop (Web Audio API, no audio files).
// Browsers only allow sound after a user gesture, so it fades in on the first click / tap / key.
// Press "M" to mute or unmute. Pauses while the tab is hidden.
// ============================================================

(function () {
  'use strict';

  const BPM = 88;
  const EIGHTH = 60 / BPM / 2;
  const BAR = EIGHTH * 8;
  const LOOKAHEAD = 0.25;          // seconds scheduled ahead
  const MASTER_LEVEL = 0.42;

  let ctx = null;
  let master, comp, reverb, reverbSend, dry;
  let started = false;
  let muted = false;
  let nextStep = 0;                // eighth-note counter
  let nextTime = 0;
  let timer = null;

  const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);

  // Four-bar harmony in D minor: Dm · B♭ · Gm · A  (roots as MIDI)
  const PROGRESSION = [
    { root: 38, chord: [50, 53, 57] },        // D minor
    { root: 34, chord: [46, 50, 53] },        // B♭ major
    { root: 31, chord: [43, 46, 50] },        // G minor
    { root: 33, chord: [45, 49, 52] },        // A major (tension back to Dm)
  ];

  // Eighth-note ostinato, as semitone offsets from the bar's root (an octave up)
  const OSTINATO = [0, 0, 3, 0, 7, 0, 5, 3];

  // ── Setup ───────────────────────────────────────────────
  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.4;

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(comp).connect(ctx.destination);

    dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);

    reverb = ctx.createConvolver();
    reverb.buffer = impulse(4.2, 2.6);
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.55;
    reverbSend.connect(reverb).connect(master);

    startDrone();
  }

  // Synthetic hall reverb: decaying stereo noise
  function impulse(seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function out(node, wet = 0.4) {
    node.connect(dry);
    const s = ctx.createGain();
    s.gain.value = wet;
    node.connect(s).connect(reverbSend);
  }

  // ── Layers ──────────────────────────────────────────────
  // Low D drone that breathes under everything
  function startDrone() {
    const bus = ctx.createGain();
    bus.gain.value = 0.11;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    lp.Q.value = 1.5;
    lp.connect(bus);
    out(bus, 0.5);

    [[26, -6], [26, 5], [38, -3], [45, 4]].forEach(([m, cents]) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(m);
      o.detune.value = cents;
      o.connect(lp);
      o.start();
    });

    // Slow filter swell
    const lfo = ctx.createOscillator();
    const lfoAmt = ctx.createGain();
    lfo.frequency.value = 0.045;
    lfoAmt.gain.value = 110;
    lfo.connect(lfoAmt).connect(lp.frequency);
    lfo.start();
  }

  // Bowed-string-like staccato for the ostinato
  function stringNote(t, midi, vel) {
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(2200, t);
    f.frequency.exponentialRampToValueAtTime(380, t + 0.28);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09 * vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + EIGHTH * 0.95);
    f.connect(g);
    out(g, 0.35);
    [0, 7].forEach(cents => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(midi);
      o.detune.value = cents;
      o.connect(f);
      o.start(t);
      o.stop(t + EIGHTH + 0.05);
    });
  }

  // Slow high pad holding the bar's chord
  function pad(t, chord, len) {
    chord.forEach((m, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const trem = ctx.createOscillator();
      const tremAmt = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = hz(m + 12);
      o.detune.value = (i - 1) * 6;
      trem.frequency.value = 4.5 + i * 0.3;
      tremAmt.gain.value = 0.006;
      trem.connect(tremAmt).connect(g.gain);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.022, t + 1.6);
      g.gain.setValueAtTime(0.022, t + len - 1.2);
      g.gain.linearRampToValueAtTime(0.0001, t + len + 0.8);
      o.connect(g);
      out(g, 0.8);
      o.start(t); trem.start(t);
      o.stop(t + len + 1); trem.stop(t + len + 1);
    });
  }

  // Deep brass "hit" that blooms and fades
  function brass(t, root) {
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    f.type = 'lowpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(140, t);
    f.frequency.exponentialRampToValueAtTime(1700, t + 0.45);
    f.frequency.exponentialRampToValueAtTime(220, t + 4.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
    f.connect(g);
    out(g, 0.7);
    [root - 12, root, root + 7, root + 12].forEach((m, i) => {
      [-8, 8].forEach(cents => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(m);
        o.detune.value = cents + i;
        o.connect(f);
        o.start(t);
        o.stop(t + 5.6);
      });
    });
  }

  // Low heartbeat thump
  function heartbeat(t, strength) {
    [0, 0.24].forEach((dt, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const tt = t + dt;
      o.type = 'sine';
      o.frequency.setValueAtTime(68, tt);
      o.frequency.exponentialRampToValueAtTime(38, tt + 0.25);
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime((i ? 0.18 : 0.28) * strength, tt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.45);
      o.connect(g);
      out(g, 0.15);
      o.start(tt);
      o.stop(tt + 0.5);
    });
  }

  // Faint metallic tick, like a distant clock
  let noiseBuf = null;
  function tick(t, level) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = noiseBuf;
    f.type = 'bandpass';
    f.frequency.value = 4200;
    f.Q.value = 6;
    g.gain.setValueAtTime(0.05 * level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(f).connect(g);
    out(g, 0.3);
    src.start(t);
  }

  // ── Arrangement ─────────────────────────────────────────
  // Six 8-bar sections that cycle forever, so the loop keeps evolving
  const SECTIONS = [
    { pad: 1, heart: 1 },                                   // emerge
    { pad: 1, heart: 1, ost: 0.7 },                         // pulse starts
    { pad: 1, heart: 1, ost: 1, brass: 1, tick: 1 },        // rising
    { pad: 1, heart: 1, ost: 1, brass: 1, tick: 1, oct: 1 },// full
    { pad: 1 },                                             // breath
    { heart: 1, ost: 0.85, brass: 1 },                      // return
  ];

  function scheduleStep(step, t) {
    const barIndex = Math.floor(step / 8);
    const inBar = step % 8;
    const section = SECTIONS[Math.floor(barIndex / 8) % SECTIONS.length];
    const harmony = PROGRESSION[barIndex % PROGRESSION.length];

    if (inBar === 0) {
      if (section.pad) pad(t, harmony.chord, BAR);
      if (section.brass && barIndex % 4 === 0) brass(t, harmony.root);
    }
    if (section.heart && (inBar === 0 || inBar === 4)) heartbeat(t, inBar === 0 ? 1 : 0.6);
    if (section.ost) {
      const accent = inBar === 0 || inBar === 4 ? 1 : 0.7;
      stringNote(t, harmony.root + 12 + OSTINATO[inBar], section.ost * accent);
      if (section.oct && inBar % 2 === 0) stringNote(t, harmony.root + 24 + OSTINATO[inBar], 0.35);
    }
    if (section.tick && inBar % 2 === 0) tick(t, inBar === 0 ? 1 : 0.5);
  }

  function scheduler() {
    while (nextTime < ctx.currentTime + LOOKAHEAD) {
      scheduleStep(nextStep, nextTime);
      nextStep++;
      nextTime += EIGHTH;
    }
  }

  // ── Control ─────────────────────────────────────────────
  function fadeTo(level, seconds) {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(level, now + seconds);
  }

  function start() {
    if (started) return;
    started = true;
    try {
      build();
    } catch (err) {
      return; // Web Audio unavailable: stay silent
    }
    ctx.resume();
    nextTime = ctx.currentTime + 0.1;
    timer = setInterval(scheduler, 50);
    fadeTo(muted ? 0 : MASTER_LEVEL, 6);
    ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.removeEventListener(ev, start, true));
  }

  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, start, true));

  // "M" toggles sound (ignored while typing in a field)
  window.addEventListener('keydown', e => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    muted = !muted;
    if (ctx) fadeTo(muted ? 0 : MASTER_LEVEL, 0.8);
  });

  // Don't play to an empty room
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else {
      ctx.resume();
      // Skip anything that piled up while suspended
      nextTime = Math.max(nextTime, ctx.currentTime + 0.05);
    }
  });
})();
