// DJ benchmark: the full app, headless, on held-out real tracks, repeated runs, one number per skill.
//
//   PORT=8766 MODE=v2 RUNS=3 MIN=8 node tools/djbench.mjs
//     MODE  v2 = section sense v2 (sections.js) drives the DJ; v1 = the old rank detector (ListenerSense)
//   -> data/bench/<mode>-<time>.json and a summary: mean ± 95% CI over runs
//
// Tracks: the classifier's held-out tracks (data/realtracks/sections_eval_trained.json), loaded through the app's own
// analysis, so their bars match data/realtracks/labels.json (reference sections from flybrain/sections.py).
// Measured every 0.5 s on the on-air deck, and at every move and transition:
//   sense      precision / recall of "mixing window" (intro|outro), "breakdown" and "main", vs the reference
//   mixing     where the fly starts its transitions (share in the outgoing track's outro / intro / break)
//   moves      where its moves land; time on air per track; load
import { chromium } from './node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const port = process.env.PORT || 8765, mode = process.env.MODE || 'v2', runs = +(process.env.RUNS || 3), mins = +(process.env.MIN || 8);
const tracks = JSON.parse(readFileSync(root + 'data/realtracks/tracks.json'));
const held = JSON.parse(readFileSync(root + 'data/realtracks/sections_eval_trained.json')).held_out_tracks;
const labels = JSON.parse(readFileSync(root + 'data/realtracks/labels.json'));
const pick = tracks.filter((t) => held.includes(t.slug));

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
  const n = await page.evaluate(async ([names, seed, mode, labels]) => {
    const S = window.flyDJ;
    const files = [];
    for (let i = 0; i < names.length; i++) files.push(new File([await (await fetch(`/__track/${i}`)).blob()], names[i] + '.mp3'));
    await S.api.addFiles(files);
    let x = seed; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    S.crate = S.crate.filter((t) => t.source === 'file').sort(() => rnd() - 0.5);
    S.api.loadTrack(0, S.crate[0]); S.api.loadTrack(1, S.crate[1]); S.crateNext = 2;
    S.dj.useSections = mode === 'v2';
    // ---- logging ----
    const L = window._b = { samples: [], moves: [], trans: [], seg: [] };
    const where = () => { const d = S.mixer.onAir(), lab = labels[d.track?.name]; const bar = Math.floor(d.beatAt() / 4);
      return lab && bar >= 0 && bar < lab.length ? lab[bar] : null; };
    const sensed = () => {
      const k = S.mixer.onAir() === S.mixer.decks[0] ? 0 : 1, LS = S.dj.sectionsOn?.() || S.dj.listeners;
      const st = LS?.[k]?.state; return st ? { mix: !!st.MIX, space: !!st.SPACE, peak: !!st.PEAK } : null; };
    const fire = S.dj.fire.bind(S.dj); S.dj.fire = (key, ...a) => { L.moves.push({ key, at: where() }); return fire(key, ...a); };
    const doMove = S.dj.doMove.bind(S.dj); S.dj.doMove = (name, who) => { if (/SPACE|set plan/.test(who || '')) L.moves.push({ key: 'sense:' + name, at: where() }); return doMove(name, who); };
    let pend = null, cur = null;
    setInterval(() => {
      const t = S.ctx.currentTime, d = S.mixer.onAir(), full = S.mixer.airness(d) > 0.99;
      const at = where(), s = sensed();
      if (at && s && S.dj.t > 30) L.samples.push([at, s.mix, s.space, s.peak]);
      if (S.dj.pending && S.dj.pending !== pend) L.trans.push({ style: S.dj.pending.style, at });
      pend = S.dj.pending;
      if (cur && (!full || cur.deck !== d || cur.track !== d.track)) { L.seg.push(t - cur.t0); cur = null; }   // a cut swaps decks at once
      if (full && !cur) cur = { t0: t, deck: d, track: d.track };
    }, 500);
    return S.crate.length;
  }, [pick.map((t) => t.name), 1234 + r * 977, mode, labels]);
  await page.waitForTimeout(mins * 60 * 1000);
  const L = await page.evaluate(() => ({ ...window._b, load: window.flyDJ.stats.load }));
  await browser.close();
  return { n, errs, ...L };
}

const pr = (num, den) => (den ? num / den : null);
function summarize(L) {
  const S = L.samples, cnt = (f) => S.filter(f).length;
  const sense = (on, is) => ({ precision: pr(cnt((s) => s[on] && is(s[0])), cnt((s) => s[on])), recall: pr(cnt((s) => s[on] && is(s[0])), cnt((s) => is(s[0]))) });
  const mixWin = (x) => x === 'intro' || x === 'outro';
  return {
    sense_mixing_window: sense(1, mixWin), sense_breakdown: sense(2, (x) => x === 'break'), sense_main: sense(3, (x) => x === 'main'),
    transitions: L.trans.length, transitions_in_outro_or_intro: pr(L.trans.filter((t) => mixWin(t.at)).length, L.trans.length),
    transitions_mid_main: pr(L.trans.filter((t) => t.at === 'main').length, L.trans.length),
    space_moves_in_breakdown: pr(L.moves.filter((m) => (m.key === 'echo' || m.key.startsWith('sense')) && m.at === 'break').length,
      L.moves.filter((m) => m.key === 'echo' || m.key.startsWith('sense')).length),
    moves: L.moves.length, mean_time_on_air_s: L.seg.length ? L.seg.reduce((a, b) => a + b, 0) / L.seg.length : null, load: L.load,
  };
}
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]));

const all = [];
for (let r = 0; r < runs; r++) {
  const L = await run(r);
  const s = summarize(L);
  all.push({ run: r, ...s, errors: L.errs });
  console.log(`run ${r + 1}/${runs} (${mode}):`, JSON.stringify(s));
}
const keys = flat(all[0]).map(([k]) => k).filter((k) => !['run', 'errors'].includes(k));
const agg = {};
for (const k of keys) {
  const v = all.map((a) => Object.fromEntries(flat(a))[k]).filter((x) => typeof x === 'number');
  if (!v.length) continue;
  const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
  agg[k] = { mean: +m.toFixed(3), ci95: +(1.96 * sd / Math.sqrt(v.length)).toFixed(3), n: v.length };
}
mkdirSync(root + 'data/bench', { recursive: true });
const out = root + `data/bench/${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
writeFileSync(out, JSON.stringify({ mode, runs, mins, tracks: pick.length, agg, all }, null, 1));
console.log('\n' + mode + ' summary (mean ± 95% CI over ' + runs + ' runs):');
for (const [k, v] of Object.entries(agg)) console.log(`  ${k.padEnd(40)} ${v.mean} ± ${v.ci95}`);
console.log('saved', out);
