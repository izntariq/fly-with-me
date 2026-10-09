// DJ benchmark scorer, v3: grades djbench runs offline against the raw All-In-One analysis of each track (its beats,
// downbeats and sections), not against either app version's own beat grid, so two code versions are graded on the
// same reference.
//
//   node tools/djscore.mjs RUN.json             mean ± 95% CI over the file's runs, for every measure below
//   node tools/djscore.mjs A.json B.json        both, then B − A per measure, paired by run
//   node tools/djscore.mjs OLD.json@6901364     a file from before v3: also place its transitions on the All-In-One
//                                               reference through that version's grid fit (1167539 | 6901364); approximate
//   node tools/djscore.mjs --selftest           the scorer's own checks, on synthetic runs
//   DATA=<data dir> (default: ../data)   --json OUT.json (everything, machine-readable)
//
// Every decision is graded where it is heard, in track time: djbench v3 logs the deck's position (seconds into the
// track) at the moment a move or a transition sounds. From that position:
//   section     the All-In-One segment holding it (60 ms on, so a landing on a section line counts in the new section).
//               Grouped: intro (start, intro) · full (verse, chorus, inst, solo) · break (bridge, break) · outro (outro, end)
//   on_bar      within ±60 ms of an All-In-One downbeat (past ~50 ms two hits are heard as a flam)
//   on_4bar / on_8bar  within ±60 ms of a 4- / 8-bar line counted in downbeats from the start of the section it is in
//               (the next section's start is a line too): DJs phrase from section starts, not from 0 s of the file (a
//               fixed grid from 0 s meets section starts only 35–48% of the time). On a random bar line: about 1/4 and 1/8
//   bar_dev_beats / phrase_dev_beats  median distance to the nearest downbeat / 4-bar line, in beats (local beat length)
// The bar measures are what the grid and the timing deliver. The section measures stay partly circular on analysed
// tracks, since the app plans its exits and picks moves from these same segments: that is why everything is also split
// by what drove the decision.
//   transitions  exit (planned from the analysed exit) · neurons (an earlier section boundary of an analysed track,
//                chosen by the DJ fly's steering neurons) · sense (the fly's own sense or wish: a sensed outro or
//                breakdown, aversion, its preference) · cap (4 minutes on air) · ending (the track running out) ·
//                burst (the old app's aversion spinback, fired straight from a burst)
//   moves        burst (neuron-group bursts, big bursts, arousal builds, motor-neuron horns) · sense (SPACE: the fly's
//                breakdown sense) · sense_analysed (the same trigger reading the analysed sections, on an analysed
//                track) · plan (set plan)
// Transitions (fired ones; cancelled, replans and reversed (a blend the fly turned back) counted apart; unplaced: no
// analysis or no position, so not graded on the reference):
//   land_outro / land_break / land_mid / land_intro  the outgoing track's section where the incoming takes over (the
//               cut, the drop, the blend's first bar). DJs leave a track in its outro or a breakdown; mid-song is a skip,
//               and leaving from its intro means the track was barely played
//   exit_vs_outro_s  landing minus the start of the outgoing track's outro (the end of its last verse / chorus); < 0: early
//   on_bar / on_4bar / bar_dev_beats / phrase_dev_beats  the landing on the outgoing track's bar and phrase lines (a
//               cut or drop off the phrase jars)
//   in_on_bar   the incoming track's landing on its own downbeat (cued on a real bar line, not a grid's guess)
//   in_intro    the incoming comes in from its intro (a blend lays the new intro over the old outro)
//   done_before_end  the incoming fully in before the outgoing track runs out; room_s: what is left of it then
//   harmonic    Camelot-compatible keys (same, ±1, relative major / minor); tempo_change_pct: octave-folded, median
// Moves (the ones that played something):
//   per_min     moves per minute (above ~2 / min a set sounds busy: an effect every half minute is too many)
//   on_bar / on_4bar / on_8bar / bar_dev_beats / phrase_dev_beats  as above, where the move is heard
//   fit         suits its section: space and filters (echo, reverb, dub, sweep, flanger, low-pass) in calm sections
//               (intro, verse, break, outro); flourishes (rolls, scratches, gates, chops, horns ...) in full ones (verse,
//               chorus, inst, solo); builds aren't graded on it
//   variety     normalised entropy of the move types (variety_family: of move families, so echo / dub / reverb count
//               once); repeats: the same move twice in a row
//   drift_ms    track time between where a move was scheduled to sound and where it did (the tempo moving under it)
// Silences: the master output under -50 dBFS for over 0.6 s, at any time (sampled every 100 ms). Each one is
//   intended    inside what a move means to be silent, from perform.js: a build's 1-beat gap before its drop, a kill's
//               1-bar drop-out, a spinback's fade (to its cut), a tape stop; whisper: a sing-along's muffled 4 bars.
//               An echo-out means no silence: perform.js cuts to the incoming as the echo starts. Each window is padded
//               0.15 s (ramps, the ~90 ms analyser window, the 100 ms sampling)
//   track       the music itself silent there (every audible deck's own signal under -50 dBFS)
//   dead_air    no deck playing at all
//   dropout     anything else: the app silenced the music. A silence is judged by its part outside the intended
//               gaps, so a 16-bar silent build is a dropout although its last beat is meant to be silent.
//   Each kind per 10 minutes; dropouts_per_10min = dropout + dead_air; longest_dropout_s
// Time on air: how long each track is the on-air deck (crossfader on its side), transition to transition (real mixes:
//   ~4 min per track). complete: both ends seen; warmup: the first track, from the start of the run (the brain
//   settling); censored: the one still playing at the end (a lower bound); replays: a track back on air in the same run
//   (the old track cued again); ran_out_on_air: a track that ended while on air
// Load: the brain's frame load (its share of real time), sampled every second, run mean.
// Sense: the listener flies' own section sense against All-In-One: accuracy, and MIX (intro / outro), SPACE (break),
//   PEAK (chorus) as precision / recall.
// Statistics: per-run values → mean ± Student t 95% CI over runs (the run is the independent unit); proportions also
//   pooled over runs with a Wilson 95% interval (each run has few). Paired: per-run B − A, Student t over the
//   differences; pooled proportions with Newcombe's interval. Runs pair by index: the same seed gives the same crate
//   order and so the same first two tracks; later picks follow the listener's spikes, so the pairing loosens after that.
// Files from before v3 have no track positions: their label-free measures (counts, drivers, room, keys, tempo, the old
//   dropout count, time on air without the first track) are scored, and the rest is listed as not scored. Their
//   app-grid scores print as "legacy", as do v3 runs', for comparison.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TOL = 0.060, PAD = 0.15, SIL = 0.6;
const DATA = process.env.DATA || new URL('../data', import.meta.url).pathname;

// ---------------- statistics ----------------
const sum = (a) => a.reduce((p, q) => p + q, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const lgamma = (x) => {                                                     // Lanczos
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
};
const betacf = (a, b, x) => {                                               // continued fraction (Numerical Recipes)
  let c = 1, d = 1 - (a + b) * x / (a + 1); d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); let h = d;
  for (let m = 1; m <= 300; m++) {
    for (const aa of [m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m)), -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))]) {
      d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; h *= d * c;
    }
    if (Math.abs(d * c - 1) < 1e-12) break;
  }
  return h;
};
const ibeta = (x, a, b) => {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
};
const tcdf = (t, df) => { const p = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5); return t > 0 ? 1 - p : p; };
export const tinv = (p, df) => { let lo = 0, hi = 1e4; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (tcdf(m, df) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
// mean ± Student t 95% half-width over independent values
export const meanCI = (v) => {
  if (!v.length) return null;
  const m = mean(v), sd = Math.sqrt(sum(v.map((x) => (x - m) ** 2)) / Math.max(1, v.length - 1));
  return { mean: m, ci95: v.length > 1 ? tinv(0.975, v.length - 1) * sd / Math.sqrt(v.length) : null, n: v.length };
};
export const wilson = (k, n, z = 1.96) => {
  if (!n) return null;
  const p = k / n, den = 1 + z * z / n, cen = (p + z * z / (2 * n)) / den, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [cen - half, cen + half];
};
// Newcombe's hybrid score interval for p2 − p1
export const newcombe = (k1, n1, k2, n2) => {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, [l1, u1] = wilson(k1, n1), [l2, u2] = wilson(k2, n2), d = p2 - p1;
  return [d - Math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2), d + Math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2)];
};

// ---------------- the reference: All-In-One beats, downbeats and sections ----------------
const CAT = { start: 'intro', intro: 'intro', verse: 'full', chorus: 'full', inst: 'full', solo: 'full', bridge: 'break', break: 'break', outro: 'outro', end: 'outro' };
const VOC = { start: 'intro', intro: 'intro', verse: 'verse', chorus: 'chorus', inst: 'chorus', solo: 'chorus', bridge: 'break', break: 'break', outro: 'outro', end: 'outro' };   // the listener's vocabulary
const FULL = new Set(['verse', 'chorus', 'inst', 'solo']);
const lowerIdx = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo - 1; };   // last a[i] <= x
const nearest = (a, x) => { const i = lowerIdx(a, x); let best = null; for (const j of [i, i + 1]) if (j >= 0 && j < a.length && (best === null || Math.abs(a[j] - x) < Math.abs(best - x))) best = a[j]; return best; };

// a = the All-In-One json (beats, downbeats, segments, bpm)
export function makeRef(a) {
  const db = (a.downbeats || []).filter((x) => x >= 0).sort((p, q) => p - q), beats = (a.beats || []).filter((x) => x >= 0).sort((p, q) => p - q);
  const segs = (a.segments || []).map(({ start, end, label }) => ({ start, end, label })).sort((p, q) => p.start - q.start);
  const bar = median(db.slice(1).map((v, i) => v - db[i])) || 240 / (a.bpm || 120);
  const ibi = median(beats.slice(1).map((v, i) => v - beats[i])) || bar / 4;
  // phrase lines: from each section's first downbeat (within a quarter bar of its start), every n downbeats until the next
  const lines = (n) => {
    const out = new Set();
    for (const s of segs) {
      let k = lowerIdx(db, s.start - bar / 4) + 1;
      for (; k < db.length && db[k] < s.end - bar / 4; k += n) out.add(db[k]);
    }
    return [...out].sort((p, q) => p - q);
  };
  let last = null; for (const s of segs) if (FULL.has(s.label)) last = s;
  return { a, db, beats, segs, starts: segs.map((x) => x.start), bar, ibi, L4: lines(4), L8: lines(8), outroStart: last ? last.end : null, grids: {} };
}
export const sectionAt = (R, p) => {
  if (!R.segs.length) return null;
  if (p < R.segs[0].start) return 'start';
  const s = R.segs[Math.max(0, lowerIdx(R.starts, p))];
  return p < s.end ? s.label : 'end';
};
const beatLen = (R, p) => { const i = lowerIdx(R.beats, p); return i >= 0 && i + 1 < R.beats.length && R.beats[i + 1] - R.beats[i] < 2 * R.ibi ? R.beats[i + 1] - R.beats[i] : R.ibi; };
export function align(R, p) {
  if (!R.db.length) return null;
  const b = nearest(R.db, p), l4 = nearest(R.L4, p), l8 = nearest(R.L8, p), bl = beatLen(R, p);
  return { dBar: p - b, dBarBeats: (p - b) / bl, d4Beats: l4 === null ? null : (p - l4) / bl, onBar: Math.abs(p - b) <= TOL, on4: l4 !== null && Math.abs(p - l4) <= TOL, on8: l8 !== null && Math.abs(p - l8) <= TOL };
}
const refCache = new Map();
export const loadRef = (slug, data = DATA) => {
  if (!slug) return null;
  if (!refCache.has(slug)) {
    const f = `${data}/realtracks/allin1/${slug}.json`;
    refCache.set(slug, existsSync(f) ? makeRef(JSON.parse(readFileSync(f))) : null);
  }
  return refCache.get(slug);
};

// the app's grid fits, for placing pre-v3 transitions (logged as an app bar number) on the reference
const linfit = (xs, ys) => {
  const n = xs.length, mx = sum(xs) / n, my = sum(ys) / n; let sxy = 0, sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  return { m: sxy / sxx, b: my - (sxy / sxx) * mx };
};
function barGridHead(db) {                                // tracks.js barGrid from 0b07b18 to 1167539 (before Audit 4)
  const gaps = db.slice(1).map((v, i) => v - db[i]).sort((p, q) => p - q), med = gaps[gaps.length >> 1];
  let idx = [0];
  for (let i = 1; i < db.length; i++) idx.push(idx[i - 1] + Math.round((db[i] - db[i - 1]) / med));
  let fit = linfit(idx, db), keep = idx.map(() => true);
  for (let pass = 0; pass < 2; pass++) {
    idx = db.map((y) => Math.round((y - fit.b) / fit.m));
    keep = idx.map((k, i) => Math.abs(db[i] - (fit.b + fit.m * k)) < fit.m / 4);
    if (keep.filter(Boolean).length < 8) break;
    fit = linfit(idx.filter((_, i) => keep[i]), db.filter((_, i) => keep[i]));
  }
  const on = new Set(idx.filter((_, i) => keep[i]));
  const off = db.filter((y, i) => { const f = Math.abs((y - fit.b) / fit.m - idx[i]); return !keep[i] && Math.abs(f - 0.5) >= 0.125; }).length / db.length;
  return { ...fit, off, bars: on.size };
}
export function appGrid(a, version) {                                       // → { bpm, first } as the app set them
  const db = (a.downbeats || []).filter((x) => x >= 0);
  if (db.length < 8) return null;
  let bar, first;
  if (version === '6901364') { const f = linfit(db.map((_, i) => i), db); bar = f.m; first = f.b; }
  else {
    let fit, part = 1;
    for (part of [1, 0.5, 0.3]) { fit = barGridHead(db.slice(Math.floor(db.length * (1 - part)))); if (fit.off <= 0.1 && fit.bars >= 8) break; }
    if (!(fit.off <= 0.1 && fit.bars >= 8)) return null;
    const t0 = db[Math.floor(db.length * (1 - part))], bt = (a.beats || []).filter((x) => x >= t0), bg = bt.slice(1).map((v, i) => v - bt[i]).sort((p, q) => p - q);
    const bpb = bg.length > 8 && Math.round(fit.m / bg[bg.length >> 1]) === 3 ? 3 : 4;
    bar = 240 / (60 * bpb / fit.m); first = fit.b;
  }
  const bpm = 240 / bar;
  if (!(bpm > 50 && bpm < 220)) return null;
  return { bpm: Math.round(bpm * 100) / 100, first: first - Math.floor(first / bar) * bar };
}

// ---------------- what drove a decision; what suits a section ----------------
export const transDriver = (t) => t.driver || (/steering neurons/.test(t.reason || '') ? 'neurons' : /analysed\)|planned exit/.test(t.reason || '') ? 'exit' : /4 minutes/.test(t.reason || '') ? 'cap'
  : /track ending/.test(t.reason || '') ? 'ending' : t.reason ? 'sense' : 'other');
const moveDriver = (m, v3) => (!v3 ? (/^sense:/.test(m.key) ? 'sense' : 'burst')
  : m.driver === 'sense' && m.known ? 'sense_analysed' : m.driver === 'transition' ? 'burst' : m.driver || 'burst');
const SPACE3 = new Set(['echo', 'reverb', 'dub', 'wind', 'sweep', 'flange', 'flanger', 'lpf', 'resfilter']);
export const fit3 = (key, label) => {
  if (!label || key === 'build' || key === 'reject') return key === 'reject' && label ? true : null;
  return SPACE3.has(key) ? label === 'verse' || CAT[label] !== 'full' : CAT[label] === 'full';
};
const FAMILY = { echo: 'echo', reverb: 'echo', dub: 'echo', wind: 'echo', siren: 'sample', horn: 'sample', laser: 'sample', boom: 'sample', co2: 'sample', dhol: 'sample', riser: 'sample',
  flanger: 'filter', flange: 'filter', lpf: 'filter', resfilter: 'filter', sweep: 'filter', trans: 'gate', crush: 'gate', pump: 'gate',
  escape: 'roll', roll: 'roll', roll4: 'roll', roll8: 'roll', roll16: 'roll', stutter: 'roll', brake: 'roll', reverse: 'roll', backspin: 'roll',
  scratch: 'scratch', baby: 'scratch', chirp: 'scratch', flare: 'scratch', transformer: 'scratch', orbit: 'scratch', crab: 'scratch' };
const entropy = (keys) => {
  const c = {}; keys.forEach((k) => (c[k] = (c[k] || 0) + 1));
  const H = -sum(Object.values(c).map((n) => (n / keys.length) * Math.log(n / keys.length)));
  return keys.length > 1 ? H / Math.log(Math.max(2, Object.keys(c).length)) : null;
};
const cam = (a, b) => { if (!a || !b) return null; const dn = Math.abs(a.n - b.n), d = Math.min(dn, 12 - dn); return a.l === b.l ? d : d === 0 ? 1 : d + 1; };
const tempoPct = (b) => { if (!b?.[0] || !b?.[1]) return null; const x = Math.abs(Math.log2(b[1] / b[0])); return Math.min(x, Math.abs(x - 1)) * 100 / Math.log2(1.01) / 100; };

// ---------------- one run ----------------
// raw: a run's raw record (djbench all[i].raw); opts.mins: the run length when the record doesn't carry it;
// opts.grid: '6901364' | '1167539' to place pre-v3 transitions; opts.slugOf: track name → slug (pre-v3 files)
export function scoreRun(raw, { mins = null, grid = null, slugOf = null, ref = loadRef } = {}) {
  const M = {}, notes = [], v3 = raw.v === 3;
  const put = (k, v) => { if (v !== null && v !== undefined && (typeof v !== 'number' || Number.isFinite(v))) M[k] = v; };
  const prop = (k, ok, n) => { M[k] = { k: ok, n }; };
  const pos = (o, k) => o.p?.[k] ?? o.pp?.[k] ?? null;                      // observed where it sounded, else as scheduled
  const min = v3 && raw.t1 > raw.t0 ? (raw.t1 - raw.t0) / 60 : mins;
  put('run.minutes', min);
  if (raw.missing?.length) notes.push(`app hooks missing: ${raw.missing.join(', ')}`);

  // --- transitions ---
  const trs = v3 ? (raw.trans || []).filter((t) => t.v3 && t.fired != null) : (raw.trans || []).filter((t) => t.exec !== undefined);
  if (v3) { put('trans.cancelled', (raw.trans || []).filter((t) => t.v3 && t.fired == null && t.cancelled != null).length); put('trans.replans', sum((raw.trans || []).map((t) => t.replans || 0))); put('trans.reversed', trs.filter((t) => t.reversed).length); }
  const landOf = (t) => {
    if (v3) return { out: pos(t, 'landOut'), inn: pos(t, 'landIn'), outSlug: t.outSlug, inSlug: t.inSlug };
    // pre-v3: the landing bar on the app's grid → seconds, through that version's grid fit (when asked)
    const slug = slugOf?.get(t.track), R = slug && ref(slug);
    if (!grid || !R || t.bars == null || !(t.landBar >= 0.05)) return {};     // under 0.05: likely logged off the incoming deck
    const g = grid in R.grids ? R.grids[grid] : (R.grids[grid] = appGrid(R.a, grid));
    return g ? { out: g.first + t.landBar * 240 / g.bpm, outSlug: slug } : {};
  };
  const land = new Map(trs.map((t) => [t, landOf(t)]));
  const roomOf = (t) => {                                                   // seconds of the outgoing left once the incoming is fully in
    if (!v3) return typeof t.room === 'number' ? t.room : null;
    // it ran out first: the end of the track is logged (a stopped deck reads as exactly its duration, which would say 0)
    const e = (raw.ends || []).find(([te, d, s]) => d === t.outDeck && s === t.outSlug && te >= t.fired - 1);
    if (t.tFull != null && e && e[0] <= t.tFull + 0.05) return e[0] - t.tFull - 0.05;
    if (t.outStopped) return -0.05;
    const fo = pos(t, 'fullOut');
    return fo != null && t.outDur ? (t.outDur - fo) / (t.outRate || 1) : null;
  };
  // every driver, in every run: one that didn't fire is a 0, not a missing value (that would bias means and pairs)
  const groups = (list, by, known) => [['all', list], ...[...new Set([...known, ...list.map(by)])].sort().map((g) => [g, list.filter((x) => by(x) === g)])];
  for (const [g, list] of groups(trs.filter((t) => !t.reversed), transDriver, ['exit', 'sense', 'cap', 'ending', 'burst'])) {
    const P = `trans.${g}.`;
    put(P + 'n', list.length);
    const L = list.map((t) => ({ t, ...land.get(t) }));
    const out = L.filter((x) => x.out != null && ref(x.outSlug)).map((x) => ({ ...x, R: ref(x.outSlug) }));
    const cat = out.map((x) => CAT[sectionAt(x.R, x.out + TOL)]);
    if (v3 || grid) {
      for (const c of ['outro', 'break', 'full', 'intro']) prop(P + `land_${c === 'full' ? 'mid' : c}`, cat.filter((y) => y === c).length, cat.length);
      put(P + 'exit_vs_outro_s', median(out.filter((x) => x.R.outroStart != null).map((x) => x.out - x.R.outroStart)));
      const al = out.map((x) => align(x.R, x.out)).filter(Boolean);
      prop(P + 'on_bar', al.filter((a) => a.onBar).length, al.length); prop(P + 'on_4bar', al.filter((a) => a.on4).length, al.length);
      put(P + 'bar_dev_beats', median(al.map((a) => Math.abs(a.dBarBeats)))); put(P + 'phrase_dev_beats', median(al.filter((a) => a.d4Beats !== null).map((a) => Math.abs(a.d4Beats))));
      const inn = L.filter((x) => x.inn != null && ref(x.inSlug)).map((x) => ({ R: ref(x.inSlug), p: x.inn }));
      if (v3) {
        const ia = inn.map((x) => align(x.R, x.p)).filter(Boolean);
        prop(P + 'in_on_bar', ia.filter((a) => a.onBar).length, ia.length);
        prop(P + 'in_intro', inn.filter((x) => CAT[sectionAt(x.R, x.p + TOL)] === 'intro').length, inn.length);
      }
      put(P + 'unplaced', list.length - out.length);
    }
    const rm = list.map(roomOf).filter((x) => x !== null);
    prop(P + 'done_before_end', rm.filter((x) => x >= 0).length, rm.length); put(P + 'room_s', median(rm));
    if (g === 'all') {
      const ks = list.map((t) => cam(...(t.keys || []))).filter((x) => x !== null);
      prop(P + 'harmonic', ks.filter((x) => x <= 1).length, ks.length);
      put(P + 'tempo_change_pct', median(list.map((t) => tempoPct(t.bpms)).filter((x) => x !== null)));
    }
  }
  if (!v3) notes.push('transitions: a pre-v3 run can\'t tell a fired transition from one lined up and then cancelled');
  if (!v3) notes.push(grid ? `transitions placed through the ${grid} grid fit from their app bar (${[...land.values()].filter((x) => x.out != null).length} of ${trs.length}; ±0.01 bar rounding, skipped where the app had no analysed grid)`
    : 'transitions: no track positions (pre-v3), so section, bar and phrase on the All-In-One reference not scored (try FILE@1167539 or FILE@6901364)');

  // --- moves ---
  const mv = v3 ? (raw.moves || []).filter((m) => m.v3 && m.played && !m.swap) : (raw.moves || []);
  const placedM = (list) => list.map((m) => { const p = pos(m, 'pos'), R = p != null ? ref(m.slug) : null; return R ? { m, R, p, a: align(R, p), sec: sectionAt(R, p + TOL) } : null; }).filter(Boolean);
  for (const [g, list] of groups(mv, (m) => moveDriver(m, v3), v3 ? ['burst', 'sense', 'sense_analysed', 'plan'] : ['burst', 'sense'])) {
    const P = `moves.${g}.`;
    put(P + 'n', list.length); if (min) put(P + 'per_min', list.length / min);
    if (!v3) continue;
    const at = placedM(list), al = at.filter((x) => x.a);
    prop(P + 'on_bar', al.filter((x) => x.a.onBar).length, al.length); prop(P + 'on_4bar', al.filter((x) => x.a.on4).length, al.length);
    prop(P + 'on_8bar', al.filter((x) => x.a.on8).length, al.length); put(P + 'bar_dev_beats', median(al.map((x) => Math.abs(x.a.dBarBeats))));
    put(P + 'phrase_dev_beats', median(al.filter((x) => x.a.d4Beats !== null).map((x) => Math.abs(x.a.d4Beats))));
    const f = at.map((x) => fit3(x.m.key, x.sec)).filter((v) => v !== null);
    prop(P + 'fit', f.filter(Boolean).length, f.length);
    put(P + 'unplaced', list.length - at.length);
  }
  const keys = [...mv].sort((p, q) => (p.th ?? p.t) - (q.th ?? q.t)).map((m) => m.key);
  put('moves.all.variety', entropy(keys)); put('moves.all.variety_family', entropy(keys.map((k) => FAMILY[k] || FAMILY[k.replace(/^sense:/, '')] || k.replace(/^sense:/, ''))));
  prop('moves.all.repeats', keys.filter((k, i) => i && k === keys[i - 1]).length, Math.max(0, keys.length - 1));
  if (v3) put('moves.all.drift_ms', median(mv.filter((m) => m.p?.pos != null && m.pp?.pos != null).map((m) => 1000 * Math.abs(m.p.pos - m.pp.pos))));
  else notes.push('moves: no track positions (pre-v3), so bar, phrase and fit on the All-In-One reference not scored; builds, big bursts and horns were not logged');

  // --- silences ---
  if (v3 && raw.quiet) {
    const W = [], add = (a, b, type) => { if (Number.isFinite(a) && Number.isFinite(b) && b > a) W.push([a - PAD, b + PAD, type]); };
    for (const o of [...(raw.moves || []).filter((m) => m.v3), ...trs]) {
      const spb = o.spb || 0.5, th = o.th;
      for (const [name, ret] of o.perf || []) {
        if (name === 'buildDrop' && typeof ret === 'number') add(ret - spb, ret, 'gap');                // the silent beat before the drop
        else if (name === 'killDrop' && typeof ret === 'number') add(ret - 4 * spb, ret, 'gap');       // the 1-bar drop-out
        else if (name === 'spinCut' && typeof ret === 'number') add(th + 1.4 * spb, ret, 'gap');      // the spin's fade, to the cut
        else if (name === 'backspin') add(th + 1.4 * spb, th + 2 * spb, 'gap');
        else if (name === 'brake') add(th, th + spb, 'gap');                                            // the tape stop
        else if (name === 'singalong') add(th, th + 16 * spb, 'whisper');                                // 4 muffled bars
      }
    }
    const outside = (a, b, types) => {                                         // seconds of [a, b] outside those windows
      const iv = W.filter((w) => types.includes(w[2]) && w[1] > a && w[0] < b).map((w) => [Math.max(a, w[0]), Math.min(b, w[1])]).sort((p, q) => p[0] - q[0]);
      let cov = 0, end = a; for (const [x, y] of iv) { if (y > end) { cov += y - Math.max(x, end); end = y; } }
      return b - a - cov;
    };
    const kinds = { intended: 0, whisper: 0, track: 0, dead_air: 0, dropout: 0 };
    let longest = 0, all = 0;
    for (const [a, b, trackQ, dead] of raw.quiet) {
      if (b - a <= SIL) continue;
      all++;
      const k = outside(a, b, ['gap']) <= SIL ? 'intended' : outside(a, b, ['gap', 'whisper']) <= SIL ? 'whisper' : dead ? 'dead_air' : trackQ ? 'track' : 'dropout';
      kinds[k]++;
      if (k === 'dropout' || k === 'dead_air') longest = Math.max(longest, outside(a, b, ['gap', 'whisper']));
    }
    if (min) {
      put('silence.all_per_10min', all * 10 / min);
      for (const [k, n] of Object.entries(kinds)) put(`silence.${k}_per_10min`, n * 10 / min);
      put('silence.dropouts_per_10min', (kinds.dropout + kinds.dead_air) * 10 / min);
    }
    put('silence.longest_dropout_s', longest);
  } else notes.push('silences: only the old count (sampled every 0.5 s, blind while a move runs and 2 s after each crossfader lock)');
  if (min && typeof raw.dropouts === 'number') put('silence.legacy_dropouts_per_10min', raw.dropouts * 10 / min);

  // --- time on air ---
  if (v3 && raw.air?.length) {
    const d = (s) => s.t1 - s.t0, segs = raw.air;
    const done = segs.filter((s, i) => i > 0 && !s.open);
    put('air.complete_mean_s', mean(done.map(d))); put('air.complete_n', done.length);
    put('air.warmup_s', d(segs[0])); if (segs.at(-1).open && segs.length > 1) put('air.censored_s', d(segs.at(-1)));
    const c = {}; segs.forEach((s) => s.slug && (c[s.slug] = (c[s.slug] || 0) + 1));
    put('air.replays', Object.values(c).filter((n) => n > 1).length);
    put('air.ran_out_on_air', (raw.ends || []).filter((e) => e[3] > 0.5).length);
  } else if (raw.seg?.length) {
    put('air.legacy_excl_first_mean_s', mean(raw.seg.slice(1))); put('air.complete_n', raw.seg.length - 1);
    notes.push('time on air: the old stretches at full airness; the first is dropped as the warm-up, the one still on air at the end was never logged');
  }
  if (raw.seg?.length) put('air.legacy_mean_s', mean(raw.seg));

  // --- load ---
  if (v3 && raw.load?.length) put('load.mean', mean(raw.load.map((x) => x[1]).filter(Number.isFinite)));
  else if (typeof raw.loadEnd === 'number') { put('load.end_snapshot', raw.loadEnd); notes.push('load: a snapshot of the last ~0.2 s (pre-v3), not a run mean'); }

  // --- the listener flies' sense, against All-In-One ---
  const rows = v3 ? (raw.samples || []).filter((s) => s[6] && s[7] != null && ref(s[6])) : [];
  if (rows.length) {
    const lab = rows.map((s) => VOC[sectionAt(ref(s[6]), s[7])]);
    const sec = rows.map((s, i) => [s[4], lab[i]]).filter(([s, l]) => s && l);
    prop('sense.section_accuracy', sec.filter(([s, l]) => s === l || (s === 'main' && (l === 'chorus' || l === 'verse'))).length, sec.length);
    for (const [name, col, is] of [['mix', 1, (l) => l === 'intro' || l === 'outro'], ['space', 2, (l) => l === 'break'], ['peak', 3, (l) => l === 'chorus']]) {
      prop(`sense.${name}.precision`, rows.filter((s, i) => s[col] && is(lab[i])).length, rows.filter((s) => s[col]).length);
      prop(`sense.${name}.recall`, rows.filter((s, i) => s[col] && is(lab[i])).length, lab.filter(is).length);
    }
  }
  return { metrics: M, notes };
}

// ---------------- the old app-grid scores (djbench v2's summary), for comparison ----------------
const LSPACE = ['echo', 'reverb', 'wind', 'dub', 'sweep', 'sense:echo', 'sense:reverb', 'sense:drumsout'];
const lfits = (key, at) => {
  if (!at) return null;
  if (key === 'reject') return true;
  if (LSPACE.includes(key) || ['flange', 'flanger', 'lpf', 'resfilter'].includes(key)) return ['intro', 'break', 'outro', 'verse'].includes(at);
  return ['chorus', 'verse', 'main'].includes(at);
};
const pr = (num, den) => (den ? num / den : null);
export function legacySummary(L, mins) {
  const S = (L.samples || []).filter((s) => s[0] != null), cnt = (f) => S.filter(f).length;
  const sense = (col, is) => ({ precision: pr(cnt((s) => s[col] && is(s[0])), cnt((s) => s[col])), recall: pr(cnt((s) => s[col] && is(s[0])), cnt((s) => is(s[0]))) });
  const mixWin = (x) => x === 'intro' || x === 'outro', calm = (x) => x === 'outro' || x === 'break' || x === 'intro';
  const withSec = S.filter((s) => s[4]);
  const moves = (L.moves || []).filter((m) => m.legacy !== false), keys = moves.map((m) => m.lkey ?? m.key);
  const trans = (L.trans || []).filter((t) => t.legacy !== false), exec = trans.filter((t) => t.exec !== undefined);
  return {
    sense_section_accuracy: withSec.length ? withSec.filter((s) => s[4] === s[0] || (s[4] === 'main' && (s[0] === 'chorus' || s[0] === 'verse'))).length / withSec.length : null,
    sense_mixing_window: sense(1, mixWin), sense_breakdown: sense(2, (x) => x === 'break'), sense_peak: sense(3, (x) => x === 'chorus' || x === 'main'),
    transitions: trans.length,
    mixes_from_outro_break_intro: pr(exec.filter((t) => calm(t.exec)).length, exec.length),
    mixes_mid_song: pr(exec.filter((t) => !calm(t.exec)).length, exec.length),
    moves_on_phrase: pr(moves.filter((m) => m.phrase).length, moves.length),
    moves_on_2bar_line: pr(moves.filter((m) => m.bar2).length, moves.length),
    moves_fit_section: pr(moves.filter((m) => lfits(m.lkey ?? m.key, m.at) === true).length, moves.filter((m) => lfits(m.lkey ?? m.key, m.at) !== null).length),
    move_variety: entropy(keys),
    move_repeats: pr(keys.filter((k, i) => i && k === keys[i - 1]).length, Math.max(1, keys.length - 1)),
    moves_per_min: moves.length / mins,
    time_on_air_s: L.seg?.length ? mean(L.seg) : null,
    dropouts_per_10min: (L.dropouts || 0) * 10 / mins,
    tracks_with_analysed_grid: L.crate ? L.analysed / L.crate : null,
    load: L.loadEnd ?? (L.load?.length ? mean(L.load.map((x) => x[1]).filter(Number.isFinite)) : null),
  };
}
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, p + k + '.') : [[p + k, v]]));
// over runs: mean ± Student t CI per summary measure, plus the pooled mixing share, keys, tempo and room (as djbench v2)
export function legacyAggregate(all) {
  const agg = {};
  for (const [k] of flat(all[0].summary)) {
    const v = all.map((a) => Object.fromEntries(flat(a.summary))[k]).filter((x) => typeof x === 'number');
    const c = meanCI(v); if (c) agg[k] = c;
  }
  const ex = all.flatMap((a) => (a.raw.trans || []).filter((t) => t.legacy !== false && t.exec !== undefined && t.exec !== null));
  const good = ex.filter((t) => ['outro', 'break', 'intro'].includes(t.exec)).length;
  agg.pooled_mixes_from_outro_break_intro = { good, n: ex.length, share: pr(good, ex.length), wilson95: wilson(good, ex.length) };
  const ks = ex.map((t) => cam(...(t.keys || []))).filter((x) => x !== null);
  agg.harmonic_mixes = { compatible: ks.filter((x) => x <= 1).length, n: ks.length, share: pr(ks.filter((x) => x <= 1).length, ks.length) };
  const tc = ex.map((t) => tempoPct(t.bpms)).filter((x) => x !== null).sort((a, b) => a - b);
  agg.median_tempo_change_pct = tc.length ? tc[Math.floor(tc.length / 2)] : null;
  const rm = ex.map((t) => t.room).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  agg.mixes_done_before_end = { ok: rm.filter((x) => x >= 0).length, n: rm.length, median_room_s: rm.length ? rm[rm.length >> 1] : null };
  agg.mix_reasons = Object.entries(ex.reduce((m, t) => ((m[t.reason.split(' (')[0]] = (m[t.reason.split(' (')[0]] || 0) + 1), m), {}));
  return agg;
}

// ---------------- over runs, and A against B ----------------
export function aggregate(scores) {
  const A = {}, keys = [...new Set(scores.flatMap((s) => Object.keys(s.metrics)))];
  for (const k of keys) {
    const vals = scores.map((s) => s.metrics[k]).filter((v) => v !== undefined);
    if (vals.some((v) => typeof v === 'object')) {
      const K = sum(vals.map((v) => v.k)), N = sum(vals.map((v) => v.n));
      A[k] = { ...(meanCI(vals.filter((v) => v.n > 0).map((v) => v.k / v.n)) || { mean: null, ci95: null, n: 0 }), pooled: { k: K, n: N, share: pr(K, N), wilson95: wilson(K, N) } };
    } else A[k] = meanCI(vals);
  }
  return A;
}
const share = (v) => (v && typeof v === 'object' ? (v.n ? v.k / v.n : undefined) : v);
// B − A per measure: per-run differences paired by run index, Student t; proportions also pooled (Newcombe)
export function compare(a, b) {
  const D = {}, n = Math.min(a.scores.length, b.scores.length);
  const keys = [...new Set([...a.scores, ...b.scores].flatMap((s) => Object.keys(s.metrics)))];
  for (const k of keys) {
    const d = [];
    for (let i = 0; i < n; i++) { const x = share(a.scores[i].metrics[k]), y = share(b.scores[i].metrics[k]); if (Number.isFinite(x) && Number.isFinite(y)) d.push(y - x); }
    const r = { paired: meanCI(d) };
    const pa = a.agg[k]?.pooled, pb = b.agg[k]?.pooled;
    if (pa && pb && pa.n && pb.n) r.pooled = { diff: pb.share - pa.share, newcombe95: newcombe(pa.k, pa.n, pb.k, pb.n) };
    if (r.paired || r.pooled) D[k] = r;
  }
  return D;
}

// ---------------- files ----------------
const slugMap = () => {
  const m = new Map();
  for (const f of ['tracks.json', 'tracks_more.json']) {
    const p = `${DATA}/realtracks/${f}`;
    if (existsSync(p)) for (const t of JSON.parse(readFileSync(p))) m.set(t.name.replace(/</g, '‹').replace(/>/g, '›'), t.slug);
  }
  return m;
};
export function scoreFile(file, { grid = null } = {}) {
  const runs = (file.all || []).filter((a) => a.raw), notes = new Set();
  if (!runs.length) return { scores: [], agg: {}, legacy: null, notes: ['no raw events in this file (before djbench v2.1): nothing to score'] };
  const slugOf = runs.some((a) => a.raw.v !== 3) ? slugMap() : null;
  const scores = runs.map((a) => {
    const raw = a.raw.v === 3 ? a.raw : { ...a.raw, loadEnd: a.summary?.load };
    const s = scoreRun(raw, { mins: file.mins, grid, slugOf });
    s.notes.forEach((x) => notes.add(x)); s.seed = a.seed ?? raw.seed ?? 1234 + a.run * 977;
    return s;
  });
  const legacy = legacyAggregate(runs.map((a) => ({ summary: a.raw.v === 3 ? legacySummary(a.raw, (a.raw.t1 - a.raw.t0) / 60 || file.mins) : a.summary, raw: a.raw })));
  return { scores, agg: aggregate(scores), legacy, notes: [...notes] };
}

// ---------------- printing ----------------
// measures grouped: transitions (all, then by driver), moves (likewise), silences, time on air, load, sense
const RANK = ['run.', 'trans.cancelled', 'trans.replans', 'trans.reversed', 'trans.all.', 'trans.exit.', 'trans.sense.', 'trans.cap.', 'trans.ending.', 'trans.burst.', 'trans.',
  'moves.all.', 'moves.burst.', 'moves.sense.', 'moves.sense_analysed.', 'moves.plan.', 'moves.', 'silence.', 'air.', 'load.', 'sense.'];
const ordered = (o) => Object.entries(o).map((e, i) => [e, RANK.findIndex((r) => e[0].startsWith(r)), i]).sort((p, q) => (p[1] < 0 ? 99 : p[1]) - (q[1] < 0 ? 99 : q[1]) || p[2] - q[2]).map((x) => x[0]);
const f3 = (x) => (x === null || x === undefined ? '—' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));
const fmt = (v) => {
  if (!v) return '—';
  let s = `${f3(v.mean)} ± ${v.ci95 === null ? '—' : f3(v.ci95)} (${v.n} run${v.n === 1 ? '' : 's'})`;
  if (v.pooled) s += `   pooled ${v.pooled.k}/${v.pooled.n}${v.pooled.n ? ` = ${f3(v.pooled.share)} [${v.pooled.wilson95.map(f3).join(', ')}]` : ''}`;
  return s;
};
export function report(name, sc, file = {}) {
  const out = [`\n== ${name}: ${file.mode || ''} · set ${file.set || 'heldout'} · ${sc.scores.length} run(s) · ${file.tracks ?? '?'} tracks${file.v === 3 ? '' : ' · pre-v3 file'}`];
  for (const n of sc.notes) out.push(`   (${n})`);
  for (const [k, v] of ordered(sc.agg)) out.push(`  ${k.padEnd(40)} ${fmt(v)}`);
  if (sc.legacy) {
    out.push('  -- legacy (the app\'s own grid and labels, as djbench v2 scored them)');
    for (const [k, v] of Object.entries(sc.legacy)) out.push(`  ${k.padEnd(40)} ${v?.mean !== undefined ? `${f3(v.mean)} ± ${v.ci95 === null ? '—' : f3(v.ci95)}` : JSON.stringify(v, (_, x) => (typeof x === 'number' ? +x.toFixed(3) : x))}`);
  }
  return out.join('\n');
}
export function reportCompare(an, bn, a, b, D) {
  const n = Math.min(a.scores.length, b.scores.length), seeds = a.scores.slice(0, n).every((s, i) => s.seed === b.scores[i].seed);
  const out = [`\n== ${bn} − ${an}: per-run differences paired by run (${n} pairs${seeds ? ', same seeds' : ', SEEDS DIFFER: the pairing means little'}), Student t 95%; pooled shares with Newcombe 95%`];
  if (a.scores.length !== b.scores.length) out.push(`   (${a.scores.length} against ${b.scores.length} runs: the extra runs are left out of the pairs)`);
  for (const [k, r] of ordered(D)) {
    const p = r.paired ? `${f3(r.paired.mean)} ± ${r.paired.ci95 === null ? '—' : f3(r.paired.ci95)} (${r.paired.n})` : '—';
    const sig = r.paired?.ci95 != null && Math.abs(r.paired.mean) > r.paired.ci95 ? ' *' : '';
    out.push(`  ${k.padEnd(40)} ${p}${sig}${r.pooled ? `   pooled ${f3(r.pooled.diff)} [${r.pooled.newcombe95.map(f3).join(', ')}]` : ''}`);
  }
  out.push('  (* the paired interval excludes 0)');
  return out.join('\n');
}

// ---------------- self-test: synthetic references and runs with known answers ----------------
function selftest() {
  let fails = 0;
  const ok = (c, what) => { if (!c) { fails++; console.log('FAIL', what); } };
  const near = (x, y, e, what) => ok(x !== null && Math.abs(x - y) <= e, `${what}: ${x} vs ${y}`);
  near(tinv(0.975, 1), 12.706, 0.01, 't 1'); near(tinv(0.975, 2), 4.303, 0.005, 't 2'); near(tinv(0.975, 4), 2.776, 0.005, 't 4'); near(tinv(0.975, 30), 2.042, 0.005, 't 30');
  const w = wilson(5, 8); near(w[0], 0.306, 0.005, 'wilson lo'); near(w[1], 0.863, 0.005, 'wilson hi');
  const nc = newcombe(4, 24, 5, 8); near(nc[0], 0.086, 0.002, 'newcombe lo'); ok(nc[1] > 0.6 && nc[1] < 0.8, 'newcombe hi');
  // a 120 BPM song: beats every 0.5 s from 1.0, downbeats every 2 s (odd seconds); intro 1–17, verse 17–33, chorus
  // 33–65, a 2-bar bridge 65–69, so the last chorus (69–97) phrases off the grid counted from 0 s: its 4-bar lines run
  // 69, 77, 85, 93 where that grid has 73, 81, 89; outro 97–121, end to 123
  const beats = Array.from({ length: 240 }, (_, i) => 1 + i * 0.5).filter((x) => x < 121);
  const a = { bpm: 120, beats, downbeats: beats.filter((_, i) => i % 4 === 0), segments: [['start', 0, 1], ['intro', 1, 17], ['verse', 17, 33], ['chorus', 33, 65], ['bridge', 65, 69], ['chorus', 69, 97], ['outro', 97, 121], ['end', 121, 123]].map(([label, start, end]) => ({ label, start, end })) };
  const R = makeRef(a), refs = { song: R, other: R }, ref = (s) => refs[s] || null;
  ok(sectionAt(R, 50) === 'chorus' && sectionAt(R, 97) === 'outro' && sectionAt(R, 122) === 'end' && sectionAt(R, 0.5) === 'start', 'sections');
  ok(R.outroStart === 97, 'outro start');
  ok(align(R, 33.04).onBar && align(R, 33.04).on4 && !align(R, 35.04).on4 && align(R, 35.04).onBar, 'bar and phrase lines');
  ok(align(R, 77).on4 && !align(R, 77).on8 && align(R, 85).on8 && align(R, 69).on8 && align(R, 65).on4, 'phrase lines restart at a section start');
  ok(!align(R, 33.1).onBar && Math.abs(align(R, 33.1).dBarBeats - 0.2) < 1e-9, 'off the bar by 0.2 beats');
  ok(Math.abs(align(R, 73).d4Beats - 8) < 1e-9 && Math.abs(align(R, 67.5).d4Beats + 3) < 1e-9, 'distance to the phrase line, in beats (the next section\'s start counts)');
  ok(align(R, 73).onBar && !align(R, 73).on4 && align(R, 81).onBar && !align(R, 81).on4, 'a 4-bar line counted from 0 s (73, 81) is not one from the section start');
  // a run: 10 minutes, 3 moves, 2 transitions, silences of each kind, 3 on-air stretches
  const raw = { v: 3, t0: 0, t1: 600, seed: 1234, missing: [], samples: [], dropouts: 0, seg: [100, 200], ends: [],
    load: [[1, 0.5], [2, 0.7]],
    moves: [
      { v3: 1, played: true, key: 'echo', driver: 'burst', slug: 'song', th: 10, spb: 0.5, p: { pos: 33.02 }, pp: { pos: 33.0 }, perf: [['beatFx', null]] },           // on a 4-bar line, in a chorus: echo doesn't fit
      { v3: 1, played: true, key: 'roll', driver: 'burst', slug: 'song', th: 20, spb: 0.5, p: { pos: 45.5 }, pp: { pos: 45.5 }, perf: [['roll', null]] },             // off the bar by a beat
      { v3: 1, played: true, key: 'build', driver: 'burst', slug: 'song', th: 100, spb: 0.5, p: { pos: 51 }, perf: [['buildDrop', 108]] },                             // on a bar; gap 107.5–108
      { v3: 1, played: true, key: 'echo', driver: 'sense', known: true, slug: 'song', th: 200, spb: 0.5, p: { pos: 65 }, perf: [['beatFx', null]] },                   // fits the bridge
      { v3: 1, played: false, key: 'scratch', driver: 'burst', slug: 'song', th: 210, spb: 0.5, perf: [] },                                                            // played nothing
    ],
    trans: [
      { v3: 1, fired: 300, style: 'blend', reason: 'the outro (bar 48, analysed)', outSlug: 'song', inSlug: 'other', outDur: 123, outRate: 1, outDeck: 0, p: { landOut: 97.01, landIn: 1.0, fullOut: 113 }, keys: [{ n: 8, l: 'A' }, { n: 9, l: 'A' }], bpms: [120, 122], th: 300, spb: 0.5, perf: [] },
      { v3: 1, fired: 400, style: 'cut', reason: 'the fly wants to leave, in a late breakdown', outSlug: 'other', inSlug: 'song', outDur: 123, outDeck: 1, p: { landOut: 66.3, landIn: 1.0, fullOut: 66.3 }, keys: [{ n: 8, l: 'A' }, { n: 2, l: 'B' }], bpms: [122, 61], th: 399, spb: 0.5, perf: [['hardCut', 401]] },
      { v3: 1, style: 'echo', reason: 'x', cancelled: 450, replans: 1 },
    ],
    quiet: [[107.4, 108.1, false, false], [300, 300.5, false, false], [350, 352, true, false], [500, 503, false, false], [560, 561, false, true]],
    air: [{ deck: 0, slug: 'song', t0: 0, t1: 300 }, { deck: 1, slug: 'other', t0: 300, t1: 400 }, { deck: 0, slug: 'song', t0: 400, t1: 600, open: true }],
  };
  const s = scoreRun(raw, { ref }).metrics;
  ok(s['moves.all.n'] === 4 && Math.abs(s['moves.all.per_min'] - 0.4) < 1e-9, 'moves counted (played only)');
  ok(s['moves.all.on_bar'].k === 3 && s['moves.all.on_bar'].n === 4, `on bar ${JSON.stringify(s['moves.all.on_bar'])}`);
  ok(s['moves.all.on_4bar'].k === 2, `on 4-bar ${JSON.stringify(s['moves.all.on_4bar'])}`);
  ok(s['moves.burst.n'] === 3 && s['moves.sense_analysed.n'] === 1, 'moves by driver');
  ok(s['moves.all.fit'].k === 2 && s['moves.all.fit'].n === 3, `fit ${JSON.stringify(s['moves.all.fit'])}`);
  near(s['moves.all.drift_ms'], 10, 1e-6, 'drift');
  ok(s['trans.all.n'] === 2 && s['trans.exit.n'] === 1 && s['trans.sense.n'] === 1 && s['trans.cancelled'] === 1 && s['trans.replans'] === 1, 'transitions by driver');
  ok(s['trans.exit.land_outro'].k === 1 && s['trans.sense.land_break'].k === 1, 'landing sections');
  ok(s['trans.all.on_bar'].k === 1 && s['trans.all.on_bar'].n === 2, 'landing on the bar');
  ok(s['trans.all.in_on_bar'].k === 2 && s['trans.all.in_intro'].k === 2, 'incoming from its first downbeat, in its intro');
  near(s['trans.exit.exit_vs_outro_s'], 0.01, 1e-6, 'exit vs outro');
  ok(s['trans.all.harmonic'].k === 1 && s['trans.all.harmonic'].n === 2, 'harmonic');
  near(s['trans.all.tempo_change_pct'], (Math.log2(122 / 120) / Math.log2(1.01) + Math.log2(122 / 122) / Math.log2(1.01)) / 2, 0.01, 'tempo change (octave-folded)');
  ok(s['trans.all.done_before_end'].k === 2, 'room');
  ok(s['silence.intended_per_10min'] === 1 && s['silence.track_per_10min'] === 1 && s['silence.dropout_per_10min'] === 1 && s['silence.dead_air_per_10min'] === 1 && s['silence.all_per_10min'] === 4, `silences ${JSON.stringify(s)}`);
  near(s['silence.longest_dropout_s'], 3, 1e-9, 'longest dropout');
  ok(s['air.complete_n'] === 1 && s['air.complete_mean_s'] === 100 && s['air.warmup_s'] === 300 && s['air.censored_s'] === 200 && s['air.replays'] === 1, 'time on air');
  near(s['load.mean'], 0.6, 1e-9, 'load mean');
  // a blend whose outgoing track ran out before the fader reached the end
  const r3 = { ...raw, ends: [[310, 0, 'song', 1]], trans: [{ ...raw.trans[0], outDeck: 0, tFull: 310.02, outStopped: true, p: { landOut: 97.01, landIn: 1, fullOut: null }, pp: { fullOut: 123 } }] };
  ok(scoreRun(r3, { ref }).metrics['trans.all.done_before_end'].k === 0, 'a track running out mid-blend is not done before its end');
  // a 16-bar silent build: only its last beat is meant to be silent
  const r2 = { ...raw, moves: [{ v3: 1, played: true, key: 'build', driver: 'burst', slug: 'song', th: 100, spb: 0.5, perf: [['buildDrop', 132]] }], quiet: [[100, 132.05, false, false]] };
  ok(scoreRun(r2, { ref }).metrics['silence.dropout_per_10min'] === 1, 'a silent build is a dropout');
  // over runs, and paired
  const agg = aggregate([{ metrics: { x: 1, p: { k: 1, n: 2 } } }, { metrics: { x: 3, p: { k: 3, n: 4 } } }]);
  near(agg.x.mean, 2, 1e-9, 'mean'); near(agg.x.ci95, 12.706, 0.01, 'ci over 2 runs'); ok(agg.p.pooled.k === 4 && agg.p.pooled.n === 6, 'pooled');
  const A = { scores: [{ metrics: { x: 1 }, seed: 1 }, { metrics: { x: 2 }, seed: 2 }, { metrics: { x: 4 }, seed: 3 }] }, B = { scores: [{ metrics: { x: 2 }, seed: 1 }, { metrics: { x: 4 }, seed: 2 }, { metrics: { x: 5 }, seed: 3 }] };
  A.agg = aggregate(A.scores); B.agg = aggregate(B.scores);
  const D = compare(A, B); near(D.x.paired.mean, 4 / 3, 1e-9, 'paired mean'); near(D.x.paired.ci95, 4.303 * Math.sqrt(1 / 3) / Math.sqrt(3), 0.01, 'paired ci');
  // the grid fits: a clean 120 BPM downbeat list gives back its own grid
  const g = appGrid(a, '1167539'), g0 = appGrid(a, '6901364');
  ok(g && g.bpm === 120 && Math.abs(g.first - 1) < 1e-6 && g0 && g0.bpm === 120 && Math.abs(g0.first - 1) < 1e-6, `grid ${JSON.stringify([g, g0])}`);
  // a pre-v3 run degrades: counts and room scored, positions not
  const old = scoreRun({ moves: [{ key: 'dub', at: 'intro', phrase: true }, { key: 'sense:echo', at: 'break' }], trans: [{ exec: 'outro', reason: 'the outro (bar 9, analysed)', room: 10 }], seg: [50, 100, 150], dropouts: 2 }, { mins: 10, ref });
  ok(old.metrics['moves.all.n'] === 2 && old.metrics['moves.sense.n'] === 1 && old.metrics['trans.exit.n'] === 1 && old.metrics['trans.all.land_outro'] === undefined
    && old.metrics['air.legacy_excl_first_mean_s'] === 125 && old.metrics['silence.legacy_dropouts_per_10min'] === 2 && old.notes.length >= 3, 'pre-v3 run');
  console.log(fails ? `${fails} check(s) failed` : 'selftest: all checks pass');
  return fails;
}

// ---------------- command line ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) process.exit(selftest() ? 1 : 0);
  const ji = args.indexOf('--json'), jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
  const files = args.filter((x) => !x.startsWith('--')).map((x) => {
    const m = x.match(/^(.*)@(1167539|6901364)$/);
    return { path: m ? m[1] : x, grid: m ? m[2] : null };
  });
  if (!files.length) { console.log('usage: node tools/djscore.mjs RUN.json[@1167539|@6901364] [B.json] [--json OUT.json] | --selftest'); process.exit(1); }
  const res = files.map(({ path, grid }) => { const file = JSON.parse(readFileSync(path)); const sc = scoreFile(file, { grid }); console.log(report(path, sc, file)); return { path, grid, sc }; });
  let D = null;
  if (res.length === 2 && res[0].sc.scores.length && res[1].sc.scores.length) { D = compare(res[0].sc, res[1].sc); console.log(reportCompare(res[0].path, res[1].path, res[0].sc, res[1].sc, D)); }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ files: res.map(({ path, grid, sc }) => ({ path, grid, ...sc })), compare: D }, null, 1));
}
