// Section-sense parity in plain Node: the browser's SectionSense (web/js/sections.js) against the training-side
// Python (flybrain/sections.py) on the golden fixture tests/fixtures/sections_golden.json (synthetic spike counts,
// two model specs, the Python posteriors; tests/fixtures/make_sections_golden.py writes it).
//
// A fake deck plays the fixture's track bar by bar: each bar's spikes arrive in one update() and the next bar's first
// update closes it. The track's bars fill it from beat 0, so the app's position prior (the closing bar's midpoint over
// the bars from the first beat, as training measures it) sees (bar + 0.5) / bars. Before 9 October the app used the
// playhead over the file instead, half a bar late plus the lead-in; this test fails on that code.
//
//   node tools/test_sections_parity.mjs
import { readFileSync } from 'node:fs';
import { SectionSense } from '../web/js/sections.js';

const G = JSON.parse(readFileSync(new URL('../tests/fixtures/sections_golden.json', import.meta.url), 'utf8'));
const TOL = 1e-4;
let fails = 0;

function run(spec) {
  const nb = G.counts.length, duration = nb * 240 / G.bpm;           // the bars fill the track from beat 0
  const deck = { track: { energy: G.energy, firstBeat: 0, bpm: G.bpm }, playing: true, bpm: G.bpm, duration, beat: 0, pos: 0,
                 beatAt() { return this.beat; }, position() { return this.pos; } };
  const sense = new SectionSense(spec, G.outputs, deck);
  const P = [], A = [];
  for (let b = 0; b <= nb; b++) {
    deck.beat = b * 4 + 0.01;
    if (b > 0) deck.pos = (b + 0.01 / 4) / nb * duration;          // the playhead when bar b-1 closes (not used for the prior)
    const spikes = [];
    if (b < nb) G.counts[b].forEach((c, slot) => { for (let i = 0; i < c; i++) spikes.push([slot, 0]); });
    const before = sense.k;
    sense.update(spikes, G.bar_s * 1000);
    if (sense.k !== before) { P.push(sense.p.slice()); A.push(sense.a.slice()); }
  }
  return { P, A };
}

function compare(name, got, want) {
  if (got.length !== want.length) { fails++; console.log(`FAIL  ${name}  ${got.length} bars closed, want ${want.length}`); return; }
  let worst = 0, at = null;
  got.forEach((row, b) => row.forEach((v, c) => { const d = Math.abs(v - want[b][c]); if (!(d <= worst)) { worst = d; at = [b, c]; } }));
  const ok = worst <= TOL;
  if (!ok) fails++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}  max |js - py| = ${worst.toExponential(2)} over ${got.length} bars${ok ? '' : ` (bar ${at[0]}, class ${at[1]})`}`);
}

for (const [name, c] of Object.entries(G.cases)) {
  const { P, A } = run(c.spec);
  compare(`${name}_classifier`, P, c.P);
  compare(`${name}_posterior`, A, c.posterior);
}
// the shipped spec loads, and its shapes are what SectionSense indexes
for (const f of ['sections_trained.json', 'sections_naive.json']) {
  let spec;
  try { spec = JSON.parse(readFileSync(new URL(`../brains/${f}`, import.meta.url), 'utf8')); } catch { continue; }
  const K = spec.classes.length, rows = 2 * spec.groups.length + (spec.energy ? 2 : 0);
  const ok = spec.W.length === rows && spec.W.every((r) => r.length === K) && spec.b.length === K &&
    (!spec.T || (spec.T.length === K && spec.start.length === K && spec.pos.every((r) => r.length === K)));
  if (!ok) fails++;
  console.log(`${ok ? 'pass' : 'FAIL'}  brains/${f}_shapes  K=${K} groups=${spec.groups.length} W=${spec.W.length}x${spec.W[0]?.length}`);
}
process.exit(fails ? 1 : 0);
