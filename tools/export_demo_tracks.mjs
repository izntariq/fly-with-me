// Render the 8 synthesized demo tracks (and optional variations) in headless Chrome and save them as WAV + section
// labels for training.
//   cd tools && npm i && node export_demo_tracks.mjs [variations per track]   (needs Google Chrome; serves ../web)
// Variations re-roll the arrangement's random choices (seed), shift the tempo (±6 BPM) and the key (−3..+3).
// Output: data/tracks/<slug>.wav (stereo 16-bit 44.1 kHz) and data/tracks/<slug>.json (bpm, firstBeat, sections)

import { launchChrome } from './chrome.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'tracks');
fs.mkdirSync(OUT, { recursive: true });

// tiny static server for web/
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, 'web', decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(0);
const port = server.address().port;

const browser = await launchChrome({ headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${port}/`);

const n = await page.evaluate(async () => {
  const { demoCount } = await import('/js/tracks.js');
  const { desiCount } = await import('/js/desi.js');
  return demoCount + desiCount;
});
const VARIANTS = +(process.argv[2] || 0);
const jobs = [];
for (let i = 0; i < n; i++) for (let v = 0; v <= VARIANTS; v++) jobs.push([i, v]);
for (const [i, v] of jobs) {
  const t = await page.evaluate(async ([i, v]) => {
    const { renderDemo, demoCount } = await import('/js/tracks.js');
    const { renderDesi } = await import('/js/desi.js');
    let over = {};
    if (v) {
      // deterministic per (track, variation)
      let s = (i + 1) * 7919 + v * 104729; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      over = { seed: 1000 + i * 10 + v, bpmShift: Math.round((r() * 12 - 6)), rootShift: Math.floor(r() * 7) - 3, v };
    }
    let tr;
    if (!v) tr = i < demoCount ? await renderDemo(i) : await renderDesi(i - demoCount);
    else {
      // render once with the new seed to read the base tempo and key, then again with them shifted
      const probe = i < demoCount ? await renderDemo(i, { seed: over.seed }) : await renderDesi(i - demoCount, { seed: over.seed });
      const o = { seed: over.seed, bpm: probe.bpm + over.bpmShift, root: probe.root + over.rootShift, name: `${probe.name} v${v}` };
      tr = i < demoCount ? await renderDemo(i, o) : await renderDesi(i - demoCount, o);
    }
    // 16-bit interleaved PCM, base64 (keeps the page→node hop small)
    const L = tr.buffer.getChannelData(0), R = tr.buffer.getChannelData(1), pcm = new Int16Array(L.length * 2);
    for (let k = 0; k < L.length; k++) { pcm[2 * k] = Math.max(-1, Math.min(1, L[k])) * 32767; pcm[2 * k + 1] = Math.max(-1, Math.min(1, R[k])) * 32767; }
    const bytes = new Uint8Array(pcm.buffer); let bin = '';
    for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    return { name: tr.name, bpm: tr.bpm, firstBeat: tr.firstBeat, style: tr.style, sr: tr.buffer.sampleRate, b64: btoa(bin) };
  }, [i, v]);
  const pcm = Buffer.from(t.b64, 'base64');
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(t.sr, 24);
  hdr.writeUInt32LE(t.sr * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (fs.existsSync(path.join(OUT, slug + '.wav'))) { console.log(`${slug}: exists, skipped`); continue; }
  fs.writeFileSync(path.join(OUT, slug + '.wav'), Buffer.concat([hdr, pcm]));
  // every demo uses the same arrangement (bars): intro 8 | build 8 | main 16 | break 4 | main 8 | outro 4
  const sections = [['intro', 0, 8], ['build', 8, 16], ['main', 16, 32], ['break', 32, 36], ['main', 36, 44], ['outro', 44, 48]];
  fs.writeFileSync(path.join(OUT, slug + '.json'), JSON.stringify({ name: t.name, bpm: t.bpm, firstBeat: t.firstBeat, style: t.style, sr: t.sr, sections }, null, 1));
  console.log(`${slug}: ${(pcm.length / 4 / t.sr).toFixed(1)} s, ${t.bpm} bpm, ${t.style}`);
}
await browser.close();
server.close();
