// Track loading: decode, BPM + beat-phase detection, waveform peaks, and procedurally rendered demo tracks.

import { analyzeTrack, analyzeEnergy, camelot, camelotName } from './analysis.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = {
  minpent: [0, 3, 5, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  // ragas (as scales; Kafi = dorian, Bhairavi = phrygian, Khamaj = mixolydian)
  kafi: [0, 2, 3, 5, 7, 9, 10],
  bhairav: [0, 1, 4, 5, 7, 8, 11],
  yaman: [0, 2, 4, 6, 7, 9, 11],
  bhairavi: [0, 1, 3, 5, 7, 8, 10],
  khamaj: [0, 2, 4, 5, 7, 9, 10],
  majpent: [0, 2, 4, 7, 9],
};
export const noteName = (midi) => NOTE_NAMES[midi % 12];

export function peaks(buffer, n = 600) {
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
  // 85–175 covers hip-hop through drum & bass without folding
  let [bpm] = best(85, 175, 0.5);
  let phase; [bpm, phase] = best(bpm - 0.6, bpm + 0.6, 0.02);
  return { bpm: Math.round(bpm * 100) / 100, firstBeat: phase / fps };
}

// Hot cues on phrase lines, from the per-bar energy: the biggest jump is the drop, the quietest stretch after it the break.
export function findCues(buffer, bpm, firstBeat) {
  const d = buffer.getChannelData(0), sr = buffer.sampleRate, barLen = 4 * 60 / bpm;
  const nBars = Math.floor((buffer.duration - firstBeat) / barLen), E = [];
  for (let b = 0; b < nBars; b++) {
    let s = 0, n = 0;
    for (let i = Math.floor((firstBeat + b * barLen) * sr), e = i + Math.floor(barLen * sr); i < e; i += 16) { s += d[i] * d[i]; n++; }
    E.push(Math.sqrt(s / n));
  }
  const mean = (a, b) => { let s = 0; for (let i = Math.max(0, a); i < Math.min(nBars, b); i++) s += E[i]; return s / Math.max(1, Math.min(nBars, b) - Math.max(0, a)); };
  let drop = Math.min(16, nBars - 1), best = -1;
  for (let b = 8; b < nBars - 4; b += 4) { const j = mean(b, b + 4) - mean(b - 4, b); if (j > best) { best = j; drop = b; } }
  let brk = Math.min(nBars - 4, drop + 16), low = Infinity;
  for (let b = drop + 8; b < nBars - 4; b += 4) { const m = mean(b, b + 4); if (m < low) { low = m; brk = b; } }
  return [{ name: 'intro', beat: 0 }, { name: 'build', beat: Math.max(0, drop - 8) * 4 }, { name: 'drop', beat: drop * 4 }, { name: 'break', beat: brk * 4 }];
}

// the arrangement every demo track uses: intro 8 | build 8 | main 16 | break 4 | main 8 | outro 4 (bars)
export const DEMO_CUES = [{ name: 'intro', beat: 0 }, { name: 'build', beat: 32 }, { name: 'drop', beat: 64 }, { name: 'break', beat: 128 }, { name: 'drop 2', beat: 144 }];

export async function trackFromFile(ctx, file) {
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const { bpm, firstBeat } = await detectBeat(buffer);
  const name = file.name.replace(/\.[^.]+$/, '');
  const a = analyzeTrack(buffer, name, bpm, firstBeat);
  return { name, buffer, bpm, firstBeat, peaks: peaks(buffer), source: 'file', cues: findCues(buffer, bpm, firstBeat),
           root: 45 + ((a.key.pc - 9 + 12) % 12), scale: a.key.mode === 'minor' ? 'minpent' : 'majpent',
           mode: a.key.mode, camelot: a.camelot, energy: a.energy, style: a.style,
           key: `${a.key.name} · ${camelotName(a.camelot)} · ${a.style}` };
}

// fill in analysis fields for tracks whose key we already know (the synthesized demos)
export function describeDemo(t) {
  const sc = SCALES[t.scale] || SCALES.minor, mode = sc.includes(3) ? 'minor' : 'major';
  t.mode = mode;
  t.camelot = camelot(t.root % 12, mode);
  t.energy = analyzeEnergy(t.buffer, t.bpm, t.firstBeat).energy;
  t.key = `${t.key} · ${camelotName(t.camelot)}`;
  return t;
}

// ---------- demo tracks, rendered offline so the fly has something to play with out of the box ----------

const DEMOS = [
  { name: 'Proboscis Extension', bpm: 124, root: 45, scale: 'minor', seed: 3, hats: 0.8, bassPat: 'offbeat' },
  { name: 'Giant Fiber Escape', bpm: 126, root: 41, scale: 'phrygian', seed: 7, hats: 1.0, bassPat: 'rolling' },
  { name: 'Moonwalker DN', bpm: 122, root: 50, scale: 'dorian', seed: 11, hats: 0.6, bassPat: 'offbeat' },
  { name: 'Johnston\'s Organ', bpm: 128, root: 43, scale: 'minor', seed: 5, hats: 1.0, bassPat: 'rolling' },
];
export const demoCount = DEMOS.length;

export function rng(seed) { let s = seed * 2654435761 >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Direct sample-level synthesis (fast: a 90 s track renders in well under a second).
export async function renderDemo(i) {
  const D = DEMOS[i], sr = 44100, bars = 48, spb = 60 / D.bpm, lead = 0.5;
  const N = Math.ceil((lead + bars * 4 * spb + 2) * sr);
  const L = new Float32Array(N), Rt = new Float32Array(N);
  const R = rng(D.seed), sc = SCALES[D.scale];
  const deg = (d, oct) => D.root + 12 * oct + sc[((d % sc.length) + sc.length) % sc.length] + 12 * Math.floor(d / sc.length);
  const put = (n, v, pan) => { if (n < N) { L[n] += v * (1 - Math.max(0, pan)); Rt[n] += v * (1 + Math.min(0, pan)); } };

  const kick = (t) => {
    let ph = 0; const n0 = Math.floor(t * sr);
    for (let k = 0; k < 0.4 * sr; k++) {
      const tt = k / sr, f = 45 + 105 * Math.exp(-tt / 0.03);
      ph += 2 * Math.PI * f / sr;
      put(n0 + k, Math.sin(ph) * Math.exp(-tt / 0.13) * 0.95, 0);
    }
  };
  const hat = (t, v, open, pan) => {
    const n0 = Math.floor(t * sr), len = (open ? 0.25 : 0.06) * sr, dec = open ? 0.07 : 0.014;
    let y = 0, xp = 0;
    for (let k = 0; k < len; k++) {
      const x = Math.random() * 2 - 1; y = 0.45 * (y + x - xp); xp = x;
      put(n0 + k, y * v * 0.35 * Math.exp(-k / sr / dec), pan);
    }
  };
  const clap = (t) => {
    const n0 = Math.floor(t * sr); let lo = 0, hp = 0, xp = 0;
    for (let k = 0; k < 0.22 * sr; k++) {
      const tt = k / sr, x = Math.random() * 2 - 1;
      hp = 0.8 * (hp + x - xp); xp = x; lo += 0.35 * (hp - lo);
      let e = Math.exp(-tt / 0.06) * 0.6;
      for (const d of [0, 0.011, 0.022]) if (tt >= d && tt < d + 0.01) e = Math.max(e, Math.exp(-(tt - d) / 0.004));
      put(n0 + k, lo * e * 0.6, 0);
    }
  };
  // Chamberlin state-variable low-pass with exponential cutoff sweep
  const svfVoice = (t, freqs, dur, f0, f1, q, amp, pan, wave) => {
    const n0 = Math.floor(t * sr), len = Math.floor(dur * sr);
    const ph = freqs.map(() => Math.random());
    let low = 0, band = 0;
    for (let k = 0; k < len; k++) {
      const tt = k / sr;
      let x = 0;
      for (let j = 0; j < freqs.length; j++) { ph[j] = (ph[j] + freqs[j] / sr) % 1; x += wave === 'saw' ? 2 * ph[j] - 1 : (ph[j] < 0.5 ? 1 : -1); }
      x /= Math.sqrt(freqs.length);
      const fc = f0 * Math.pow(f1 / f0, Math.min(1, tt / dur)), f = 2 * Math.sin(Math.PI * Math.min(fc, sr / 7) / sr);
      low += f * band; const high = x - low - q * band; band += f * high;
      const env = Math.min(1, tt / 0.004) * Math.exp(-tt / (dur * 0.45));
      put(n0 + k, low * env * amp, pan);
    }
  };
  const bass = (t, m, dur) => svfVoice(t, [mtof(m)], dur, 1000, 130, 0.25, 0.4, 0, 'saw');
  const stab = (t, notes, dur, pan) => svfVoice(t, notes.flatMap((m) => [mtof(m) * 0.996, mtof(m) * 1.004]), dur, 3200, 450, 0.4, 0.14, pan, 'saw');
  const pluck = (t, m, pan) => {
    const n0 = Math.floor(t * sr), f = mtof(m);
    for (let k = 0; k < 0.35 * sr; k++) {
      const tt = k / sr, I = 3 * Math.exp(-tt / 0.06);
      put(n0 + k, Math.sin(2 * Math.PI * f * tt + I * Math.sin(2 * Math.PI * 2 * f * tt)) * Math.exp(-tt / 0.09) * 0.1, pan);
    }
  };

  // arrangement: intro 8 (drums) | build 8 (+bass) | main 16 (+stabs, arp) | break 4 | main 8 | outro 4
  const prog = [0, 0, 5, 3];
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
          const k = b * 4 + s;
          if (R() < 0.55) pluck(ts, deg(chordRoot + arp[k], 1), k % 2 ? 0.5 : -0.5);
        }
      }
      if ((sec === 'main' || sec === 'break') && (b === 0 || (b === 2 && bar % 2)))
        stab(t + (b === 2 ? spb / 2 : 0), [deg(chordRoot, 0), deg(chordRoot + 2, 0), deg(chordRoot + 4, 0)], spb * (sec === 'break' ? 3 : 0.8), b ? 0.3 : -0.3);
    }
    if (bar % 4 === 3) await new Promise((r) => setTimeout(r, 0));   // stay responsive
  }
  let peak = 0;
  for (let n = 0; n < N; n++) peak = Math.max(peak, Math.abs(L[n]), Math.abs(Rt[n]));
  const g = 0.9 / Math.max(peak, 1e-6);
  for (let n = 0; n < N; n++) { L[n] = Math.tanh(L[n] * g * 1.3) * 0.85; Rt[n] = Math.tanh(Rt[n] * g * 1.3) * 0.85; }
  const buffer = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: sr });
  buffer.copyToChannel(L, 0); buffer.copyToChannel(Rt, 1);
  return { name: D.name, buffer, bpm: D.bpm, firstBeat: lead, root: D.root, scale: D.scale, peaks: peaks(buffer),
           source: 'demo', style: 'club', key: `${noteName(D.root)} ${D.scale}`, cues: DEMO_CUES };
}
