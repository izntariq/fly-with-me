// Grid-fit check: runs tracks.js applyAnalysis (the beat grid, steady flag and planned exit the app derives from an
// All-In-One analysis) over every analysis in data/realtracks/allin1, for one or more versions of tracks.js, and
// reports how well each fits the song where it matters to a DJ: at the planned exit.
//
//   node tools/gridcheck.mjs                    the working copy
//   node tools/gridcheck.mjs 1167539 HEAD       those git revisions (and the working copy as "now")
//   node tools/gridcheck.mjs --changed 1167539  also list every track whose steady flag or exit alignment changed
//
// Per version: analyses applied (the rest keep the in-browser grid), steady (fit for beat-matched blends), the share of
// All-In-One downbeats from mixBar on that sit on the app's bar lines (±70 ms; 4/4 tracks), the same for steady tracks
// only, and steady tracks with under half their exit downbeats on the bar lines (a blend there lands off the bar).
// Track lengths: data/realtracks/durations.json (measured from the audio files); else the analysis's last segment.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname, R = root + 'data/realtracks/';
const args = process.argv.slice(2), changed = args.includes('--changed'), revs = args.filter((a) => a !== '--changed');

// barGrid + applyAnalysis from a tracks.js source (analyzeEnergy needs real audio: stubbed)
function loadFit(src) {
  const a = src.indexOf('const linfit'), b = src.indexOf('export const safeName');
  if (a < 0 || b < 0) throw new Error('tracks.js layout not recognised (linfit … safeName)');
  const body = src.slice(a, b).replace('export function applyAnalysis', 'function applyAnalysis');
  const pre = "const SECTION_OF = { start: 'intro', intro: 'intro', verse: 'verse', chorus: 'chorus', inst: 'chorus', solo: 'chorus', bridge: 'break', break: 'break', outro: 'outro', end: 'outro' };\n" +
    'const analyzeEnergy = () => ({ energy: null });\n';
  return new Function(pre + body + '; return { applyAnalysis };')();
}
const versions = Object.fromEntries([
  ...revs.map((r) => [r, loadFit(execFileSync('git', ['-C', root, 'show', `${r}:web/js/tracks.js`], { encoding: 'utf8' }))]),
  ['now', loadFit(fs.readFileSync(root + 'web/js/tracks.js', 'utf8'))],
]);

const durs = fs.existsSync(R + 'durations.json') ? JSON.parse(fs.readFileSync(R + 'durations.json', 'utf8')) : {};
const on = (xs, L, p0) => xs.filter((y) => { const u = (y - p0) / L; return Math.abs(u - Math.round(u)) * L <= 0.07; }).length / Math.max(1, xs.length);
const stats = {}, per = {};
let n = 0;
for (const f of fs.readdirSync(R + 'allin1').sort()) {
  if (!f.endsWith('.json')) continue;
  n++;
  const slug = f.slice(0, -5), a = JSON.parse(fs.readFileSync(R + 'allin1/' + f, 'utf8'));
  const dur = durs[slug] ?? (a.segments?.length ? a.segments.at(-1).end : (a.downbeats || []).at(-1) || 0);
  for (const [k, F] of Object.entries(versions)) {
    const t = { name: slug, buffer: { duration: dur }, bpm: 120, firstBeat: 0 };
    let ok = false; try { ok = F.applyAnalysis(t, a); } catch (e) { t.analysisRejected = 'threw: ' + e.message; }
    const s = (stats[k] ||= { applied: 0, steady: 0, exit: [], exitSteady: [] });
    if (!ok) { (per[slug] ||= {})[k] = 'rejected'; continue; }
    s.applied++; if (t.steady) s.steady++;
    const bar = 240 / t.bpm, db = (a.downbeats || []).filter((x) => x >= t.firstBeat + t.mixBar * bar - 1);
    const e = (t.meter || 4) === 4 && db.length >= 4 ? on(db, bar, t.firstBeat) : null;
    if (e != null) { s.exit.push(e); if (t.steady) s.exitSteady.push(e); }
    (per[slug] ||= {})[k] = `${t.steady ? 'steady' : 'unsteady'}${e != null ? ` exit ${e.toFixed(2)}` : ''}`;
  }
}
const mean = (x) => (x.length ? (x.reduce((p, q) => p + q, 0) / x.length).toFixed(3) : '–');
console.log(`${n} All-In-One analyses\n`);
console.log('version'.padEnd(10), 'applied', 'steady', 'exit on bar lines: all', '/ steady', '  steady, exit mostly off');
for (const [k, s] of Object.entries(stats))
  console.log(k.padEnd(10), String(s.applied).padStart(7), String(s.steady).padStart(6), mean(s.exit).padStart(22), mean(s.exitSteady).padStart(9), String(s.exitSteady.filter((x) => x < 0.5).length).padStart(26));
if (changed && revs.length) {
  const base = revs[0], diff = Object.entries(per).filter(([, p]) => p[base] !== p.now);
  console.log(`\n${diff.length} tracks differ between ${base} and now:`);
  for (const [s, p] of diff) console.log(' ', s.padEnd(50), (p[base] || '').padEnd(24), '→', p.now);
}
