// DJ benchmark, v3: the full app, headless, on real tracks, repeated runs. It logs raw facts in track time and
// tools/djscore.mjs grades them offline against the All-In-One analysis (beats, downbeats, sections), so any two app
// versions are graded on the same reference, independent of either one's beat grid.
//
//   PORT=8766 MODE=new RUNS=3 MIN=8 SET=random:24:1 node tools/djbench.mjs
//     MODE  new = section sense + phrase-timed, section-fitting moves + the section mixing gate
//           old = the earlier behaviour (rank-detector sense, moves fired at once, no section gate)
//     NEURONS  1 = the neurons decide more (exits at section boundaries, track picks by neuron pattern, move variants by
//              the leading cell type), 0 = the designed rules for those; unset = the app's default (1)
//     SET   heldout          held_out.json (fold 0 of the first crate, kept out of training). It has been the
//                            development set for 10+ bench runs: not a test set any more
//           fresh            test_fresh.json: the first 48 tracks of the label queue, analysed before the grid fit and
//                            exit planner were tuned "over all analysed tracks"
//           random:<n>:<s>   n analysed tracks, drawn with seed s from those never in held_out.json, test_fresh.json,
//                            the first 80 of label_queue.txt or the first crate (recorded to train the section readout):
//                            the honest test set, the same for the same seed
//     HELD=<file>            another list of slugs instead of held_out.json
//   -> data/bench/<mode>-<time>.json (every run's raw record, its v3 scores and the legacy app-grid summary), and the
//      v3 report: mean ± 95% CI over runs (Student t), proportions also pooled (Wilson). Re-score or compare offline:
//      node tools/djscore.mjs FILE.json [OTHER.json]
//
// Works against the app at 6901364 too (an old checkout on another port): every hook is optional, and what a version
// lacks is recorded in the run (raw.missing).
//
// What each run logs (raw facts, scored offline; see djscore.mjs for every measure and why):
//   moves        every decision to play a move: the neuron-group bursts (fire), big bursts and SPACE / set-plan moves
//                (doMove), arousal builds and motor-neuron horns (the Performer called directly). For each: who drove it,
//                the Performer calls and their return times, whether anything sounded, when it is heard (the earliest
//                time any of them schedules), the on-air track and its position in seconds there: as scheduled (pp) and
//                as it played (p)
//   transitions  from the moment one is lined up (dj.pending) to the incoming fully in: style, reason, re-plans,
//                cancelled or fired; the outgoing and incoming tracks' positions at the start, at the landing (the cut,
//                the drop, the blend's first bar) and when the incoming is fully in
//   quiet        every stretch the master output is under -50 dBFS (sampled every 100 ms), whether the music itself was
//                silent there (each audible deck's own signal) and whether any deck was playing
//   air          which track is the on-air deck (crossfader side), from when to when; ends: tracks running out
//   load         the brain's frame load every second; samples: the listener flies' senses every 0.5 s, with positions
//   the old fields stay for comparison (app-grid labels, phrase flags, the old dropout count and on-air stretches)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scoreFile, report, legacySummary } from './djscore.mjs';

// ---------------- the page side (serialised into the page: no outside references) ----------------
// crate: the tracks, shuffled by the run's seed; the first two go on the decks
export async function setup({ names, seed, mode, neurons }) {
  const S = window.flyDJ, files = [];
  for (let i = 0; i < names.length; i++) files.push(new File([await (await fetch(`/__track/${i}`)).blob()], names[i] + '.mp3'));
  await S.api.addFiles(files);
  let x = seed; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  // in name order first: versions of the app add a drop in different orders (one reversed it), and a shuffle has to
  // start from the same list to give the same crate. Then a seeded Fisher-Yates shuffle (a random sort comparator
  // depends on the engine's sort)
  S.crate = S.crate.filter((t) => t.source === 'file').sort((p, q) => (p.name < q.name ? -1 : p.name > q.name ? 1 : 0));
  for (let i = S.crate.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [S.crate[i], S.crate[j]] = [S.crate[j], S.crate[i]]; }
  S.api.loadTrack(0, S.crate[0]); S.api.loadTrack(1, S.crate[1]); S.crateNext = 2;
  const neu = mode === 'new';
  S.dj.useSections = neu; S.dj.phraseMoves = neu; S.dj.sectionFit = neu;
  if (neurons != null && 'neuronsDecide' in S.dj) S.dj.neuronsDecide = neurons;
}

export function instrument({ names, slugs, labels, seed }) {
  const S = window.flyDJ, dj = S.dj, mx = S.mixer, P = S.perf, ctx = S.ctx, decks = mx.decks;
  const now = () => ctx.currentTime, r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
  const L = { v: 3, seed, t0: r3(now()), missing: [], samples: [], moves: [], trans: [], seg: [], dropouts: 0, air: [], quiet: [], load: [], ends: [] };
  const miss = (w) => { if (!L.missing.includes(w)) L.missing.push(w); };
  // the recording runs inside the app's own calls: it may fail, the app's call may not (failures are kept in benchErrors)
  const safe = (f) => { try { return f(); } catch (e) { (L.benchErrors ||= []).length < 20 && L.benchErrors.push(String(e?.stack || e).slice(0, 160)); } };
  const slugOf = new Map(names.map((n, i) => [n.replace(/</g, '‹').replace(/>/g, '›'), slugs[i]]));   // the app's track name → slug
  const slug = (d) => (d?.track ? slugOf.get(d.track.name) ?? null : null);
  L.crateSlugs = S.crate.map((t) => slugOf.get(t.name) ?? null);
  const di = (d) => decks.indexOf(d), spbOf = (d) => 60 / (d?.bpm || 120);
  const labelOf = (d, at) => { const lab = d.track?.sections || labels[d.track?.name], bar = Math.floor(d.beatAt(at) / 4 + 0.02); return lab && bar >= 0 && bar < lab.length ? lab[bar] : null; };
  const known = (d) => { if (typeof dj.whereIs !== 'function') { miss('dj.whereIs'); return null; } return !!dj.whereIs(d)?.known; };
  // a deck's track position at ctx time `at`: as scheduled now (pp), and as it played (p, read once `at` has passed)
  const observe = (o, k, d, at) => {
    if (!d?.track || !Number.isFinite(at)) return;
    const tr = d.track; (o.pp ||= {})[k] = r3(d.position(at)); o.p ||= {};
    setTimeout(() => safe(() => {
      const t = now();
      o.p[k] = d.track === tr && d.playing ? r3(t >= at ? d.position() - (t - at) * d.rate : d.position(at)) : null;
    }), Math.max(0, (at - now()) * 1000));
  };

  // ---- what a decision schedules: every timed call into the decks, the FX rack, the sampler and the crossfader ----
  let open = null;                                  // the decision being recorded
  const timed = (obj, tag, specs) => {
    if (!obj) return miss(tag);
    for (const [name, i] of specs) {
      const f = obj[name];
      if (typeof f !== 'function') { miss(`${tag}.${name}`); continue; }
      obj[name] = function (...a) {
        if (open) { const t = typeof a[i] === 'number' ? a[i] : now(); if (t > now() - 1 && t < now() + 600) open.cap.push(t); }
        return f.apply(this, a);
      };
    }
  };
  decks.forEach((d) => timed(d, 'deck', [['echoThrow', 0], ['loopRoll', 0], ['scratch', 0], ['brake', 0], ['backspin', 0], ['reverse', 0], ['slice', 0], ['jumpTo', 0], ['setStem', 2], ['_duck', 0]]));
  timed(mx.fx, 'fx', [['sweep', 0], ['lowpassDip', 0], ['trans', 0], ['gap', 0], ['crush', 0], ['flange', 0], ['resSweep', 0], ['pump', 0], ['singalong', 0], ['reverbThrow', 0], ['reverbWash', 0]]);
  timed(mx.sampler, 'sampler', [['airhorn', 0], ['siren', 0], ['laser', 0], ['boom', 0], ['riser', 0], ['snareRoll', 0], ['acid', 0], ['downlifter', 0], ['dholRoll', 0], ['co2', 0]]);
  timed(mx, 'mixer', [['cutTo', 1]]);

  // ---- decisions: dj.fire (bursts), dj.doMove (big bursts, SPACE, set plan), the Performer called directly ----
  const TRANS = ['echoOut', 'dropSwap', 'spinCut', 'hardCut', 'doubleDrop', 'killDrop'];
  const PERF = ['beatFx', 'roll', 'scratch', 'brake', 'backspin', 'sample', 'buildDrop', 'chop', 'mashup', 'layer', 'drumsOut', 'melodyOut',
    'stutter', 'reverse', 'bassTease', 'dub', 'resFilter', 'pump', 'singalong', 'fill', 'acid', ...TRANS];
  const WHO = { beatFx: 2, roll: 2, scratch: 2, sample: 1 };      // where each Performer call takes its `who` (else first)
  const KEY = { bassTease: 'tease', drumsOut: 'drumsout', melodyOut: 'melodyout', resFilter: 'resfilter', buildDrop: 'build' };
  const keyOf = (name, a) => (['beatFx', 'scratch', 'sample'].includes(name) ? a[0] : name === 'roll' ? 'roll' : KEY[name] || name);
  const strip = (w) => String(w || '').replace(/<[^>]+>/g, '').trim().slice(0, 90);
  const whoOf = (name, a) => { const w = a[WHO[name] ?? 0]; return strip(typeof w === 'object' ? w?.who : w); };   // ({ who }) or a string
  const driverOf = (w) => (/set plan/.test(w) ? 'plan' : /SPACE|listener/.test(w) ? 'sense' : w === 'the fly' ? 'transition' : w ? 'burst' : 'user');
  const begin = (src, d, who, extra) => {
    const nb = d.playing ? d.nextBeatTime(1) : now(), beat = Math.round(d.beatAt(nb));
    return { v3: 1, src, t: r3(now()), who, driver: driverOf(who), deck: di(d), slug: slug(d), spb: r3(spbOf(d)), known: known(d), cap: [], perf: [],
      at: labelOf(d), phrase: ((beat % 16) + 16) % 16 === 0, bar2: ((beat % 8) + 8) % 8 === 0, ...extra };   // (the old fields: app-grid label and lines)
  };
  let cur = null, curDeck = null, lastBlend = null;  // the transition the tick is firing now; the blend in progress
  const finish = (o, d) => {
    const th = o.cap.length ? Math.min(...o.cap) : null;
    delete o.cap;
    // heard: the earliest scheduled event (a bass tease schedules nothing up front: its bass kill is on the next bar)
    o.th = r3(th ?? (d.playing ? d.nextBarTime() : now()));
    o.played = th !== null || o.perf.some((p) => p[1] !== false);
    o.appBeat = d.track ? r3(d.beatAt(o.th)) : null;
    const tp = o.perf.find((p) => TRANS.includes(p[0]));
    if (!tp) { observe(o, 'pos', d, o.th); L.moves.push(o); return; }
    // the Performer's side of a transition: where it lands and when the incoming is fully in
    let tr = cur, out = curDeck;
    if (!tr) {                                       // not lined up by the tick: the old app's aversion spinback, straight from a burst
      out = d; o.swap = true; L.moves.push(o);
      tr = { v3: 1, legacy: false, driver: 'burst', style: 'spin', reason: 'aversion burst (spinback cut)', t: o.t, tPlan: o.t, fired: o.t, known: o.known,
        outDeck: di(d), outSlug: slug(d), inSlug: slug(decks[1 - di(d)]), outDur: r3(d.duration), outRate: r3(d.rate), spb: o.spb, replans: 0, keys: [d.track?.camelot || null, decks[1 - di(d)].track?.camelot || null], bpms: [d.track?.bpm || null, decks[1 - di(d)].track?.bpm || null] };
      L.trans.push(tr);
    }
    cur = null;
    const inc = decks[1 - di(out)], ret = tp[1];
    tr.method = tp[0]; tr.perf = o.perf; tr.th = o.th;
    if (typeof ret !== 'number') { tr.fellBack = tp[0]; tr.style = 'blend'; blendStarted(tr, out, inc); return; }   // it couldn't: the tick blends instead
    const td = tp[0] === 'doubleDrop' ? o.perf.find((p) => p[0] === 'buildDrop')?.[1] : ret;   // a double drop lands on its drop, is fully in 16 bars later
    tr.tLand = r3(td ?? ret); tr.tFull = r3(ret);
    observe(tr, 'startOut', out, tr.th); observe(tr, 'landOut', out, tr.tLand); observe(tr, 'landIn', inc, tr.tLand);
    observe(tr, 'fullOut', out, tr.tFull); observe(tr, 'fullIn', inc, tr.tFull);
  };
  const blendStarted = (tr, out, inc) => {
    tr.th = tr.fired; tr.tLand = r3(tr.planLand ?? tr.fired);   // the incoming's first bar comes in as the fader starts
    observe(tr, 'startOut', out, tr.fired); observe(tr, 'landOut', out, tr.tLand); observe(tr, 'landIn', inc, tr.tLand);
    lastBlend = { tr, out, inc };
  };
  for (const name of PERF) {
    const f = P[name];
    if (typeof f !== 'function') { miss('perf.' + name); continue; }
    P[name] = function (...a) {
      const top = !open, d = mx.onAir();
      const o = top ? safe(() => (open = begin('perf', d, whoOf(name, a), { key: keyOf(name, a), legacy: false }))) : open;
      let r;
      try { r = f.apply(this, a); }
      finally { if (o) safe(() => o.perf.push([name, typeof r === 'number' ? r3(r) : r === false ? false : null])); if (top) { open = null; if (o) safe(() => finish(o, d)); } }
      return r;
    };
  }
  const wrapDJ = (name, extra) => {
    const f = dj[name];
    if (typeof f !== 'function') return miss('dj.' + name);
    dj[name] = function (...a) {
      if (open) {                                                // part of the decision already open
        if (name !== 'doMove') return f.apply(this, a);
        dj.moveName = null; const r = f.apply(this, a); open.sub ??= dj.moveName ?? a[0]; return r;   // (what played)
      }
      const d = mx.onAir(), o = safe(() => (open = begin(name, d, strip(a[1]), extra(a))));   // fire(key, label, ...), doMove(name, who)
      if (name === 'fire') { if (o) o.driver = 'burst'; dj.played = null; }
      dj.moveName = null;
      let r;
      try { r = f.apply(this, a); }
      finally {
        open = null;
        if (o) safe(() => {
          if (name === 'fire') { o.lkey = dj.played || o.key; o.key = dj.played || o.sub || o.key; }   // the variant played; the old log's key
          if (name === 'doMove' && dj.moveName) o.key = dj.moveName;   // swapped for a short one near the exit
          delete o.sub; finish(o, d);
        });
      }
      return r;
    };
  };
  wrapDJ('fire', (a) => ({ key: a[0], group: a[0], intensity: r3(a[2]) }));
  // the old log kept SPACE / set-plan doMoves only (as "sense:<name>"); big bursts are new in v3
  wrapDJ('doMove', (a) => ({ key: a[0], lkey: 'sense:' + a[0], legacy: /SPACE|set plan/.test(a[1] || '') }));
  const ac = dj.afterCut;
  if (typeof ac !== 'function') miss('dj.afterCut');
  else dj.afterCut = function (at, ...rest) {                    // called with no time when a blend's fader reaches the end
    const r = ac.call(this, at, ...rest);
    if (at == null && lastBlend) safe(() => {
      const { tr, out, inc } = lastBlend; lastBlend = null;
      tr.tFull = r3(now()); tr.reversed = mx.onAir() === out; tr.outStopped = !out.playing;
      observe(tr, 'fullOut', out, now()); observe(tr, 'fullIn', inc, now());
    });
    return r;
  };

  // ---- transitions: dj.pending from lined up to fired (or cancelled) ----
  const LEAD = { blend: 0, echo: 4, spin: 4, cut: 4, kill: 8, drop: 12, double: 12 };
  const recOf = new WeakMap();
  const planned = (p) => {
    const t = now(), d = p.src || mx.onAir(), inc = decks[1 - di(d)];
    const tr = { v3: 1, style: p.style, style0: p.style, reason: p.reason || '', at: labelOf(d), t: r3(t), tPlan: r3(t), planAt: r3(p.at), planLand: r3(p.landT),
      atExit: p.atExit ?? null, exitBar: p.exitBar ?? null, known: known(d), outDeck: di(d), outSlug: slug(d), inSlug: slug(inc), outDur: r3(d.duration), inDur: r3(inc?.duration), replans: 0, pp: { plan: r3(d.position(t)) } };
    if (p.landT === undefined) miss('pending.landT');
    L.trans.push(tr); recOf.set(p, tr);
  };
  const cleared = (p) => {
    const tr = recOf.get(p); if (!tr) return;
    const t = now(), d = p.src || mx.onAir(), inc = decks[1 - di(d)];
    // the old fields: where it lands on the app's own grid (builds that don't record it: the start plus the style's
    // lead), outgoing audio left once the incoming is fully in, keys, tempos
    const land = p.landT ?? p.at + (LEAD[p.style] ?? 4) * 60 / (d.bpm || 120), done = p.style === 'blend' ? p.at + (p.blendBeats || 32) * 60 / (d.bpm || 120) : land;
    Object.assign(tr, { exec: labelOf(d, land), room: d.track ? (d.duration - d.position(done)) / d.rate : null, track: d.track?.name, landBar: +(d.beatAt(land) / 4).toFixed(2),
      mixBar: d.track?.mixBar ?? null, bars: d.track?.sections?.length ?? null, exit: d.track?.exit ?? null, steady: d.track?.steady ?? null,
      keys: [d.track?.camelot || null, inc?.track?.camelot || null], bpms: [d.track?.bpm || null, inc?.track?.bpm || null] });
    if (decks.every((x) => x.playing) && t >= p.at - 0.05 && (!p.src || p.src === mx.onAir())) {   // the tick fires it now
      Object.assign(tr, { fired: r3(t), style: p.style, blendBeats: p.blendBeats ?? null, spb: r3(spbOf(d)), outRate: r3(d.rate) });
      if (p.style === 'blend') blendStarted(tr, d, inc);
      else { cur = tr; curDeck = d; }                // the Performer call that follows finishes it
    } else tr.cancelled = r3(t);
  };
  let pv = dj.pending;
  if (Object.getOwnPropertyDescriptor(dj, 'pending')?.configurable === false) miss('dj.pending');
  else Object.defineProperty(dj, 'pending', { configurable: true, enumerable: true, get: () => pv,
    set: (v) => { const old = pv; pv = v; if (v !== old) safe(() => { if (old) cleared(old); if (v) planned(v); }); } });

  decks.forEach((d) => {                             // tracks running out (on air: the DJ let it end)
    const f = d.onEnded;
    d.onEnded = function (...a) { safe(() => L.ends.push([r3(now()), di(d), slug(d), r3(mx.airness(d))])); return f?.apply(this, a); };
  });

  // ---- every 100 ms: the master level, the on-air track, re-plans; every 0.5 s the old measures; every 1 s the load ----
  const an = ctx.createAnalyser(); an.fftSize = 4096; mx.out.connect(an);
  const buf = new Float32Array(an.fftSize);
  const raw = decks.map((d) => { if (!d.rawTap) { miss('deck.rawTap'); return null; } const a = ctx.createAnalyser(); a.fftSize = 4096; d.rawTap.connect(a); return a; });
  const dBFS = (a) => { a.getFloatTimeDomainData(buf); let e = 0; for (const v of buf) e += v * v; return 10 * Math.log10(e / buf.length + 1e-12); };
  if (!S.stats) miss('stats.load');
  let q = null, air = null, airTrack = null, k = 0, quiet05 = 0, seg = null;
  const tick = () => {
    const t = now(), d = mx.onAir(), db = dBFS(an), every5 = k % 5 === 0, every10 = k % 10 === 0; k++;
    // silences, with whether the music itself was silent and whether anything was playing
    if (db < -50) {
      const aud = decks.filter((x) => x.playing && mx.airness(x) > 0.01);
      q ||= { t0: t, track: true, dead: true };
      q.track &&= aud.every((x) => raw[di(x)] && dBFS(raw[di(x)]) < -50); q.dead &&= !aud.length;
    } else if (q) { L.quiet.push([r3(q.t0), r3(t), q.track, q.dead]); q = null; }
    // the on-air deck and its track
    if (!air || air.deck !== di(d) || airTrack !== d.track) {
      if (air) L.air.push({ ...air, t1: r3(t) });
      air = { deck: di(d), slug: slug(d), t0: r3(t) }; airTrack = d.track;
    }
    // a transition re-planned in place (overdue, or no room left for its style)
    const tr = pv && recOf.get(pv);
    if (tr && (r3(pv.at) !== tr.planAt || pv.style !== tr.style)) { tr.replans++; tr.planAt = r3(pv.at); tr.planLand = r3(pv.landT); tr.style = pv.style; }
    if (cur && t - cur.fired > 1) { cur.noPerf = true; cur = null; }
    if (every5) {
      // the old dropout count (kept for comparison): every 0.5 s, not while the performer is busy or 2 s after a lock
      const intended = P.busy?.() || t < mx.lockUntil + 2;
      if (db < -50 && d.playing && !intended) { quiet05 += 0.5; if (quiet05 === 1) L.dropouts++; } else quiet05 = 0;
      // the old on-air stretches (full airness)
      const full = mx.airness(d) > 0.99;
      if (seg && (!full || seg.deck !== d || seg.track !== d.track)) { L.seg.push(t - seg.t0); seg = null; }
      if (full && !seg) seg = { t0: t, deck: d, track: d.track };
      // the listener flies' senses on both decks, with where each deck is
      if (dj.t > 30) decks.forEach((dk, i) => {
        if (!dk.playing) return;
        const st = (dj.sectionsOn?.() || dj.listeners)?.[i]?.state; if (!st) return;
        L.samples.push([labelOf(dk), !!st.MIX, !!st.SPACE, !!st.PEAK, st.section || null, dk === d, slug(dk), r3(dk.position())]);
      });
    }
    if (every10) L.load.push([r3(t), r3(S.stats?.load)]);
  };
  setInterval(() => safe(tick), 100);
  window._bench = {
    collect() {                                      // a copy, with the silence and the on-air stretch still open closed now
      const t = now(), out = JSON.parse(JSON.stringify(L));
      if (q) out.quiet.push([r3(q.t0), r3(t), q.track, q.dead, 'open']);
      if (air) out.air.push({ ...air, t1: r3(t), open: true });
      // (analysed counted at the end: analyses arrive while the run plays)
      return Object.assign(out, { t1: r3(t), analysed: S.crate.filter((x) => x.gridSource).length, crate: S.crate.length,
        grids: Object.fromEntries(S.crate.map((x) => [slugOf.get(x.name) ?? x.name, { bpm: x.bpm, firstBeat: r3(x.firstBeat), source: x.gridSource || 'browser',
          steady: x.steady ?? null, meter: x.meter ?? null, mixBar: x.mixBar ?? null, exit: x.exit ?? null, bars: x.sections?.length ?? null }])) });
    },
  };
}

// ---------------- the test set ----------------
// a seeded draw (mulberry32), the same for the same seed on any machine
const draw = (list, n, seed) => {
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const s = [...list].sort();
  for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
  return s.slice(0, n);
};
export function pickSet(SET, data, held = process.env.HELD) {
  const rt = data + '/realtracks/', J = (f) => JSON.parse(readFileSync(rt + f));
  const tracks = [...J('tracks.json'), ...(existsSync(rt + 'tracks_more.json') ? J('tracks_more.json') : [])];
  const analysed = (t) => existsSync(rt + `allin1/${t.slug}.json`);
  if (SET.startsWith('random:')) {
    const [, n, seed] = SET.split(':');
    if (!(+n > 0) || !Number.isInteger(+seed)) throw new Error(`SET=${SET}: use random:<n>:<seed>, e.g. random:24:1`);
    const used = new Set([...J('held_out.json'), ...J('test_fresh.json'), ...readFileSync(rt + 'label_queue.txt', 'utf8').split('\n').slice(0, 80).map((x) => x.trim()).filter(Boolean)]);
    const rec = (s) => existsSync(rt + `rec_trained/${s}.npz`) || existsSync(rt + `rec_naive/${s}.npz`);     // recorded to train the section readout
    const pool = tracks.filter((t) => analysed(t) && !used.has(t.slug) && !rec(t.slug)).map((t) => t.slug);
    const want = draw(pool, +n, +seed);
    return { pick: want.map((s) => tracks.find((t) => t.slug === s)), pool: pool.length };
  }
  const list = SET === 'fresh' ? J('test_fresh.json')
    : held ? JSON.parse(readFileSync(held)) : existsSync(rt + 'held_out.json') ? J('held_out.json') : J('sections_eval_trained.json').held_out_tracks;
  // a track counts if it has a reference: its All-In-One analysis (the app applies it) or a label list
  const labels = existsSync(rt + 'labels_allin1.json') ? J('labels_allin1.json') : J('labels.json');
  return { pick: tracks.filter((t) => list.includes(t.slug) && (labels[t.name] || analysed(t))) };
}

// ---------------- the runs ----------------
async function main() {
  const { chromium } = await import('./node_modules/playwright-core/index.mjs');
  const root = new URL('..', import.meta.url).pathname, data = process.env.DATA || root + 'data';
  const port = process.env.PORT || 8765, mode = process.env.MODE || 'new', runs = +(process.env.RUNS || 3), mins = +(process.env.MIN || 8);
  const SET = process.env.SET || 'heldout';
  // NEURONS=1 / 0: the neurons decide more (exits, track picks, move variants) or the designed rules; unset: the app's default
  const neurons = process.env.NEURONS == null ? null : process.env.NEURONS !== '0';
  const { pick, pool } = pickSet(SET, data);
  if (SET === 'heldout') console.log('note: the held-out set has been the development set; SET=random:<n>:<seed> draws unused tracks');
  if (pool !== undefined) console.log(`SET ${SET}: ${pick.length} of ${pool} never-used analysed tracks: ${pick.map((t) => t.slug).join(', ')}`);
  const labFile = existsSync(data + '/realtracks/labels_allin1.json') ? 'labels_allin1.json' : 'labels.json';
  const labels = JSON.parse(readFileSync(data + '/realtracks/' + labFile));
  const all = [];
  for (let r = 0; r < runs; r++) {
    const seed = 1234 + r * 977;
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
    await page.evaluate(setup, { names: pick.map((t) => t.name), seed, mode, neurons });
    await page.evaluate(instrument, { names: pick.map((t) => t.name), slugs: pick.map((t) => t.slug), labels, seed });
    await page.waitForTimeout(mins * 60 * 1000);
    const raw = await page.evaluate(() => window._bench.collect());
    await browser.close();
    const one = { run: r, seed, summary: legacySummary(raw, (raw.t1 - raw.t0) / 60 || mins), raw, errors: errs };
    all.push(one);
    const s = scoreFile({ mins, all: [one] }).scores[0]?.metrics || {}, v = (k) => (s[k]?.n !== undefined ? `${s[k].k}/${s[k].n}` : s[k] !== undefined ? +(+s[k]).toFixed(2) : '—');
    console.log(`run ${r + 1}/${runs} (${mode}): ${v('trans.all.n')} transitions, moves ${v('moves.all.per_min')}/min, moves on a bar ${v('moves.all.on_bar')},`
      + ` dropouts ${v('silence.dropouts_per_10min')}/10 min, on air ${v('air.complete_mean_s')} s, load ${v('load.mean')}${raw.missing.length ? `; app lacks ${raw.missing.join(', ')}` : ''}${errs.length ? `; ${errs.length} page errors` : ''}`);
  }
  mkdirSync(data + '/bench', { recursive: true });
  const out = data + `/bench/${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  const file = { v: 3, mode, neurons, set: SET, port, runs, mins, tracks: pick.length, slugs: pick.map((t) => t.slug), labels: labFile, all };
  writeFileSync(out, JSON.stringify(file, null, 1));                  // the raw record first: scoring can't lose it
  const sc = scoreFile(file);
  Object.assign(file, { agg: sc.legacy, score: sc.agg });
  writeFileSync(out, JSON.stringify(file, null, 1));
  console.log(report(out, sc, file));
  console.log('saved', out);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
