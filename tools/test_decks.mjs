// Deck scheduling tests: real Web Audio (OfflineAudioContext in headless Chromium), the app's own Deck.
// The test track is a ramp (sample value = position / length), so the rendered output says which position played
// when, and two sources sounding at once show up as a wrong (summed) value.
//
//   PORT=8766 node tools/test_decks.mjs        (needs the app's server running on PORT)
import { launchChrome } from './chrome.mjs';

const port = process.env.PORT || 8766, base = `http://127.0.0.1:${port}`;
const browser = await launchChrome({ headless: true });
const page = await browser.newPage();
await page.goto(base + '/js/decks.js');

const results = await page.evaluate(async () => {
  const { Deck } = await import('/js/decks.js');
  const SR = 8000, LEN = 120, DUR = 3;
  const ramp = (ctx) => { const b = ctx.createBuffer(1, SR * LEN, SR), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = i / SR / LEN; return b; };
  const ones = (ctx) => { const b = ctx.createBuffer(1, SR * LEN, SR); b.getChannelData(0).fill(1); return b; };
  // render one scenario: steps = [[ctx time, deck => ...], ...] run at those times (OfflineAudioContext.suspend, which
  // rounds to 128-frame blocks: 16 ms here, so the step times below are multiples of 0.016)
  async function render(steps, { tap = 'raw', buffer = ramp } = {}) {
    const ctx = new OfflineAudioContext(1, SR * DUR, SR);
    const deck = new Deck(ctx, 'A', { master: ctx.createGain(), echoIn: ctx.createGain() });
    deck.track = { buffer: buffer(ctx), bpm: 120, firstBeat: 0, name: 'test' };
    (tap === 'raw' ? deck.rawTap : deck.slip).connect(ctx.destination);
    const notes = {};
    for (const [t, f] of steps) {
      if (t === 0) { f(deck, notes); continue; }
      ctx.suspend(t).then(() => { f(deck, notes); ctx.resume(); });
    }
    const out = await ctx.startRendering();
    return { y: out.getChannelData(0), notes };
  }
  // compare the output with the expected position (seconds, or null = silence) away from the 10 ms crossfades
  const check = (y, expect, edges, scale = LEN) => {
    let worst = 0, at = null;
    for (let i = 0; i < y.length; i++) {
      const t = i / SR;
      if ([0, ...edges].some((e) => Math.abs(t - e) < 0.012)) continue;
      const want = expect(t), got = y[i] * scale, err = Math.abs(got - (want ?? 0));
      if (err > worst) { worst = err; at = t; }
    }
    return { ok: worst < 0.01, worst: +worst.toFixed(4), at };
  };
  const R = {};

  // 1. one scheduled jump
  let r = await render([[0, (d) => d.play(0, 10)], [0.256, (d, n) => { d.jumpTo(1.0, 30); n.p05 = d.position(0.5); n.p15 = d.position(1.5); n.t31 = d.timeOfBeat(62); }]]);
  R.single_jump = { ...check(r.y, (t) => (t < 1 ? 10 + t : 30 + t - 1), [1.0]),
    position_ok: Math.abs(r.notes.p05 - 10.5) < 1e-6 && Math.abs(r.notes.p15 - 30.5) < 1e-6, time_of_beat_ok: Math.abs(r.notes.t31 - 2.0) < 1e-6 };

  // 2. a second jump scheduled before the first one: the first never happens, the old source stops at the second
  r = await render([[0, (d) => d.play(0, 10)], [0.256, (d) => d.jumpTo(1.0, 30)], [0.304, (d) => d.jumpTo(0.5, 50)]]);
  R.double_jump_earlier = check(r.y, (t) => (t < 0.5 ? 10 + t : 50 + t - 0.5), [0.5, 1.0]);

  // 3. a second jump after the first: both happen, and the timeline knows about both
  r = await render([[0, (d) => d.play(0, 10)], [0.256, (d, n) => { d.jumpTo(1.0, 30); d.jumpTo(1.5, 60); n.p12 = d.position(1.2); n.p2 = d.position(2); }]]);
  R.double_jump_later = { ...check(r.y, (t) => (t < 1 ? 10 + t : t < 1.5 ? 30 + t - 1 : 60 + t - 1.5), [1.0, 1.5]),
    position_ok: Math.abs(r.notes.p12 - 30.2) < 1e-6 && Math.abs(r.notes.p2 - 60.5) < 1e-6 };

  // 4. stop while a jump is pending: silence, nothing plays on until the jump time
  r = await render([[0, (d) => d.play(0, 10)], [0.256, (d) => d.jumpTo(1.0, 30)], [0.512, (d) => d.stop()]]);
  R.stop_while_pending = check(r.y, (t) => (t < 0.512 ? 10 + t : null), [0.512]);

  // 5. new sources (stems arriving) while a jump is pending: the jump still happens
  r = await render([[0, (d) => d.play(0, 10)], [0.256, (d) => d.jumpTo(1.0, 30)], [0.512, (d) => d.respawn(0.75)]]);
  R.respawn_keeps_jump = check(r.y, (t) => (t < 1 ? 10 + t : 30 + t - 1), [0.75, 1.0]);

  // 6. next bar after a jump back: the bar line coming up, not the same beat's earlier pass
  r = await render([[0, (d) => d.play(0, 10)], [0.256, (d, n) => { d.jumpTo(0.5, 8); n.bar = d.nextBarTime(0.6); }]]);
  R.next_bar_after_jump_back = { ok: Math.abs(r.notes.bar - 2.5) < 1e-6, got: r.notes.bar };   // 8.1 s in -> bar line at 10 s, heard at 2.5

  // 7. overlapping ducks merge: the lowest level wins, the track comes back when the last one ends
  r = await render([[0, (d) => { d.play(0, 10); d._duck(0.2, 0.6, 0); d._duck(0.4, 0.2, 0.45); d._duck(1.0, 0.5, 0.45); }]], { tap: 'slip', buffer: ones });
  R.duck_merge = check(r.y, (t) => (t >= 0.2 && t < 0.8 ? 0 : t >= 1.0 && t < 1.5 ? 0.45 : 1), [0.2, 0.4, 0.6, 0.8, 1.0, 1.5], 1);
  return R;
});

await browser.close();
let fails = 0;
for (const [k, v] of Object.entries(results)) {
  const ok = v.ok && v.position_ok !== false && v.time_of_beat_ok !== false;
  if (!ok) fails++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${k}  ${JSON.stringify(v)}`);
}
process.exit(fails ? 1 : 0);
