// Track loading: decode, BPM + beat-phase detection, waveform peaks, and procedurally rendered demo tracks.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = {
  minpent: [0, 3, 5, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};
export const noteName = (midi) => NOTE_NAMES[midi % 12];

function peaks(buffer, n = 600) {
  const d = buffer.getChannelData(0), step = Math.floor(d.length / n), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * step, e = j + step; j < e; j += 16) { const v = Math.abs(d[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}

// Onset envelope from a low-passed copy (kick drum), then comb-filter search for tempo and phase.
async function detectBeat(buffer) {
  const sr = 11025, len = Math.min(buffer.duration, 150);
  const off = new OfflineAudioContext(1, Math.ceil(len * sr), sr);
  const src = off.createBufferSource(); src.buffer = buffer;
  const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
  src.connect(lp); lp.connect(off.destination); src.start();
  const x = (await off.startRendering()).getChannelData(0);
  const hop = 110, fps = sr / hop;                     // ~100 frames/s
  const nF = Math.floor(x.length / hop), env = new Float32Array(nF);
  let prev = 0;
  for (let f = 0; f < nF; f++) {
    let e = 0; for (let i = f * hop, end = i + hop; i < end; i++) e += x[i] * x[i];
    e = Math.sqrt(e / hop);
    env[f] = Math.max(0, e - prev); prev = e;
  }
  const comb = (bpm, phase) => {
    const period = fps * 60 / bpm; let s = 0, n = 0;
    for (let p = phase; p < nF - 1; p += period) { const i = Math.floor(p), fr = p - i; s += env[i] * (1 - fr) + env[i + 1] * fr; n++; }
    return s / Math.max(1, n);
  };
  const best = (lo, hi, stp) => {
    let bb = 0, bs = -1, bp = 0;
    for (let bpm = lo; bpm <= hi; bpm += stp) {
      const period = fps * 60 / bpm;
      for (let ph = 0; ph < period; ph += 1) { const s = comb(bpm, ph); if (s > bs) { bs = s; bb = bpm; bp = ph; } }
    }
    return [bb, bp];
  };
  let [bpm] = best(85, 175, 0.5);
  if (bpm < 100) bpm *= 2;
  let phase; [bpm, phase] = best(bpm - 0.6, bpm + 0.6, 0.02);
  return { bpm: Math.round(bpm * 100) / 100, firstBeat: phase / fps };
}

export async function trackFromFile(ctx, file) {
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const { bpm, firstBeat } = await detectBeat(buffer);
  return { name: file.name.replace(/\.[^.]+$/, ''), buffer, bpm, firstBeat, root: null, scale: null,
           peaks: peaks(buffer), source: 'file' };
}

// ---------- demo tracks, rendered offline so the fly has something to play with out of the box ----------

const DEMOS = [
  { name: 'Proboscis Extension', bpm: 124, root: 45, scale: 'minor', seed: 3, hats: 0.8, bassPat: 'offbeat' },
  { name: 'Giant Fiber Escape', bpm: 126, root: 41, scale: 'phrygian', seed: 7, hats: 1.0, bassPat: 'rolling' },
  { name: 'Moonwalker DN', bpm: 122, root: 50, scale: 'dorian', seed: 11, hats: 0.6, bassPat: 'offbeat' },
  { name: 'Johnston\'s Organ', bpm: 128, root: 43, scale: 'minor', seed: 5, hats: 1.0, bassPat: 'rolling' },
];
export const demoCount = DEMOS.length;

function rng(seed) { let s = seed * 2654435761 >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export async function renderDemo(i) {
  const D = DEMOS[i], sr = 44100, bars = 48, spb = 60 / D.bpm, lead = 0.5;
  const len = lead + bars * 4 * spb + 2;
  const ctx = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
  const R = rng(D.seed), sc = SCALES[D.scale];
  const master = ctx.createDynamicsCompressor(); master.threshold.value = -10; master.ratio.value = 4;
  master.connect(ctx.destination);
  const bus = ctx.createGain(); bus.gain.value = 0.8; bus.connect(master);
  const noise = ctx.createBuffer(1, sr, sr); { const d = noise.getChannelData(0); for (let k = 0; k < sr; k++) d[k] = Math.random() * 2 - 1; }
  const deg = (d, oct) => D.root + 12 * oct + sc[((d % sc.length) + sc.length) % sc.length] + 12 * Math.floor(d / sc.length);

  const kick = (t) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(1.0, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + 0.42);
  };
  const hat = (t, v, open, pan) => {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain(), p = ctx.createStereoPanner(); p.pan.value = pan;
    g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.22 : 0.05));
    s.connect(f); f.connect(g); g.connect(p); p.connect(bus); s.start(t, R()); s.stop(t + 0.25);
  };
  const clap = (t) => {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    for (const d of [0, 0.012, 0.024]) { g.gain.setValueAtTime(0.5, t + d); g.gain.exponentialRampToValueAtTime(0.05, t + d + 0.011); }
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    s.connect(f); f.connect(g); g.connect(bus); s.start(t, R()); s.stop(t + 0.22);
  };
  const bass = (t, m, dur) => {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = mtof(m);
    f.type = 'lowpass'; f.Q.value = 6; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(140, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f); f.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.02);
  };
  const stab = (t, notes, dur, pan) => {
    const f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
    f.type = 'lowpass'; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(500, t + dur); f.Q.value = 3;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    p.pan.value = pan; f.connect(g); g.connect(p); p.connect(bus);
    for (const m of notes) for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.02);
    }
  };
  const pluck = (t, m, pan) => {
    const o = ctx.createOscillator(), mo = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.frequency.value = mtof(m); mo.frequency.value = mtof(m) * 2; mg.gain.setValueAtTime(mtof(m) * 3, t); mg.gain.exponentialRampToValueAtTime(1, t + 0.2);
    mo.connect(mg); mg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.004); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    p.pan.value = pan; o.connect(g); g.connect(p); p.connect(bus); o.start(t); mo.start(t); o.stop(t + 0.4); mo.stop(t + 0.4);
  };

  // arrangement: intro 8 (drums) | build 8 (+bass) | main 16 (+stabs, arp) | break 4 | main 8 | outro 4
  const prog = [0, 0, 5, 3].map((x) => x + Math.floor(R() * 2) * 0);
  const arp = Array.from({ length: 16 }, () => Math.floor(R() * 8));
  for (let bar = 0; bar < bars; bar++) {
    const sec = bar < 8 ? 'intro' : bar < 16 ? 'build' : bar < 32 ? 'main' : bar < 36 ? 'break' : bar < 44 ? 'main' : 'outro';
    const chordRoot = prog[Math.floor(bar / 2) % 4];
    for (let b = 0; b < 4; b++) {
      const t = lead + (bar * 4 + b) * spb;
      if (sec !== 'break') kick(t);
      if (sec !== 'intro' && sec !== 'break' && (b === 1 || b === 3)) clap(t);
      for (let s = 0; s < 4; s++) {
        const ts = t + s * spb / 4;
        if (sec !== 'break') hat(ts, D.hats * (s === 2 ? 1 : 0.45), s === 2 && bar % 2 === 1, s % 2 ? -0.35 : 0.35);
        if (sec === 'build' || sec === 'main' || sec === 'outro') {
          const play = D.bassPat === 'offbeat' ? s === 2 : s !== 0;
          if (play) bass(ts, deg(chordRoot, -2) + (s === 3 && D.bassPat === 'rolling' ? 12 : 0), spb / 4 * 0.9);
        }
        if ((sec === 'main' || sec === 'break') && bar % 4 >= 2) {
          const k = (b * 4 + s);
          if (R() < 0.55) pluck(ts, deg(chordRoot + arp[k], 1), (k % 2 ? 0.5 : -0.5));
        }
      }
      if ((sec === 'main' || sec === 'break') && (b === 0 || (b === 2 && bar % 2)))
        stab(t + (b === 2 ? spb / 2 : 0), [deg(chordRoot, 0), deg(chordRoot + 2, 0), deg(chordRoot + 4, 0)], spb * (sec === 'break' ? 3 : 0.8), b ? 0.3 : -0.3);
    }
  }
  const buffer = await ctx.startRendering();
  return { name: D.name, buffer, bpm: D.bpm, firstBeat: lead, root: D.root, scale: D.scale, peaks: peaks(buffer),
           source: 'demo', key: `${noteName(D.root)} ${D.scale}` };
}
