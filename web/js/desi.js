// Desi crate: bhangra / tabla / dholak grooves, synthesized sample-by-sample.
// Plucked strings (tumbi, sitar, tanpura) are Karplus-Strong with meend (glide) and a jawari-style buzz.

import { SCALES, noteName, peaks, rng, mtof, DEMO_CUES, finishStems } from './tracks.js';

const SR = 44100;
const TAU = 2 * Math.PI;

// ---------------------------------------------------------------- instruments

export function ksPluck(freq, dur, { decay = 0.996, bright = 0.3, buzz = 0, glide = 0, glideTime = 0.12 } = {}) {
  const N = Math.floor(dur * SR), out = new Float32Array(N);
  const L = 4096, d = new Float32Array(L);
  const P0 = SR / (freq * Math.pow(2, glide / 12));
  let w = 0, prev = 0, lp = 0, hpIn = 0, hp = 0;
  for (let n = 0; n < N; n++) {
    const semis = glide ? glide * Math.exp(-n / SR / glideTime) : 0;
    const P = SR / (freq * Math.pow(2, semis / 12));
    const rp = w - P, i0 = Math.floor(rp), fr = rp - i0;
    const a = d[((i0 % L) + L) % L], b = d[(((i0 + 1) % L) + L) % L];
    const s = a + (b - a) * fr;
    let y = decay * (bright * s + (1 - bright) * 0.5 * (s + prev));
    prev = s;
    if (n < P0) { lp += 0.6 * (Math.random() * 2 - 1 - lp); y += lp; }
    d[w % L] = y; w++;
    let o = y;
    if (buzz) {                      // jawari: rectified, high-passed copy of the string adds the sitar rasp
      const r = Math.abs(y); hp = 0.97 * (hp + r - hpIn); hpIn = r;
      o += buzz * hp * 1.5;
    }
    out[n] = o * Math.min(1, n / 40);
  }
  return out;
}

function env(N, fn) { const o = new Float32Array(N); for (let n = 0; n < N; n++) o[n] = fn(n / SR, n); return o; }

// dhol bass side (dagga): pitched thump that drops, plus the leather slap
export function dagga(tune = 1) {
  let ph = 0, lp = 0;
  return env(Math.floor(0.5 * SR), (t) => {
    const f = (58 + 60 * Math.exp(-t / 0.035)) * tune;
    ph += TAU * f / SR;
    lp += 0.2 * (Math.random() * 2 - 1 - lp);
    return (Math.sin(ph) * Math.exp(-t / 0.2) + 0.3 * Math.sin(ph * 3.1) * Math.exp(-t / 0.05) + lp * Math.exp(-t / 0.012) * 1.2) * 0.9;
  });
}
// dhol treble side (tilli): thin stick crack
export function tilli(tune = 1) {
  let hp = 0, xp = 0;
  return env(Math.floor(0.22 * SR), (t) => {
    const x = Math.random() * 2 - 1; hp = 0.6 * (hp + x - xp); xp = x;
    return (Math.sin(TAU * 410 * tune * t) * Math.exp(-t / 0.06) + 0.6 * Math.sin(TAU * 670 * tune * t) * Math.exp(-t / 0.04)
      + 0.35 * Math.sin(TAU * 1130 * tune * t) * Math.exp(-t / 0.03) + hp * Math.exp(-t / 0.004) * 0.8) * 0.55;
  });
}
// tabla dayan strokes: harmonic ringing membrane (f, 2f, 3f, 4f)
function dayan(f, len) {
  let hp = 0, xp = 0;
  return env(Math.floor(len * 1.2 * SR), (t) => {
    const ff = f * (1 + 0.02 * Math.exp(-t / 0.01));
    const x = Math.random() * 2 - 1; hp = 0.5 * (hp + x - xp); xp = x;
    return (Math.sin(TAU * ff * t) * Math.exp(-t / len) + 0.55 * Math.sin(TAU * 2 * ff * t) * Math.exp(-t / (len * 0.6))
      + 0.35 * Math.sin(TAU * 3 * ff * t) * Math.exp(-t / (len * 0.4)) + 0.2 * Math.sin(TAU * 4.02 * ff * t) * Math.exp(-t / (len * 0.25))
      + hp * Math.exp(-t / 0.003) * 0.4) * 0.45;
  });
}
// tabla bayan "ghe": the wrist presses the head so the pitch bends up
function bayan() {
  let ph = 0;
  return env(Math.floor(0.7 * SR), (t) => {
    const f = 78 + 50 * (1 - Math.exp(-t / 0.12));
    ph += TAU * f / SR;
    return Math.sin(ph) * Math.exp(-t / 0.35) * 0.9;
  });
}
function ka() {
  let lp = 0;
  return env(Math.floor(0.12 * SR), (t) => { lp += 0.15 * (Math.random() * 2 - 1 - lp); return (lp * 2 + Math.sin(TAU * 150 * t)) * Math.exp(-t / 0.025) * 0.6; });
}
function kick() {
  let ph = 0;
  return env(Math.floor(0.4 * SR), (t) => { ph += TAU * (45 + 100 * Math.exp(-t / 0.03)) / SR; return Math.sin(ph) * Math.exp(-t / 0.13) * 0.9; });
}
function clap() {
  let lp = 0, hp = 0, xp = 0;
  return env(Math.floor(0.22 * SR), (t) => {
    const x = Math.random() * 2 - 1; hp = 0.8 * (hp + x - xp); xp = x; lp += 0.35 * (hp - lp);
    let e = Math.exp(-t / 0.06) * 0.6;
    for (const d of [0, 0.011, 0.022]) if (t >= d && t < d + 0.01) e = Math.max(e, Math.exp(-(t - d) / 0.004));
    return lp * e * 0.55;
  });
}
// harmonium: reed partials with bellows tremolo
function harmonium(freqs, dur) {
  return env(Math.floor((dur + 0.15) * SR), (t) => {
    let s = 0;
    for (const f of freqs) for (let k = 1; k <= 7; k++) s += Math.sin(TAU * f * k * t + k) / (k * (k % 2 ? 1 : 1.6));
    const a = Math.min(1, t / 0.07) * (t > dur ? Math.exp(-(t - dur) / 0.05) : 1);
    return s * a * (1 + 0.08 * Math.sin(TAU * 5.5 * t)) * 0.06 / Math.sqrt(freqs.length);
  });
}
function sub(f, dur) {
  return env(Math.floor(dur * SR), (t) => Math.sin(TAU * f * t) * Math.min(1, t / 0.005) * Math.exp(-t / (dur * 0.6)) * 0.55);
}

// ---------------------------------------------------------------- tracks

const DESI = [
  { name: 'Dhol Descending Neuron', bpm: 116, root: 50, raga: 'kafi', seed: 21, groove: 'chaal', lead: 'tumbi' },
  { name: 'Tabla Theka Connectome', bpm: 120, root: 49, raga: 'yaman', seed: 22, groove: 'keherwa', lead: 'sitar' },
  { name: 'Bhairav in the Mushroom Body', bpm: 118, root: 52, raga: 'bhairav', seed: 23, groove: 'dholak', lead: 'sitar', halftime: true },
  { name: 'Proboscis Dhamaal', bpm: 124, root: 48, raga: 'khamaj', seed: 24, groove: 'chaal', lead: 'tumbi', disco: true },
];
export const desiCount = DESI.length;

export async function renderDesi(i, over = {}) {
  const D = { ...DESI[i], ...over }, bars = 48, spb = 60 / D.bpm, lead = 0.5;
  const N = Math.ceil((lead + bars * 4 * spb + 3) * SR);
  const L = new Float32Array(N), Rt = new Float32Array(N), DL = new Float32Array(N), DR = new Float32Array(N);
  const R = rng(D.seed), sc = SCALES[D.raga];
  const drumBufs = new Set();                    // anything in here goes to the drums stem
  const deg = (d, oct = 0) => D.root + 12 * oct + sc[((d % sc.length) + sc.length) % sc.length] + 12 * Math.floor(d / sc.length);
  const add = (buf, t, gain = 1, pan = 0) => {
    const n0 = Math.floor(t * SR), gl = gain * (pan > 0 ? 1 - pan : 1), gr = gain * (pan < 0 ? 1 + pan : 1);
    const a = drumBufs.has(buf) ? DL : L, b = drumBufs.has(buf) ? DR : Rt;
    for (let k = 0, m = Math.min(buf.length, N - n0); k < m; k++) { a[n0 + k] += buf[k] * gl; b[n0 + k] += buf[k] * gr; }
  };
  const cache = new Map();
  const pluck = (kind, m, opts) => {
    const key = `${kind}${m}${opts.glide || 0}`;
    if (!cache.has(key)) cache.set(key, ksPluck(mtof(m), opts.dur, opts));
    return cache.get(key);
  };

  const tune = D.groove === 'dholak' ? 1.35 : 1;
  const S = { dg: dagga(tune), tl: tilli(tune), na: dayan(mtof(D.root + 12), 0.5), tin: dayan(mtof(D.root + 12), 0.12),
              ge: bayan(), ka: ka(), kick: kick(), clap: clap() };
  for (const b of Object.values(S)) drumBufs.add(b);

  // tumbi hook: one bar of 16ths, repeated, varied every other bar
  const hookSteps = [0, 2, 3, 4, 6, 8, 10, 11, 12, 14];
  const hook = hookSteps.map(() => [0, 0, 1, 2, 3, 4, 4, 5, 7][Math.floor(R() * 9)]);
  const hookAlt = hook.map((d, k) => (k >= 7 ? d + [1, 2, -1][Math.floor(R() * 3)] : d));
  // sitar phrase: random walk through the raga over two bars of 8ths, with meend on leaps
  const phrase = []; { let d = 4; for (let k = 0; k < 16; k++) { d += [-2, -1, -1, 0, 1, 1, 2][Math.floor(R() * 7)]; d = Math.max(0, Math.min(11, d)); phrase.push(R() < 0.6 ? d : null); } phrase[15] = 7; }

  for (let bar = 0; bar < bars; bar++) {
    const sec = bar < 8 ? 'intro' : bar < 16 ? 'build' : bar < 32 ? 'main' : bar < 36 ? 'break' : bar < 44 ? 'main' : 'outro';
    const t0 = lead + bar * 4 * spb, fill = bar % 8 === 7;
    const drums = sec !== 'break' || bar % 2 === 1;

    // tanpura drone: Pa Sa Sa Sa (low)
    [D.root - 5, D.root, D.root, D.root - 12].forEach((m, b) =>
      add(pluck('tan', m, { dur: 2.2, decay: 0.9993, bright: 0.15, buzz: 0.7 }), t0 + b * spb, sec === 'break' ? 0.22 : 0.12, b % 2 ? 0.4 : -0.4));

    // hand percussion
    if (drums && D.groove === 'chaal') {
      // 12 triplet-16th slots per half bar, "dhin-ka dhin-ka" swing
      const s6 = spb / 6;
      const dg = fill ? [0, 3, 9] : [0, 6, 9], tl = fill ? [1, 2, 4, 5, 6, 7, 8, 10, 11] : [2, 3, 5, 8, 11];
      for (const b of [0, 1]) for (const k of dg) add(S.dg, t0 + b * 2 * spb + k * s6, 0.9, -0.1);
      for (const b of [0, 1]) for (const k of tl) add(S.tl, t0 + b * 2 * spb + k * s6, k % 3 === 2 ? 0.8 : 0.5, 0.15);
    } else if (drums && D.groove === 'keherwa') {
      // Dha Ge Na Ti | Na Ka Dhi Na  (8 matras over one bar of 8ths)
      const theka = [['na', 'ge'], ['ge'], ['na'], ['tin'], ['na'], ['ka'], ['tin', 'ge'], ['na']];
      theka.forEach((strokes, k) => strokes.forEach((st) => add(S[st], t0 + k * spb / 2, st === 'ge' ? 0.8 : 0.7, st === 'ge' ? -0.2 : 0.2)));
      if (fill) for (let k = 0; k < 8; k++) add(S.tin, t0 + 2 * spb + k * spb / 4, 0.4 + k * 0.05, 0.2);
    } else if (drums && D.groove === 'dholak') {
      const s16 = spb / 4;
      for (const k of [0, 3, 8, 11]) add(S.dg, t0 + k * s16, 0.85, -0.1);
      for (const k of [4, 12]) add(S.tl, t0 + k * s16, 0.9, 0.15);
      for (const k of (fill ? [1, 2, 5, 6, 7, 9, 10, 13, 14, 15] : [2, 6, 7, 10, 14, 15])) add(S.tl, t0 + k * s16, 0.3, 0.25);
    }

    if (sec === 'intro' && bar < 4) continue;
    // kick / clap / sub
    const floor = sec === 'build' || sec === 'main' || sec === 'outro';
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * spb;
      if (floor) {
        if (D.halftime) { if (b === 0 || b === 2) add(S.kick, t, 0.9); if (b === 2 && sec === 'main') add(S.clap, t, 0.9); }
        else { add(S.kick, t, sec === 'build' ? 0.7 : 0.9); if ((b === 1 || b === 3) && sec === 'main') add(S.clap, t, 0.7); }
        add(sub(mtof(deg(b === 3 && D.disco ? 4 : 0, -2)), spb * 0.9), t + (D.disco ? spb / 2 : 0), 0.8);
      }
    }
    // harmonium chords in the break and under the disco track
    if (sec === 'break' || (D.disco && sec === 'main' && bar % 2 === 0)) {
      const c = [0, 3, 4, 0][Math.floor(bar / 2) % 4];
      add(harmonium([deg(c), deg(c + 2), deg(c + 4)].map(mtof), spb * (sec === 'break' ? 3.8 : 1.8)), t0, 0.9);
    }
    // lead
    if (sec === 'main' || sec === 'break') {
      if (D.lead === 'tumbi') {
        const h = bar % 2 ? hookAlt : hook;
        // call and response: the hook plays 4 bars, then rests 4 bars; an octave lower and warmer than a raw tumbi
        if (sec === 'main' && bar % 8 < 4)
          hookSteps.forEach((st, k) => add(pluck('tb', deg(h[k], 1), { dur: 0.5, decay: 0.994, bright: 0.3 }), t0 + st * spb / 4, 0.4, 0.25));
      } else {
        const half = bar % 2;
        for (let k = 0; k < 8; k++) {
          const d = phrase[half * 8 + k];
          if (d === null) continue;
          const prev = phrase[half * 8 + k - 1];
          const glide = prev != null && Math.abs(prev - d) >= 2 ? -2 : (R() < 0.2 ? -1 : 0);
          add(pluck('sit', deg(d, 1), { dur: 1.6, decay: 0.998, bright: 0.25, buzz: 0.5, glide, glideTime: 0.09 }), t0 + k * spb / 2, 0.5, -0.2);
        }
      }
    }
    if (bar % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }

  const { buffer, stems } = finishStems(L, Rt, DL, DR, SR, 1.4);
  return { name: D.name, buffer, stems, bpm: D.bpm, firstBeat: lead, root: D.root, scale: D.raga, peaks: peaks(buffer),
           source: 'demo', style: 'desi', key: `${noteName(D.root)} raag ${D.raga}`, cues: DEMO_CUES };
}
