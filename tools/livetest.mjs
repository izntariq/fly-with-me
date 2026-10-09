// Live test: run the DJ app headless for N seconds and record where (which section of the on-air track) the fly acts,
// how often each listener-fly sense (MIX / SPACE / PEAK) is on in the section it should flag, vs chance, and the load.
//   PORT=8766 node tools/livetest.mjs 150
// Use a spare port (a second server: .venv/bin/python -m flybrain.server --port 8766) so a browser you are using on
// 8765 isn't disturbed. Drawing is off (headless Chrome's software canvas would starve the brain); set DRAW=1 to keep it.
import { launchChrome } from './chrome.mjs';
const secs = +(process.argv[2] || 240), port = process.env.PORT || 8766;
const browser = await launchChrome({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
// headless Chrome has no GPU: skip drawing (software canvas rendering would starve the brain simulation).
// Audio, the brain and all DJ logic still run; only the visuals are off.
if (!process.env.DRAW) await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => document.querySelector('#splash-msg').textContent.startsWith('connected'));
await page.click('#btn-start');
await page.waitForSelector('#splash.gone', { state: 'attached', timeout: 90000 });
await page.evaluate(() => {
  const S = window.flyDJ, sec = (bar) => bar < 8 ? 'intro' : bar < 16 ? 'build' : bar < 32 ? 'main' : bar < 36 ? 'break' : bar < 44 ? 'main' : 'outro';
  const where = () => { const d = S.mixer.onAir(); return d.track ? sec(Math.floor(d.beatAt() / 4)) : '?'; };
  window._ev = [];
  const f = S.dj.fire.bind(S.dj); S.dj.fire = (key, label, i, c) => { window._ev.push({ kind: 'move', key, at: where() }); return f(key, label, i, c); };
  const cs = S.dj.chooseStyle.bind(S.dj); S.dj.chooseStyle = () => { const st = cs(); window._ev.push({ kind: 'transition', key: st, at: where(), mix: S.ctx.currentTime < S.dj.mixWindow }); return st; };
  window._trained = S.dj.trained;
  const us = S.dj.updateSense.bind(S.dj); let was = false, wasP = false;
  S.dj.updateSense = (dt) => { us(dt); const on = S.dj.sense.space.on, p = S.dj.sense.peak.on;
    if (on && !was) window._ev.push({ kind: 'sense', key: 'space-onset', at: where() });
    if (p && !wasP) window._ev.push({ kind: 'sense', key: 'peak-onset', at: where() });
    if (Math.random() < 0.02) window._ev.push({ kind: 'sample', key: p ? 'peak-on' : 'peak-off', at: where() });
    const Lz = S.dj.listeners; if (Lz && Math.random() < 0.05) { const k = S.mixer.onAir() === S.mixer.decks[0] ? 0 : 1; const r = Lz[k].r;
      (window._z ||= []).push({ at: where(), SPACE: r.SPACE?.z, MIX: r.MIX?.z, PEAK: r.PEAK?.z,
        on: { SPACE: !!r.SPACE?.active, MIX: !!r.MIX?.active, PEAK: !!r.PEAK?.active } }); }
    was = on; wasP = p; };
});
await page.waitForTimeout(secs * 1000);
const ev = await page.evaluate(() => ({ ev: window._ev, trained: window._trained, brain: document.querySelector('#st-brain').textContent, z: window._z || [], load: window.flyDJ.stats.load.toFixed(2) }));
const zs = {};
for (const x of ev.z) for (const k of ['SPACE', 'MIX', 'PEAK']) { if (x[k] == null) continue; ((zs[k] ||= {})[x.at] ||= []).push(x[k]); }
const onby = {}, tot = {};
for (const x of ev.z) { tot[x.at] = (tot[x.at] || 0) + 1; for (const k of ['SPACE', 'MIX', 'PEAK']) if (x.on?.[k]) ((onby[k] ||= {})[x.at] = (onby[k][x.at] || 0) + 1); }
const nAll = ev.z.length;
for (const [k, want] of [['SPACE', 'break'], ['MIX', 'intro'], ['PEAK', 'main']]) {
  const on = Object.values(onby[k] || {}).reduce((a, b) => a + b, 0);
  console.log(k + ': ' + (100 * (onby[k]?.[want] || 0) / Math.max(1, on)).toFixed(0) + '% of ON time in ' + want + ' (chance ' + (100 * (tot[want] || 0) / Math.max(1, nAll)).toFixed(0) + '%), on ' + (100 * on / Math.max(1, nAll)).toFixed(0) + '% of the time');
}
console.log('mean listener z by on-air section:', JSON.stringify(Object.fromEntries(Object.entries(zs).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([s, a]) => [s, +(a.reduce((p, q) => p + q, 0) / a.length).toFixed(2)]))]))), '| load', ev.load);
const tally = {};
for (const e of ev.ev) { const k = `${e.kind}:${e.key}`; (tally[k] ||= {}); tally[k][e.at] = (tally[k][e.at] || 0) + 1; }
console.log(JSON.stringify({ brain: ev.brain, trained: ev.trained, tally }, null, 0));
console.log('ERRORS: ' + errs.join(' | '));
await browser.close();
