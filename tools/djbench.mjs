// DJ benchmark: the full app, headless, on held-out real tracks, repeated runs, scored on DJ craft.
//
//   PORT=8766 MODE=new RUNS=3 MIN=8 node tools/djbench.mjs
//     MODE  new = section sense + phrase-timed, section-fitting moves + the section mixing gate
//           old = the earlier behaviour (rank-detector sense, moves fired at once, no section gate)
//   -> data/bench/<mode>-<time>.json (every run's raw events) and a summary: mean ± 95% CI over runs
//
// What it scores (DJ craft, from studies of real DJ mixes and DJ practice, not "fewer moves"):
//   sense       per-deck agreement with reference sections (both decks, every 0.5 s); the DJ senses as precision / recall
//   mixing      share of transitions that land in an outro or breakdown of the outgoing track (vs mid-song), and
//               that finish before the outgoing track runs out
//   phrasing    share of moves that start on a 4-bar line
//   fit         share of moves that suit their section (space in breaks / outros, flourishes in choruses ...)
//   variety     normalised entropy of the move types, and how often the same move repeats back to back
//   pace        moves per minute (busy above ~2 / min: "cranking knobs every 30 seconds"), time on air per track
//               (real mixes: ~4 min per track)
import { chromium } from './node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const port = process.env.PORT || 8765, mode = process.env.MODE || 'new', runs = +(process.env.RUNS || 3), mins = +(process.env.MIN || 8);
const SET = process.env.SET || 'heldout';           // heldout: fold 0 of the first crate; fresh: the untouched test set
const tracks = [...JSON.parse(readFileSync(root + 'data/realtracks/tracks.json')),
  ...(existsSync(root + 'data/realtracks/tracks_more.json') ? JSON.parse(readFileSync(root + 'data/realtracks/tracks_more.json')) : [])];
const labFile = existsSync(root + 'data/realtracks/labels_allin1.json') ? 'labels_allin1.json' : 'labels.json';
const labels = JSON.parse(readFileSync(root + 'data/realtracks/' + labFile));
const cv = process.env.HELD || root + 'data/realtracks/held_out.json';
const held = SET === 'fresh' ? JSON.parse(readFileSync(root + 'data/realtracks/test_fresh.json'))
  : existsSync(cv) ? JSON.parse(readFileSync(cv)) : JSON.parse(readFileSync(root + 'data/realtracks/sections_eval_trained.json')).held_out_tracks;
// a track counts if it has a reference: its All-In-One analysis (the app applies it) or a label list
const pick = tracks.filter((t) => held.includes(t.slug) && (labels[t.name] || existsSync(root + `data/realtracks/allin1/${t.slug}.json`)));

// which sections each move suits (scoring only)
const SPACE = ['echo', 'reverb', 'wind', 'dub', 'sweep', 'sense:echo', 'sense:reverb', 'sense:drumsout'];
const CALM = ['intro', 'break', 'outro', 'verse'], BIG = ['chorus', 'verse', 'main'];
const fits = (key, at) => {
  if (!at) return null;
  if (key === 'reject') return true;
  if (SPACE.includes(key) || ['flange', 'flanger', 'lpf', 'resfilter'].includes(key)) return CALM.includes(at);   // space and filters: intros, breaks, outros, verses
  return BIG.includes(at);                                                 // scratches, rolls, gates: the full sections
};

async function run(r) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; window.flyNoStems = true; });
  await page.route('**/__track/*', (route) => route.fulfill({ body: readFileSync(pick[+route.request().url().split('/').pop()].file), contentType: 'audio/mpeg' }));
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector('#splash-msg').textContent.startsWith('connected'));
  await page.click('#btn-start');
  await page.waitForSelector('#splash.gone', { state: 'attached', timeout: 90000 });
  await page.evaluate(async ([names, seed, mode, labels]) => {
    const S = window.flyDJ, files = [];
    for (let i = 0; i < names.length; i++) files.push(new File([await (await fetch(`/__track/${i}`)).blob()], names[i] + '.mp3'));
    await S.api.addFiles(files);
    let x = seed; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    S.crate = S.crate.filter((t) => t.source === 'file').sort(() => rnd() - 0.5);
    S.api.loadTrack(0, S.crate[0]); S.api.loadTrack(1, S.crate[1]); S.crateNext = 2;
    const neu = mode === 'new';
    S.dj.useSections = neu; S.dj.phraseMoves = neu; S.dj.sectionFit = neu;
    const L = window._b = { samples: [], moves: [], trans: [], seg: [], dropouts: 0 };
    const labelOf = (d, at) => { const lab = d.track?.sections || labels[d.track?.name], bar = Math.floor(d.beatAt(at) / 4 + 0.02); return lab && bar >= 0 && bar < lab.length ? lab[bar] : null; };
    // dropouts: the master output going silent (< -50 dBFS for > 0.6 s) while a deck plays, outside intended gaps
    const an = S.ctx.createAnalyser(); an.fftSize = 2048; S.mixer.out.connect(an);
    const buf = new Float32Array(an.fftSize); let quiet = 0;
    L.dropouts = 0; L.analysed = S.crate.filter((t) => t.gridSource).length; L.crate = S.crate.length;
    const onAir = () => S.mixer.onAir();
    const fire = S.dj.fire.bind(S.dj);
    S.dj.fire = (key, ...a) => {
      const d = onAir(), nb = d.nextBeatTime(1), beat = Math.round(d.beatAt(nb));
      S.dj.played = null; const r = fire(key, ...a);
      L.moves.push({ key: S.dj.played || key, group: key, at: labelOf(d), phrase: ((beat % 16) + 16) % 16 === 0, bar2: ((beat % 8) + 8) % 8 === 0, t: S.ctx.currentTime });
      return r;
    };
    const doMove = S.dj.doMove.bind(S.dj);
    S.dj.doMove = (name, who) => {
      if (/SPACE|set plan/.test(who || '')) { const d = onAir(), beat = Math.round(d.beatAt(d.nextBeatTime(1))); L.moves.push({ key: 'sense:' + name, at: labelOf(d), phrase: ((beat % 16) + 16) % 16 === 0, bar2: ((beat % 8) + 8) % 8 === 0, t: S.ctx.currentTime }); }
      return doMove(name, who);
    };
    let pend = null, cur = null;
    setInterval(() => {
      const t = S.ctx.currentTime, d = onAir(), full = S.mixer.airness(d) > 0.99;
      if (S.dj.t > 30) S.mixer.decks.forEach((dk, i) => {          // both decks: what the listener fly senses vs reference
        const at = labelOf(dk); if (!at || !dk.playing) return;
        const st = (S.dj.sectionsOn?.() || S.dj.listeners)?.[i]?.state; if (!st) return;
        L.samples.push([at, !!st.MIX, !!st.SPACE, !!st.PEAK, st.section || null, i === (d === S.mixer.decks[0] ? 0 : 1)]);
      });
      if (S.dj.pending && S.dj.pending !== pend) L.trans.push({ style: S.dj.pending.style, reason: S.dj.pending.reason || '', at: labelOf(d), t });
      if (!S.dj.pending && pend && L.trans.length) {
        const tr = L.trans[L.trans.length - 1], inc = S.mixer.decks.find((x) => x !== d);
        // scored where the transition lands (the incoming's first bar), not where a cut / drop starts building
        // (builds that don't record it: the start plus the style's lead)
        const land = pend.landT ?? pend.at + ({ blend: 0, echo: 4, spin: 4, cut: 4, kill: 8, drop: 12, double: 12 }[pend.style] ?? 4) * 60 / (d.bpm || 120);
        tr.exec = labelOf(d, land);
        // outgoing audio left once the incoming is fully in (< 0: the track ran out mid-transition)
        const done = pend.style === 'blend' ? pend.at + (pend.blendBeats || 32) * 60 / (d.bpm || 120) : land;
        tr.room = d.track ? (d.duration - d.position(done)) / d.rate : null;
        tr.track = d.track?.name; tr.landBar = +(d.beatAt(land) / 4).toFixed(2);
        tr.mixBar = d.track?.mixBar ?? null; tr.bars = d.track?.sections?.length ?? null; tr.exit = d.track?.exit ?? null; tr.steady = d.track?.steady ?? null;
        tr.keys = [d.track?.camelot || null, inc?.track?.camelot || null];      // outgoing, incoming (Camelot)
        tr.bpms = [d.track?.bpm || null, inc?.track?.bpm || null];
      }
      pend = S.dj.pending;
      an.getFloatTimeDomainData(buf); let e = 0; for (const v of buf) e += v * v;
      const db = 10 * Math.log10(e / buf.length + 1e-12), intended = S.perf.busy() || t < S.mixer.lockUntil + 2;
      if (db < -50 && S.mixer.onAir().playing && !intended) { quiet += 0.5; if (quiet === 1) L.dropouts++; } else quiet = 0;
      if (cur && (!full || cur.deck !== d || cur.track !== d.track)) { L.seg.push(t - cur.t0); cur = null; }
      if (full && !cur) cur = { t0: t, deck: d, track: d.track };
    }, 500);
  }, [pick.map((t) => t.name), 1234 + r * 977, mode, labels]);
  await page.waitForTimeout(mins * 60 * 1000);
  const L = await page.evaluate(() => ({ ...window._b, load: window.flyDJ.stats.load }));
  await browser.close();
  return { errs, ...L, dropouts: L.dropouts, analysed: L.analysed, crate: L.crate };
}

const pr = (num, den) => (den ? num / den : null);
function summarize(L) {
  const S = L.samples, cnt = (f) => S.filter(f).length;
  const sense = (col, is) => ({ precision: pr(cnt((s) => s[col] && is(s[0])), cnt((s) => s[col])), recall: pr(cnt((s) => s[col] && is(s[0])), cnt((s) => is(s[0]))) });
  const mixWin = (x) => x === 'intro' || x === 'outro', calm = (x) => x === 'outro' || x === 'break' || x === 'intro';
  const withSec = S.filter((s) => s[4]);
  const keys = L.moves.map((m) => m.key), counts = {};
  keys.forEach((k) => (counts[k] = (counts[k] || 0) + 1));
  const H = -Object.values(counts).reduce((h, c) => h + (c / keys.length) * Math.log(c / keys.length), 0);
  const exec = L.trans.filter((t) => t.exec !== undefined);
  return {
    sense_section_accuracy: withSec.length ? withSec.filter((s) => s[4] === s[0] || (s[4] === 'main' && (s[0] === 'chorus' || s[0] === 'verse'))).length / withSec.length : null,
    sense_mixing_window: sense(1, mixWin), sense_breakdown: sense(2, (x) => x === 'break'), sense_peak: sense(3, (x) => x === 'chorus' || x === 'main'),
    transitions: L.trans.length,
    mixes_from_outro_break_intro: pr(exec.filter((t) => calm(t.exec)).length, exec.length),
    mixes_mid_song: pr(exec.filter((t) => !calm(t.exec)).length, exec.length),
    moves_on_phrase: pr(L.moves.filter((m) => m.phrase).length, L.moves.length),
    moves_on_2bar_line: pr(L.moves.filter((m) => m.bar2).length, L.moves.length),
    moves_fit_section: pr(L.moves.filter((m) => fits(m.key, m.at) === true).length, L.moves.filter((m) => fits(m.key, m.at) !== null).length),
    move_variety: keys.length > 1 ? H / Math.log(Math.max(2, Object.keys(counts).length)) : null,
    move_repeats: pr(keys.filter((k, i) => i && k === keys[i - 1]).length, Math.max(1, keys.length - 1)),
    moves_per_min: L.moves.length / mins,
    time_on_air_s: L.seg.length ? L.seg.reduce((a, b) => a + b, 0) / L.seg.length : null,
    dropouts_per_10min: L.dropouts * 10 / mins,
    tracks_with_analysed_grid: L.crate ? L.analysed / L.crate : null,
    load: L.load,
  };
}
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]));

const all = [];
for (let r = 0; r < runs; r++) {
  const L = await run(r);
  const s = summarize(L);
  all.push({ run: r, summary: s, raw: { moves: L.moves, trans: L.trans, seg: L.seg, dropouts: L.dropouts }, errors: L.errs });
  console.log(`run ${r + 1}/${runs} (${mode}):`, JSON.stringify(s));
}
const agg = {};
for (const [k] of flat(all[0].summary)) {
  const v = all.map((a) => Object.fromEntries(flat(a.summary))[k]).filter((x) => typeof x === 'number');
  if (!v.length) continue;
  const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
  const T = [0, 12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23][v.length - 1] || 2.0;   // Student t, 95%
  agg[k] = { mean: +m.toFixed(3), ci95: v.length > 1 ? +(T * sd / Math.sqrt(v.length)).toFixed(3) : null, n: v.length };
}
// mixes pooled over runs (each run has only a few): share from an outro / breakdown / intro, with a Wilson interval
const ex = all.flatMap((a) => a.raw.trans.filter((t) => t.exec !== undefined && t.exec !== null));
const good = ex.filter((t) => ['outro', 'break', 'intro'].includes(t.exec)).length, nn = ex.length, z = 1.96;
const ph = nn ? good / nn : 0, den = 1 + z * z / nn, cen = (ph + z * z / (2 * nn)) / den, half = nn ? z * Math.sqrt(ph * (1 - ph) / nn + z * z / (4 * nn * nn)) / den : 0;
agg.pooled_mixes_from_outro_break_intro = { good, n: nn, share: +ph.toFixed(3), wilson95: [+(cen - half).toFixed(3), +(cen + half).toFixed(3)] };
// harmonic mixing: Camelot-compatible (same number, or +-1 with the same letter) and the tempo change between tracks
const cam = (a, b) => { if (!a || !b) return null; const dn = Math.abs(a.n - b.n), d = Math.min(dn, 12 - dn); return a.l === b.l ? d : d === 0 ? 1 : d + 1; };
const ks = ex.map((t) => cam(...(t.keys || []))).filter((x) => x !== null);
agg.harmonic_mixes = { compatible: ks.filter((x) => x <= 1).length, n: ks.length, share: ks.length ? +(ks.filter((x) => x <= 1).length / ks.length).toFixed(3) : null };
const tc = ex.map((t) => (t.bpms?.[0] && t.bpms?.[1] ? Math.abs(Math.log2(t.bpms[1] / t.bpms[0])) : null)).filter((x) => x !== null)
  .map((x) => Math.min(x, Math.abs(x - 1)) * 100 / Math.log2(1.01) / 100).sort((a, b) => a - b);    // % tempo change, octave-folded
agg.median_tempo_change_pct = tc.length ? +tc[Math.floor(tc.length / 2)].toFixed(1) : null;
// transitions that finish (the incoming fully in) before the outgoing track runs out
const rm = ex.map((t) => t.room).filter((x) => typeof x === 'number').sort((a, b) => a - b);
agg.mixes_done_before_end = { ok: rm.filter((x) => x >= 0).length, n: rm.length, median_room_s: rm.length ? +rm[rm.length >> 1].toFixed(1) : null };
agg.mix_reasons = Object.entries(ex.reduce((m, t) => ((m[t.reason.split(' (')[0]] = (m[t.reason.split(' (')[0]] || 0) + 1), m), {}));
mkdirSync(root + 'data/bench', { recursive: true });
const out = root + `data/bench/${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
writeFileSync(out, JSON.stringify({ mode, runs, mins, tracks: pick.length, labels: labFile, agg, all }, null, 1));
console.log(`\n${mode} summary (mean ± 95% CI over ${runs} runs, ${pick.length} held-out tracks, labels ${labFile}):`);
for (const [k, v] of Object.entries(agg)) console.log(`  ${k.padEnd(36)} ${v?.mean !== undefined ? `${v.mean} ± ${v.ci95}` : JSON.stringify(v)}`);
console.log('saved', out);
