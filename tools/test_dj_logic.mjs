// DJ decision tests in plain Node: the app's own Mixer, Deck, Performer and FlyDJ on a stand-in for Web Audio that
// records every AudioParam call, with ctx time stepped by hand. No browser, no server, no brain: the fly's neurons
// are left silent and each test puts the decks where it needs them.
//
//   node tools/test_dj_logic.mjs
import { Mixer } from '../web/js/decks.js';
import { Performer } from '../web/js/perform.js';
import { FlyDJ } from '../web/js/flydj.js';

// ---- a stand-in AudioContext: nodes connect anywhere, params keep their call log
class Param {
  constructor(v = 1) { this.value = v; this.calls = []; }
  _rec(name, ...a) { this.calls.push([name, ...a]); return this; }
  setValueAtTime(v, t) { return this._rec('set', v, t); }
  linearRampToValueAtTime(v, t) { return this._rec('lin', v, t); }
  exponentialRampToValueAtTime(v, t) { return this._rec('exp', v, t); }
  setTargetAtTime(v, t, tau) { return this._rec('target', v, t, tau); }
  cancelScheduledValues(t) { return this._rec('cancel', t); }
  cancelAndHoldAtTime(t) { return this._rec('hold', t); }
}
const PARAMS = ['gain', 'frequency', 'Q', 'delayTime', 'playbackRate', 'threshold', 'knee', 'ratio', 'attack', 'release', 'detune', 'pan', 'offset'];
class Node {
  constructor() { for (const p of PARAMS) this[p] = new Param(); this.parameters = new Map([['pitch', new Param()]]); }
  connect(n) { return n; } disconnect() {} start() {} stop() {}
}
class Buf {
  constructor(ch, n, sr) { this.numberOfChannels = ch; this.length = n; this.sampleRate = sr; this.duration = n / sr; this._d = Array.from({ length: ch }, () => new Float32Array(Math.min(n, 1 << 16))); }
  getChannelData(c) { return this._d[c]; }
}
class Ctx {
  constructor() { this.currentTime = 0; this.sampleRate = 44100; this.destination = new Node(); }
  createBuffer(ch, n, sr) { return new Buf(ch, n, sr); }
}
for (const k of ['Gain', 'BiquadFilter', 'DynamicsCompressor', 'Delay', 'Convolver', 'WaveShaper', 'Oscillator', 'BufferSource', 'StereoPanner', 'Analyser', 'ConstantSource'])
  Ctx.prototype['create' + k] = () => new Node();

// setTimeout callbacks the app schedules (crossfader position after a cut): run them as ctx time passes
let timers = [];
globalThis.setTimeout = (f, ms = 0) => { timers.push({ f, at: CTX.currentTime + ms / 1000 }); return timers.length; };
globalThis.clearTimeout = () => {};
globalThis.window = {};
globalThis.performance ??= { now: () => CTX.currentTime * 1000 };

let CTX;
const silentEars = { habit: [0, 0], resetHabit() {} };
const synth = { setLevel() {}, zap() {}, root: 0, scale: [0, 2, 4, 5, 7, 9, 11] };
const track = (name, { bpm = 128, dur = 300, sections = null, mixBar = null, steady = true, exit = 'blend' } = {}) =>
  ({ name, bpm, firstBeat: 0, buffer: new Buf(2, Math.round(dur * 44100), 44100), sections, mixBar, steady, exit, cues: [] });
const analysed = (name, bars, mixBar, opt = {}) => track(name, { dur: bars * 4 * 60 / 128, sections: Array.from({ length: bars }, (_, i) => (i >= mixBar ? 'outro' : i < 8 ? 'intro' : 'chorus')), mixBar, ...opt });

function setup({ a, b, x = 0 } = {}) {
  CTX = new Ctx(); timers = [];
  const mixer = new Mixer(CTX), log = [];
  const perf = new Performer(mixer, synth, (s) => log.push(s));
  const dj = new FlyDJ(mixer, silentEars, synth, perf, [], (s) => log.push(s));
  dj.t = 100;
  const [A, B] = mixer.decks;
  if (a) { A.load(a); A.rate = mixer.rateFor(a, a.bpm); A.play(0, 0); }
  if (b) { B.load(b); B.rate = mixer.rateFor(b, a?.bpm ?? b.bpm); B.play(0, 0); }
  mixer.masterBpm = a?.bpm ?? 128; mixer.setCrossfader(x);
  return { mixer, perf, dj, log, A, B };
}
// advance ctx time by `secs`, ticking the DJ at 40 Hz and firing due timers
function run(dj, secs) {
  for (let t = 0; t < secs; t += 0.025) {
    CTX.currentTime += 0.025;
    const due = timers.filter((q) => q.at <= CTX.currentTime); timers = timers.filter((q) => q.at > CTX.currentTime);
    for (const q of due) q.f();
    dj.tick(0.025);
  }
}
const R = {};
const check = (name, ok, info = {}) => { R[name] = { ok: !!ok, ...info }; };
let nTest = 0;
const test = (f) => { nTest++; try { f(); } catch (e) { R[`test_${nTest}_threw`] = { ok: false, error: e.message }; } };

// 1. the deck that just left the air is reloaded, even with minutes of its track left
test(() => {
  const long = track('long extended mix', { dur: 420 }), next = track('next', { dur: 200 });
  const { dj, mixer, A } = setup({ a: long, b: next, x: 0 });
  let reloaded = null;
  dj.onLoadNext = (i) => { reloaded = i; mixer.decks[i].load(track('fresh')); mixer.decks[i].play(CTX.currentTime, 0); };
  run(dj, 12);                                             // A has had its turn (a quick nudge wouldn't count)
  mixer.cutTo(1, CTX.currentTime + 0.1);                  // the fly cut over to B; A has ~6 min left
  run(dj, 4);
  check('played_deck_reloaded', reloaded === 0 && A.track.name === 'fresh', { reloaded, onA: A.track.name });
  // and again on the next round, with the first reload long past
  run(dj, 20); mixer.cutTo(0, CTX.currentTime + 0.1); run(dj, 20);     // back to A ('fresh') for a while
  reloaded = null; mixer.cutTo(1, CTX.currentTime + 0.1); run(dj, 1.5);
  check('played_guard_holds_second_round', mixer.decks[0].spent === mixer.decks[0].track && reloaded === null, { spent: !!mixer.decks[0].spent });
  run(dj, 3);
  check('played_deck_reloaded_second_round', reloaded === 0, { reloaded });
});
// 1b. before it is reloaded, no transition is decided into it
test(() => {
  const { dj, mixer } = setup({ a: track('one', { dur: 420 }), b: track('two', { dur: 200 }), x: 0 });
  dj.auto = false; run(dj, 12);                             // A plays a while (tracked with the autopilot off too)
  mixer.cutTo(1, CTX.currentTime + 0.1); run(dj, 0.2);
  dj.auto = true; dj.minOnAir = 0; dj.persona = { ...dj.persona, onAir: [0, 1] };   // now it leaves any track after 1 s
  run(dj, 2.5);                                            // the 3 s before the old deck is reloaded
  check('no_transition_into_played_track', !dj.pending, { pending: dj.pending?.style });
});

// 2. half-time track: the fold is kept while the master tempo moves, and the glide aims at its tempo in the set
test(() => {
  const { mixer } = setup({ a: track('house', { bpm: 128 }) });
  const half = track('half-time', { bpm: 66 });
  mixer.decks[1].load(half);
  const r0 = mixer.rateFor(half, 128), rates = [];
  for (let bpm = 128; bpm >= 66; bpm -= 0.5) rates.push(mixer.rateFor(half, bpm));
  const jump = Math.max(...rates.slice(1).map((r, i) => Math.abs(r / rates[i] - 1)));
  check('fold_kept_through_glide', Math.abs(r0 - 128 / 132) < 1e-9 && jump < 0.01, { r0: +r0.toFixed(3), worstStep: +jump.toFixed(4) });
  check('tempo_of_half_time_track', Math.abs(mixer.tempoOf(half) - 132) < 1e-9, { tempoOf: mixer.tempoOf(half) });
  mixer.decks[1].load(half);                              // a new load picks the fold afresh
  check('fold_repicked_on_load', Math.abs(mixer.rateFor(half, 70) - 70 / 66) < 1e-9);
  half.bpm = 132;                                         // a tempo correction (½× / 2×) re-picks it too
  check('fold_repicked_on_tempo_fix', Math.abs(mixer.rateFor(half, 128) - 128 / 132) < 1e-9);
});

// 3. double drop at the planned exit: only with 8+ bars of the outgoing track left after it lands
test(() => {
  for (const [after, want] of [[6, false], [12, true]]) {
    const out = analysed('outgoing', 64 + after, 64), inc = analysed('incoming', 100, 90);
    const { dj, A } = setup({ a: out, b: inc, x: 0 });
    A.play(CTX.currentTime, 60 * 4 * 60 / 128);           // bar 60: the exit (bar 64) is 4 bars ahead
    check(`double_allowed_${after}_bars_after_exit`, dj.exitStyles(true).includes('double') === want, { styles: dj.exitStyles(true).join(',') });
  }
});
// 3b. a double drop that fires is sized to what is left (or becomes a drop swap)
test(() => {
  const out = analysed('outgoing', 76, 64), inc = analysed('incoming', 100, 90);
  const { dj, perf, A } = setup({ a: out, b: inc, x: 0 });
  let got = null;
  perf.doubleDrop = (o) => { got = o; return false; };
  perf.dropSwap = () => { got = { swap: true }; return false; };
  const spb = 60 / 128;
  dj.pending = { at: CTX.currentTime + 0.05, landT: A.timeOfBeat(64 * 4), style: 'double', dir: 1, blendBeats: 32, src: A };
  A.play(CTX.currentTime, 61 * 4 * spb);                   // land at bar 64, 12 bars left after it
  dj.pending.landT = A.timeOfBeat(64 * 4);
  run(dj, 0.1);
  check('double_sized_to_room', got && got.bars <= 11 && got.bars >= 4, { got });
});

// 4. long moves don't run past the planned exit
test(() => {
  const out = analysed('outgoing', 80, 40), inc = analysed('incoming', 100, 90);
  const { dj, A } = setup({ a: out, b: inc, x: 0 });
  A.play(CTX.currentTime, 30 * 4 * 60 / 128);             // bar 30: 24 beats to the exit's decision line (bar 36)
  check('exit_room', Math.abs(dj.exitRoom() - 24) < 0.1, { room: dj.exitRoom() });
  check('build_shrinks_to_fit', dj.buildBars(8) === 2, { bars: dj.buildBars(8) });
  let played = null;
  dj.perf.mashup = () => { played = 'mashup'; }; dj.perf.beatFx = (k) => { played = k; };
  dj.doMove('mashup', 'test');
  check('mashup_replaced_near_exit', played === 'echo', { played });
});

// 5. time on air keeps counting through a mashup's fader position; a blend pauses it
test(() => {
  const { dj, mixer } = setup({ a: track('one'), b: track('two'), x: 0 });
  run(dj, 1); const t0 = dj.onAirSince;
  mixer.setCrossfader(0.42); run(dj, 2);
  check('on_air_clock_through_mashup', dj.onAirSince > t0 + 1.9, { before: +t0.toFixed(2), after: +dj.onAirSince.toFixed(2) });
});

// 6. autopilot off forgets a lined-up transition
test(() => {
  const { dj, A } = setup({ a: track('one'), b: track('two'), x: 0 });
  dj.pending = { at: 1e9, landT: 1e9, style: 'blend', dir: 1, src: A };
  dj.auto = false; run(dj, 0.1);
  check('autopilot_off_clears_pending', dj.pending === null);
});

// 7. spinback: the deck stays muted from the spin until the cut lands
test(() => {
  const { perf, A } = setup({ a: track('one'), b: track('two'), x: 0 });
  CTX.currentTime = 9.6;                                  // next beat 21: the 2-beat spin ends a beat before the bar line
  const land = perf.spinCut('test');
  const covered = A.ducks.some(([a, b]) => a <= 9.9 && b >= land - 1e-6);
  check('spinback_muted_until_cut', covered, { land: +land.toFixed(3), ducks: A.ducks.map((d) => d.map((v) => +v.toFixed(3))) });
});

// 8. double drop / tease EQ kills are on the audio clock; moves hold the tempo until their last event
test(() => {
  const { perf, B } = setup({ a: track('one'), b: track('two'), x: 0 });
  CTX.currentTime = 5;
  const end = perf.doubleDrop({ bars: 8 });
  const kills = B.low.gain.calls.filter((c) => c[0] === 'target');
  const killAt = kills.find((c) => c[1] === -40)?.[2], backAt = kills.find((c) => c[1] === 0 && c[2] > 5.1)?.[2];
  check('double_drop_eq_on_audio_clock', killAt > 5 && Math.abs(backAt - end) < 1e-6, { killAt, backAt, end });
  check('tempo_held_through_double_drop', perf.holdUntil >= end, { holdUntil: perf.holdUntil, end });
});

// 9. beat FX follow the on-air deck's beat (a folded track's grid), and filter moves continue from where they are
test(() => {
  const { mixer } = setup({ a: track('half-time', { bpm: 64 }) });
  mixer.decks[0].rate = mixer.rateFor(mixer.decks[0].track, 128);   // folded: plays at 128 in the set, beats every 0.94 s
  mixer.setTempo(128);
  check('fx_on_deck_grid', Math.abs(mixer.fx.spb - 60 / (64 * mixer.decks[0].rate)) < 1e-9, { spb: mixer.fx.spb });
  mixer.fx.lowpassDip(1, 4); mixer.fx.lowpassDip(2, 4);
  const f = mixer.fx.lp.frequency.calls;
  // the first, on an idle filter, pins its resting value at its start (else its ramp would start at once); the second,
  // inside the first, carries on from wherever the first one is (no snap back to 22 kHz)
  const first = f.findIndex((c) => c[0] === 'set' && c[1] === 22000 && c[2] === 1), hold = f.findIndex((c) => c[0] === 'hold' && c[1] === 2);
  check('filter_moves_hold_not_snap', first >= 0 && hold > first && f.filter((c) => c[0] === 'set' && c[1] === 22000).length === 1, { calls: f.map((c) => c.join(' ')) });
});

// 10. a cut ramps (no hard gain step)
test(() => {
  const { mixer, A } = setup({ a: track('one'), b: track('two'), x: 0 });
  mixer.cutTo(1, 3);
  const c = A.xf.gain.calls.at(-1);
  check('cut_ramps', c[0] === 'target' && c[2] === 3 && c[3] > 0 && c[3] < 0.005, { last: c });
});

// 11. the fader position follows the audio clock: no timer needs to fire (a hidden page's timers lag a second)
test(() => {
  const { mixer, A, B } = setup({ a: track('one'), b: track('two'), x: 0 });
  mixer.cutTo(1, 2);
  CTX.currentTime = 1.9; const before = mixer.onAir();
  CTX.currentTime = 2.0; const after = mixer.onAir();          // (timers deliberately not run)
  check('fader_follows_audio_clock', before === A && after === B && mixer.x === 1, { before: before.name, after: after.name });
});

// 12. a quick manual nudge to the other deck and back doesn't mark it played; a real turn does, and it gets reloaded
//     even when you held the fader for a while
test(() => {
  const { dj, mixer, A, B } = setup({ a: track('one', { dur: 400 }), b: track('two', { dur: 400 }), x: 0 });
  let reloads = 0;
  dj.onLoadNext = (i) => { reloads++; mixer.decks[i].load(track('fresh' + reloads, { dur: 400 })); mixer.decks[i].play(CTX.currentTime, 0); };
  run(dj, 60);
  dj.userHold = 8; mixer.setCrossfader(1); run(dj, 2); mixer.setCrossfader(0); run(dj, 10);
  check('nudge_not_spent', !B.spent && reloads === 0, { spentB: !!B.spent, reloads });
  run(dj, 30); mixer.cutTo(1, CTX.currentTime + 0.1); dj.userHold = 8; run(dj, 15);
  check('real_turn_reloaded_after_hold', reloads === 1 && A.track.name === 'fresh1', { reloads, onA: A.track.name });
});

// 13. a drop swap's tempo hold ends at the drop (the new track's tempo snaps there, not a bar later)
test(() => {
  const { perf } = setup({ a: track('one'), b: track('two'), x: 0 });
  CTX.currentTime = 5;
  const Td = perf.dropSwap('test');
  check('drop_swap_hold_ends_at_drop', Td && Math.abs(perf.holdUntil - Td) < 0.05, { Td, holdUntil: perf.holdUntil });
});

// 14. an echo throw on an idle send starts from 0 at its time, not ramping up from the moment it's scheduled
test(() => {
  const { A } = setup({ a: track('one'), b: track('two'), x: 0 });
  A.echoThrow(3, 1);
  const c = A.echoSend.gain.calls;
  check('idle_send_pinned_at_start', c.some((x) => x[0] === 'set' && x[1] === 0 && x[2] === 3) && !c.some((x) => x[0] === 'hold'), { calls: c.map((x) => x.join(' ')) });
});

// 15. the neurons pick the exit: a DJ fly steering toward the other deck leaves an analysed track at an earlier section
// boundary (here the breakdown at bar 60), landing on it; a content fly waits for the planned exit; never in the first half
const shaped = (name) => track(name, { dur: 112 * 4 * 60 / 128, mixBar: 96, sections: Array.from({ length: 112 }, (_, i) =>
  (i < 8 ? 'intro' : i < 60 ? 'chorus' : i < 76 ? 'break' : i < 96 ? 'chorus' : 'outro')) });
for (const [pref, startBar, want, name] of [[0.5, 52, 60, 'neurons_pick_early_exit'], [0, 52, null, 'content_fly_waits_for_planned_exit'],
                                            [-0.5, 52, null, 'fly_steering_to_on_air_deck_stays'], [0.5, 2, null, 'no_neuron_exit_in_first_half']]) {
  test(() => {
    const { dj, A } = setup({ a: shaped('outgoing'), b: analysed('incoming', 100, 90), x: 0 });
    dj.minOnAir = 0; dj.pref = pref;
    A.play(CTX.currentTime, startBar * 4 * 60 / 128);
    run(dj, 9);                                            // past the boundary's decision line (4 bars ahead of it)
    const p = dj.pending, landsOn = p && Math.abs(p.landT - A.timeOfBeat((p.exitBar ?? 0) * 4)) < 0.05;
    check(name, want == null ? !p : p?.exitBar === want && landsOn, { pending: p && { style: p.style, exitBar: p.exitBar, reason: p.reason } });
  });
}

// 16. the next track is picked by the pattern of neurons it excites: an aroused DJ fly keeps the sound going (the
// candidate whose listener response looks like the on-air track's), a calm one changes it up (the most different)
for (const [arousal, order, want] of [[1.3, ['contrast', 'similar'], 'similar'], [0.7, ['similar', 'contrast'], 'contrast']]) {
  test(() => {
    const { dj } = setup({ a: track('on air'), b: track('old'), x: 0 });
    let picked = null;
    dj.picker = { choose: (i, t) => { picked = t.name; } };
    dj.arFast = arousal; dj.arSlow = 1;
    dj.airPrint = () => Float32Array.from([1, 0, 0.2]);
    const dev = { similar: [0.9, 0.1, 0.2], contrast: [-0.8, 0.3, -0.1] };
    dj.aud = { deck: 1, cands: order.map((n) => track(n)), scores: [100, 100], devs: order.map((n) => Float32Array.from(dev[n])) };
    dj.finishAudition();
    check(`pick_${want}_when_${arousal > 1 ? 'aroused' : 'calm'}`, picked === want, { picked });
  });
}

// 17. the cell type that led a burst picks the move's variant (echo group: DNp02 echo, DNp06 reverb, DNp11 dub)
test(() => {
  const { dj } = setup({ a: track('one'), b: track('two'), x: 0 });
  dj.perf.dub = () => {}; dj.perf.beatFx = () => {};
  dj.fire('echo', 'echo group', 1.5, 0, 2);
  check('leading_type_picks_variant', dj.played === 'dub', { played: dj.played });
});

let fails = 0;
for (const [k, v] of Object.entries(R)) { if (!v.ok) fails++; console.log(`${v.ok ? 'pass' : 'FAIL'}  ${k}  ${JSON.stringify(v)}`); }
process.exit(fails ? 1 : 0);
