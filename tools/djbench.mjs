// DJ benchmark: the full app, headless, on held-out real tracks, repeated runs, scored on DJ craft.
//
//   PORT=8766 MODE=new RUNS=3 MIN=8 node tools/djbench.mjs
//     MODE  new = section sense + phrase-timed, section-fitting moves + the section mixing gate
//           old = the earlier behaviour (rank-detector sense, moves fired at once, no section gate)
//   -> data/bench/<mode>-<time>.json (every run's raw events) and a summary: mean ± 95% CI over runs
//
// What it scores (DJ craft, from studies of real DJ mixes and DJ practice, not "fewer moves"):
//   sense       per-deck agreement with reference sections (both decks, every 0.5 s); the DJ senses as precision / recall
//   mixing      share of transitions that happen in an outro or breakdown of the outgoing track (vs mid-song)
//   phrasing    share of moves that start on a 4-bar line
//   fit         share of moves that suit their section (space in breaks / outros, flourishes in choruses ...)
//   variety     normalised entropy of the move types, and how often the same move repeats back to back
//   pace        moves per minute (busy above ~2 / min: "cranking knobs every 30 seconds"), time on air per track
//               (real mixes: ~4 min per track)
import { chromium } from './node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const port = process.env.PORT || 8765, mode = process.env.MODE || 'new', runs = +(process.env.RUNS || 3), mins = +(process.env.MIN || 8);
const tracks = JSON.parse(readFileSync(root + 'data/realtracks/tracks.json'));
const labFile = existsSync(root + 'data/realtracks/labels_allin1.json') ? 'labels_allin1.json' : 'labels.json';
const labels = JSON.parse(readFileSync(root + 'data/realtracks/' + labFile));
const cv = process.env.HELD || root + 'data/realtracks/held_out.json';
const held = existsSync(cv) ? JSON.parse(readFileSync(cv)) : JSON.parse(readFileSync(root + 'data/realtracks/sections_eval_trained.json')).held_out_tracks;
const pick = tracks.filter((t) => held.includes(t.slug) && labels[t.name]);

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
    const L = window._b = { samples: [], moves: [], trans: [], seg: [] };
    const labelOf = (d) => { const lab = labels[d.track?.name], bar = Math.floor(d.beatAt() / 4); return lab && bar >= 0 && bar < lab.length ? lab[bar] : null; };
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
      if (!S.dj.pending && pend && L.trans.length) L.trans[L.trans.length - 1].exec = labelOf(d);
      pend = S.dj.pending;
      if (cur && (!full || cur.deck !== d || cur.track !== d.track)) { L.seg.push(t - cur.t0); cur = null; }
      if (full && !cur) cur = { t0: t, deck: d, track: d.track };
    }, 500);
  }, [pick.map((t) => t.name), 1234 + r * 977, mode, labels]);
  await page.waitForTimeout(mins * 60 * 1000);
  const L = await page.evaluate(() => ({ ...window._b, load: window.flyDJ.stats.load }));
  await browser.close();
  return { errs, ...L };
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
    load: L.load,
  };
}
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]));

const all = [];
for (let r = 0; r < runs; r++) {
  const L = await run(r);
  const s = summarize(L);
  all.push({ run: r, summary: s, raw: { moves: L.moves, trans: L.trans, seg: L.seg }, errors: L.errs });
  console.log(`run ${r + 1}/${runs} (${mode}):`, JSON.stringify(s));
}
const agg = {};
for (const [k] of flat(all[0].summary)) {
  const v = all.map((a) => Object.fromEntries(flat(a.summary))[k]).filter((x) => typeof x === 'number');
  if (!v.length) continue;
  const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
  agg[k] = { mean: +m.toFixed(3), ci95: +(1.96 * sd / Math.sqrt(v.length)).toFixed(3), n: v.length };
}
mkdirSync(root + 'data/bench', { recursive: true });
const out = root + `data/bench/${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
writeFileSync(out, JSON.stringify({ mode, runs, mins, tracks: pick.length, labels: labFile, agg, all }, null, 1));
console.log(`\n${mode} summary (mean ± 95% CI over ${runs} runs, ${pick.length} held-out tracks, labels ${labFile}):`);
for (const [k, v] of Object.entries(agg)) console.log(`  ${k.padEnd(36)} ${v.mean} ± ${v.ci95}`);
console.log('saved', out);
