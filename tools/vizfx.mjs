// Visualiser test: the DJ app (no drawing) + viz.html in one headless browser (real GPU via ANGLE Metal). Fires moves from
// the app's pads, screenshots each effect, then hovers a DJ-fly neuron (tooltip) and clicks it (poke).
//   PORT=8766 OUT=/tmp/flyviz node tools/vizfx.mjs          (screenshots go to OUT; check the server log for "poke:")
import { launchChrome } from './chrome.mjs';
import { mkdirSync } from 'node:fs';
const SP = process.env.OUT || '/tmp/flyviz', port = process.env.PORT || 8766;
mkdirSync(SP, { recursive: true });
const browser = await launchChrome({ headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
const app = await ctx.newPage();
await app.addInitScript(() => { window.requestAnimationFrame = () => 0; });
const errs = [];
app.on('pageerror', (e) => errs.push('APP ' + e.message));
await app.goto(`http://localhost:${port}/`);
console.log('app button:', await app.locator('#btn-viz').count(), '| main.js versioned:', await app.evaluate(() => document.querySelector('script[type=module]').src));
await app.waitForFunction(() => document.querySelector('#splash-msg').textContent.startsWith('connected'));
await app.click('#btn-start');
await app.waitForSelector('#splash.gone', { state: 'attached', timeout: 90000 });
const viz = await ctx.newPage();
viz.on('pageerror', (e) => errs.push('VIZ ' + e.message));
viz.on('console', (m) => { if (m.type() === 'error') errs.push('VIZ console ' + m.text()); });
await viz.goto(`http://localhost:${port}/viz.html`);
// the photosensitivity warning holds the first frame; this tool records the full effects (SAFE=1: safe mode)
await viz.click(process.env.SAFE === '1' ? '#warn-safe' : '#warn-flash');
await viz.waitForTimeout(22000);
const shots = [['fx:echo', 900], ['scratch:chirp', 700], ['brake', 900], ['sample:co2', 500], ['sample:laser', 500], ['chop', 1500], ['acid', 2200], ['build:4', 5200], ['build:4', 3300]];
let i = 0;
for (const [act, wait] of shots) {
  if (!(act === 'build:4' && i === 8)) await app.evaluate((a) => document.querySelector(`[data-act="${a}"]`)?.click(), act);
  await viz.waitForTimeout(wait);
  const fx = await viz.evaluate(() => flyViz.fx.map((e) => e.kind).join(','));
  await viz.screenshot({ path: `${SP}/fx${i}_${act.replace(':', '-')}.png` });
  console.log(i, act, '→ live effects:', fx);
  i++;
  await viz.waitForTimeout(1500);
}
// hover + click a DJ-fly descending neuron (find one on screen)
const target = await viz.evaluate(() => { const V = flyViz, h = V.hello; const slot = h.outputs.findIndex((o) => o.type === 'DNp01'); const i = h.out_idx[slot];
  const R = V.rot, L = V.L[2], H = innerHeight, p = [V.pos[4 * i], V.pos[4 * i + 1], V.pos[4 * i + 2]]; const q = R.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]); const s = 1 / (1 + q[2] * 0.3);
  return [L.x + q[0] * L.s * s * H / 2, L.y - q[1] * L.s * s * H / 2]; });
await viz.mouse.move(target[0], target[1]); await viz.waitForTimeout(300);
console.log('tooltip:', await viz.evaluate(() => document.querySelector('#tip').innerText.replace(/\n/g, ' | ')));
await viz.mouse.click(target[0], target[1]); await viz.waitForTimeout(600);
await viz.screenshot({ path: `${SP}/fx_poke.png` });
await viz.waitForTimeout(3000);
console.log('moves:', JSON.stringify(await viz.evaluate(() => flyViz.moves.map((m) => m.name + ' ← ' + (m.label || m.by)))));
console.log('ERRORS: ' + errs.join(' | '));
await browser.close();
