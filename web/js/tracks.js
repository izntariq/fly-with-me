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
  // half-tempo check (drum & bass often reads as 86): if the full-band hits (snares, hats) land on the
  // off-beats about as hard as on the beats, the real tempo is double
  if (bpm < 110) {
    const full = buffer.getChannelData(0), fh = Math.round(buffer.sampleRate / fps);
    const envF = new Float32Array(nF); let pf = 0;
    for (let f = 0; f < nF; f++) {
      let e = 0; for (let i = f * fh, end = Math.min(full.length, i + fh); i < end; i += 4) e += full[i] * full[i];
      e = Math.sqrt(e / (fh / 4)); envF[f] = Math.max(0, e - pf); pf = e;
    }
    const combF = (ph) => { const per = fps * 60 / bpm; let s = 0, n = 0; for (let p = ph; p < nF - 1; p += per) { s += envF[Math.floor(p)]; n++; } return s / Math.max(1, n); };
    const onB = combF(phase), offB = combF(phase + fps * 30 / bpm);
    if (offB > 0.75 * onB) bpm *= 2;
  }
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

// ---------------- analysed beat grid + song structure (All-In-One, from the server: /analysis/<sha1>) ----------------
// The in-browser beat tracker gets the tempo octave or the bar phase wrong on about half of real songs. When the server
// knows a track (the user's library is analysed offline), its downbeats give the bar grid and its sections the
// structure: intro / verse / chorus / break / outro per bar, and hot cues on real section starts.
const SECTION_OF = { start: 'intro', intro: 'intro', verse: 'verse', chorus: 'chorus', inst: 'chorus', solo: 'chorus',
  bridge: 'break', break: 'break', outro: 'outro', end: 'outro' };

export async function sha1(buf) {
  const h = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// least-squares line y = b + m x
const linfit = (xs, ys) => {
  const n = xs.length, mx = xs.reduce((p, q) => p + q, 0) / n, my = ys.reduce((p, q) => p + q, 0) / n;
  let sxy = 0, sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  const m = sxy / sxx;
  return { m, b: my - m * mx };
};

// robust bar grid through downbeat times. Numbering the downbeats 0, 1, 2 ... breaks on one missed or extra downbeat:
// every later index shifts and skews the whole fit, even the tempo. So number them by their spacing (bar by bar, then
// against the fitted grid), fit a line, and refit without the outliers. off: the share of downbeats that are neither
// on the line nor at a half bar (the tracker adds those in places; they cost nothing, and neither do bars with no
// downbeat at all, as in a beatless breakdown): what a fixed grid can't explain
function barGrid(db) {
  const gaps = db.slice(1).map((v, i) => v - db[i]).sort((p, q) => p - q), med = gaps[gaps.length >> 1];
  let idx = [0];
  for (let i = 1; i < db.length; i++) idx.push(idx[i - 1] + Math.round((db[i] - db[i - 1]) / med));   // 0: an extra
  let fit = linfit(idx, db), keep = idx.map(() => true);
  for (let pass = 0; pass < 2; pass++) {
    idx = db.map((y) => Math.round((y - fit.b) / fit.m));
    keep = idx.map((k, i) => Math.abs(db[i] - (fit.b + fit.m * k)) < fit.m / 4);
    if (keep.filter(Boolean).length < 8) break;
    fit = linfit(idx.filter((_, i) => keep[i]), db.filter((_, i) => keep[i]));
  }
  const on = new Set(idx.filter((_, i) => keep[i])), nIn = keep.filter(Boolean).length;
  const drift = Math.sqrt(db.reduce((p, y, i) => p + (keep[i] ? (y - (fit.b + fit.m * idx[i])) ** 2 : 0), 0) / Math.max(1, nIn));
  const off = db.filter((y, i) => { const f = Math.abs((y - fit.b) / fit.m - idx[i]); return !keep[i] && Math.abs(f - 0.5) >= 0.125; }).length / db.length;
  return { ...fit, drift, off, bars: on.size };
}

export function applyAnalysis(t, a) {
  const db = (a.downbeats || []).filter((x) => x >= 0);
  if (db.length < 8) return false;
  // the analysis must be of this very recording: a different file (another edit, a name clash) would carry another
  // song's structure
  const end = a.segments?.length ? a.segments[a.segments.length - 1].end : db[db.length - 1];
  if (Math.abs(end - t.buffer.duration) > 3) { t.analysisRejected = 'length mismatch'; return false; }
  // a track that changes tempo (a beat switch, a half-time section) has no one grid; then fit its end, where the
  // DJ mixes out, and cut rather than blend
  let fit, part = 1;
  for (part of [1, 0.5, 0.3]) { fit = barGrid(db.slice(Math.floor(db.length * (1 - part)))); if (fit.off <= 0.1 && fit.bars >= 8) break; }
  const t0 = db[Math.floor(db.length * (1 - part))];
  if (!(fit.off <= 0.1 && fit.bars >= 8)) { t.analysisRejected = 'no steady grid'; return false; }
  // beats per bar: 3 for waltzes and 6/8 ballads (the app counts 4-beat bars, so these get the beat tempo and no
  // phrase-matched blends), else 4
  const bt = (a.beats || []).filter((x) => x >= t0), bg = bt.slice(1).map((v, i) => v - bt[i]).sort((p, q) => p - q);
  const bpb = bg.length > 8 && Math.round(fit.m / bg[bg.length >> 1]) === 3 ? 3 : 4;
  const bpm = 60 * bpb / fit.m, drift = fit.drift;
  if (!(bpm > 50 && bpm < 220)) { t.analysisRejected = 'tempo'; return false; }
  const bar = 240 / bpm;                                           // the app's 4-beat bar
  let first = fit.b;
  first -= Math.floor(first / bar) * bar;                          // the first bar line at or after 0 s
  t.appGrid = { bpm: t.bpm, firstBeat: t.firstBeat };
  t.bpm = Math.round(bpm * 100) / 100; t.firstBeat = first; t.gridDrift = drift; t.gridSource = 'analysed'; t.meter = bpb;
  // the tempo really moves (live drummers, rubato, metre changes): a fixed grid drifts off by more than 1/16 bar, so
  // beat-matched blends would drift out of time; the DJ cuts in and out of these instead
  t.steady = part === 1 && bpb === 4 && drift <= fit.m / 16 && fit.off <= 0.05;
  const nb = Math.max(1, Math.floor((t.buffer.duration - first) / bar));
  const segs = (a.segments || []).map((g) => [g.start, g.end, SECTION_OF[g.label] || 'verse']);
  t.sections = Array.from({ length: nb }, (_, b) => {
    const m = first + (b + 0.5) * bar, g = segs.find(([s0, s1]) => m >= s0 && m < s1);
    return g ? g[2] : (segs.length && m >= segs[segs.length - 1][1] ? 'outro' : 'intro');
  });
  t.energy = analyzeEnergy(t.buffer, t.bpm, t.firstBeat).energy;
  // hot cues on real section starts: intro, the 8 bars before the first chorus, the first chorus, the first break after it
  const startOf = (b0, pred) => { for (let b = b0; b < nb; b++) if (pred(t.sections[b]) && (b === 0 || !pred(t.sections[b - 1]))) return b; return -1; };
  const drop = startOf(1, (x) => x === 'chorus'), brk = drop >= 0 ? startOf(drop, (x) => x === 'break') : -1;
  t.cues = [{ name: 'intro', beat: 0 }];
  if (drop > 0) t.cues.push({ name: 'build', beat: Math.max(0, drop - 8) * 4 }, { name: 'drop', beat: drop * 4 });
  if (brk > 0) t.cues.push({ name: 'break', beat: brk * 4 });
  // the exit, planned so the mix finishes before the track does:
  //   an outro of 10+ bars: blend across it from its first bar
  //   a short outro (pop songs: median 4 bars): echo out right as the last verse / chorus ends
  //   no outro at all: blend from the 4-bar line ~12 bars before the end
  let last = -1; t.sections.forEach((x, b) => { if (x === 'verse' || x === 'chorus') last = b; });
  const outro = last + 1, room = nb - outro;
  if (last >= 0 && outro >= nb * 0.5 && room >= 10) { t.mixBar = outro; t.exit = 'blend'; }
  else if (last >= 0 && outro >= nb * 0.5 && room >= 2) { t.mixBar = outro; t.exit = 'echo'; }
  else { const m = Math.max(0, nb - 12); t.mixBar = m - (m % 4); t.exit = 'blend'; }
  return true;
}

export const safeName = (s) => String(s).replace(/</g, '‹').replace(/>/g, '›');

export async function trackFromFile(ctx, file) {
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const { bpm, firstBeat } = await detectBeat(buffer);
  // track names end up in HTML (log, crate): angle brackets become look-alikes so a file name can never be markup
  const name = safeName(file.name.replace(/\.[^.]+$/, ''));
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

// Master a rendered track: the full mix plus two stems (drums / music) with identical gain and saturation,
// so playing the stems together sounds like the mix and either can be muted.
export function finishStems(L, R, DL, DR, sr, drive = 1.3) {
  const N = L.length;
  let peak = 0;
  for (let n = 0; n < N; n++) peak = Math.max(peak, Math.abs(L[n] + DL[n]), Math.abs(R[n] + DR[n]));
  const g = 0.9 / Math.max(peak, 1e-6) * drive, sat = (x) => Math.tanh(x * g) * 0.85;
  const mk = () => new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: sr });
  const mix = mk(), drums = mk(), music = mk();
  const ch = (a, b) => { const o = new Float32Array(N); for (let n = 0; n < N; n++) o[n] = sat(a[n] + (b ? b[n] : 0)); return o; };
  mix.copyToChannel(ch(L, DL), 0); mix.copyToChannel(ch(R, DR), 1);
  drums.copyToChannel(ch(DL), 0); drums.copyToChannel(ch(DR), 1);
  music.copyToChannel(ch(L), 0); music.copyToChannel(ch(R), 1);
  return { buffer: mix, stems: { drums, music } };
}

export function rng(seed) { let s = seed * 2654435761 >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Direct sample-level synthesis (fast: a 90 s track renders in well under a second).
// `over` lets training render variations: another seed, tempo or key ({ seed, bpm, root, name })
export async function renderDemo(i, over = {}) {
  const D = { ...DEMOS[i], ...over }, sr = 44100, bars = 48, spb = 60 / D.bpm, lead = 0.5;
  const N = Math.ceil((lead + bars * 4 * spb + 2) * sr);
  const L = new Float32Array(N), Rt = new Float32Array(N), DL = new Float32Array(N), DR = new Float32Array(N);
  const R = rng(D.seed), sc = SCALES[D.scale];
  const deg = (d, oct) => D.root + 12 * oct + sc[((d % sc.length) + sc.length) % sc.length] + 12 * Math.floor(d / sc.length);
  const put = (n, v, pan, drum = false) => {
    if (n >= N) return;
    const a = drum ? DL : L, b = drum ? DR : Rt;
    a[n] += v * (1 - Math.max(0, pan)); b[n] += v * (1 + Math.min(0, pan));
  };

  const kick = (t) => {
    let ph = 0; const n0 = Math.floor(t * sr);
    for (let k = 0; k < 0.4 * sr; k++) {
      const tt = k / sr, f = 45 + 105 * Math.exp(-tt / 0.03);
      ph += 2 * Math.PI * f / sr;
      put(n0 + k, Math.sin(ph) * Math.exp(-tt / 0.13) * 0.95, 0, true);
    }
  };
  const hat = (t, v, open, pan) => {
    const n0 = Math.floor(t * sr), len = (open ? 0.25 : 0.06) * sr, dec = open ? 0.07 : 0.014;
    let y = 0, xp = 0;
    for (let k = 0; k < len; k++) {
      const x = Math.random() * 2 - 1; y = 0.45 * (y + x - xp); xp = x;
      put(n0 + k, y * v * 0.35 * Math.exp(-k / sr / dec), pan, true);
    }
  };
  const clap = (t) => {
    const n0 = Math.floor(t * sr); let lo = 0, hp = 0, xp = 0;
    for (let k = 0; k < 0.22 * sr; k++) {
      const tt = k / sr, x = Math.random() * 2 - 1;
      hp = 0.8 * (hp + x - xp); xp = x; lo += 0.35 * (hp - lo);
      let e = Math.exp(-tt / 0.06) * 0.6;
      for (const d of [0, 0.011, 0.022]) if (tt >= d && tt < d + 0.01) e = Math.max(e, Math.exp(-(tt - d) / 0.004));
      put(n0 + k, lo * e * 0.6, 0, true);
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
  const { buffer, stems } = finishStems(L, Rt, DL, DR, sr, 1.3);
  return { name: D.name, buffer, stems, bpm: D.bpm, firstBeat: lead, root: D.root, scale: D.scale, peaks: peaks(buffer),
           source: 'demo', style: 'club', key: `${noteName(D.root)} ${D.scale}`, cues: DEMO_CUES };
}
