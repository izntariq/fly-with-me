// Run the app's own track analysis (beat grid, per-bar energy, hot cues, style) on every track in
// data/realtracks/tracks.json, headless, so offline training uses exactly the bars the live app will use.
//   PORT=8766 node tools/analyze_tracks.mjs        -> data/realtracks/analysis.json
import { launchChrome } from './chrome.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const port = process.env.PORT || 8766, root = new URL('..', import.meta.url).pathname;
const tracks = JSON.parse(readFileSync(root + 'data/realtracks/tracks.json'));
const browser = await launchChrome({ headless: true });
const page = await browser.newPage();
await page.route('**/__track/*', (route) => {
  const t = tracks[+route.request().url().split('/').pop()];
  route.fulfill({ body: readFileSync(t.file), contentType: 'audio/mpeg' });
});
await page.goto(`http://127.0.0.1:${port}/viz.html`);
const out = {};
for (let i = 0; i < tracks.length; i++) {
  const t = tracks[i];
  out[t.slug] = await page.evaluate(async ([i, name]) => {
    const { trackFromFile } = await import('/js/tracks.js');
    const ctx = window._ctx ||= new AudioContext();
    const blob = await (await fetch(`/__track/${i}`)).blob();
    const tr = await trackFromFile(ctx, new File([blob], name + '.mp3'));
    return { name: tr.name, bpm: tr.bpm, firstBeat: tr.firstBeat, duration: tr.buffer.duration, energy: Array.from(tr.energy),
             cues: tr.cues, style: tr.style, key: tr.key };
  }, [i, t.name]);
  process.stdout.write(`${i + 1}/${tracks.length} ${t.slug} ${out[t.slug].bpm} bpm ${out[t.slug].energy.length} bars\n`);
}
writeFileSync(root + 'data/realtracks/analysis.json', JSON.stringify(out));
await browser.close();
