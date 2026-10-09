// How long does the fly keep each track on air? Runs the app headless and logs every stretch a deck is fully on air.
//   PORT=8766 node tools/onairtest.mjs 240
import { launchChrome } from './chrome.mjs';
const secs = +(process.argv[2] || 240), port = process.env.PORT || 8766;
const browser = await launchChrome({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => document.querySelector('#splash-msg').textContent.startsWith('connected'));
await page.click('#btn-start');
await page.waitForSelector('#splash.gone', { state: 'attached', timeout: 90000 });
await page.evaluate(() => {
  const S = window.flyDJ; window._seg = []; let cur = null;
  setInterval(() => {
    const d = S.mixer.onAir(), full = S.mixer.airness(d) > 0.99, t = S.ctx.currentTime;
    if (full && !cur) cur = { deck: d.name, track: d.track?.name, t0: t };
    if (!full && cur) { window._seg.push({ ...cur, len: +(t - cur.t0).toFixed(1) }); cur = null; }
    window._cur = cur && { ...cur, len: +(t - cur.t0).toFixed(1) };
  }, 100);
});
await page.waitForTimeout(secs * 1000);
const r = await page.evaluate(() => ({ seg: window._seg, cur: window._cur,
  log: (window.flyDJ.history || []).filter((h) => /will|cues deck|aversion|blend into|ended/.test(h.text)).map((h) => `${h.t.toFixed(0)}s ${h.text}`) }));
for (const s of r.seg) console.log(`on air ${s.len}s  deck ${s.deck}  "${s.track}"`);
if (r.cur) console.log(`still on air ${r.cur.len}s  deck ${r.cur.deck}  "${r.cur.track}"`);
console.log(r.log.join('\n'));
console.log('ERRORS: ' + errs.join(' | '));
await browser.close();
