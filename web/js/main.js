import { Mixer } from './decks.js';
import { Ears } from './ears.js';
import { FlySynth } from './synth.js';
import { FlyDJ, MOVES } from './flydj.js';
import { Performer } from './perform.js';
import { STYLES } from './djstyles.js';
import { ARCS, energyAt } from './setplan.js';
import { MC } from './mc.js';
import { BrainView, Raster, drawEar, drawWave } from './viz.js';
import { trackFromFile, renderDemo, demoCount, describeDemo, safeName, sha1, applyAnalysis } from './tracks.js';
import { analyzeEnergy } from './analysis.js';
import { renderDesi, desiCount } from './desi.js';

const $ = (s, el = document) => el.querySelector(s);
const S = {
  ws: null, hello: null, ctx: null, mixer: null, ears: null, synth: null, dj: null,
  brainView: null, raster: null, xy: null,
  crate: [], crateNext: 0, want: [null, null], style: 'desi', feed: { sugar: 0, bitter: 0 }, wind: 0,
  stats: { spikes: 0, frames: 0, load: 0, t: 0 }, nextGrid: 0, started: false, lastDrive: 0,
};

// the visualiser (viz.html, its own window) hears the moves, decks and beat on this channel
const bus = 'BroadcastChannel' in window ? new BroadcastChannel('flybrain-dj') : null;
const absNow = () => performance.timeOrigin + performance.now();          // ms, the same clock in every window
// settings kept between visits (volume, keyboard shortcuts); storage can throw (private windows, blocked site data)
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* not kept */ } },
};

// ---------------- log ----------------
function log(html) {
  S.logN = (S.logN || 0) + 1; S.lastLog = html;
  bus?.postMessage({ type: 'log', html, t: absNow() });
  const li = document.createElement('li');
  const t = S.ctx ? S.ctx.currentTime : 0;
  (S.history ||= []).push({ t, text: html.replace(/<[^>]+>/g, '') });
  li.innerHTML = `<span class="t">${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}</span>${html}`;
  const ul = $('#log'); ul.prepend(li);
  while (ul.children.length > 80) ul.lastChild.remove();
}

// ---------------- brain connection ----------------
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws${location.search}`);
  S.ws = ws;
  ws.onopen = () => { $('#st-conn').textContent = 'brain online'; $('#st-conn').className = 'pill on'; };
  ws.onclose = () => {
    $('#st-conn').textContent = 'offline'; $('#st-conn').className = 'pill off';
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'hello') onHello(d);
    else if (d.type === 'frame') onFrame(d);
    else if (d.type === 'error') log(d.message ? `brain server: ${String(d.message).replace(/</g, '&lt;')}` : 'brain server: running again');
  };
}

// what the app was built around: the server sends a hello on every connection, and a restart can bring another brain
// (--flies, --connectome, a retrained brain); then every index the app holds (inputs, outputs, flies) is wrong
const helloKey = (h) => JSON.stringify([h.flies || 1, h.connectome || 'flywire', h.n_neurons, h.n_connections,
  h.inputs?.length, h.outputs?.length, h.trained?.synapses ?? 0]);

async function onHello(h) {
  if (S.hello) { if (helloKey(h) !== helloKey(S.hello)) brainChanged(); return; }    // same brain: a reconnect, carry on
  S.hello = h;
  const tb = h.trained;
  const nf = h.flies || 1;
  $('#st-brain').textContent = (nf > 1 ? `${nf} flies · ` : '') + (tb ? `trained brain · ${tb.synapses.toLocaleString()} learned synapses` : 'naive brain');
  $('#st-brain').className = 'pill ' + (tb ? 'trained' : 'naive');
  $('#splash-msg').textContent = `connected: ${h.n_neurons.toLocaleString()} neurons, ${h.inputs.length} sensory channels, ${h.outputs.length} output neurons`;
  const buf = await (await fetch('brain_xy.bin')).arrayBuffer();
  S.xy = new Uint16Array(buf);
  S.brainView = new BrainView($('#brain'), S.xy, h.in_idx, h.out_idx);
  (function idle() { if (!S.started) { S.brainView.draw(); setTimeout(idle, 50); } })();
  S.raster = new Raster($('#raster'), h.outputs);
}

function onFrame(f) {
  S.stats.spikes += f.n; S.stats.frames++; S.stats.load = S.stats.load * 0.9 + f.load * 0.1; S.stats.t = f.t;
  if (f.reset) log('<b>runaway activity</b> (seizure-like) detected → brain reset');
  // which fly performs: the DJ fly when chained (3), the on-air deck's fly with 2, the only fly with 1
  const flies = S.hello.flies || 1;
  const onIdx = S.mixer ? (S.mixer.onAir() === S.mixer.decks[0] ? 0 : 1) : 0;
  const k = flies === 3 ? 2 : flies === 2 ? onIdx : 0;
  const out = f.outs ? f.outs[k] : f.out, viz = f.vizs ? f.vizs[k] : f.viz;
  S.brainView?.addSpikes(viz);
  if (!S.started) return;
  S.raster.add(out);
  if (flies >= 2) S.dj.onListeners(f.outs[0], f.outs[1], S.hello.frame_ms);
  S.dj.onFrame(out, S.hello.frame_ms);
  S.synth.addSpikes(out, S.ctx.currentTime);
}

// A different brain answered: stop driving it (and reading it) with this page's channel and neuron indices. Before the
// start there's nothing to lose, so the page just reloads; mid-set the music plays on until you reload.
function brainChanged() {
  if (S.stale) return;
  S.stale = true;
  const ws = S.ws; ws.onclose = ws.onmessage = null; ws.close();
  $('#st-conn').textContent = 'brain changed'; $('#st-conn').className = 'pill off';
  if (!S.ctx) { location.reload(); return; }
  const b = document.createElement('div'); b.id = 'stale';
  b.innerHTML = '<span>The brain server changed (another brain, or another number of flies) — reload to play with it.</span>';
  const go = document.createElement('button'); go.textContent = 'Reload'; go.onclick = () => location.reload();
  b.append(go); document.body.append(b);
  log('<b>the brain server changed</b>: the fly is no longer driven — reload the page');
}

function send(obj) { if (!S.stale && S.ws?.readyState === 1) S.ws.send(JSON.stringify(obj)); }

// ---------------- crate & decks ----------------
function renderCrate() {
  const ol = $('#crate'); ol.innerHTML = '';
  const [A, B] = S.mixer?.decks || [];
  let nextIdx = -1;
  for (let k = 0; k < S.crate.length && nextIdx < 0; k++) {
    const i = (S.crateNext + k) % S.crate.length, t = S.crate[i];
    if (inStyle(t) && t !== A?.track && t !== B?.track) nextIdx = i;
  }
  S.crate.forEach((t, i) => {
    const li = document.createElement('li');
    if (!inStyle(t)) li.style.opacity = 0.35;
    if (A?.track === t) li.className = 'a'; else if (B?.track === t) li.className = 'b';
    const score = (t.score != null ? ` · 🎧 ${t.score.toFixed(0)}` : '') + (t.stemProgress != null ? ` · stems ${Math.round(t.stemProgress * 100)}%` : '');
    li.innerHTML = `${t.name} <span class="meta">${t.bpm.toFixed(1)} bpm${t.key ? ' · ' + t.key : ''}${score}${t.plays ? ` · played ${t.plays}×` : ''}${i === nextIdx && !S.dj?.auto ? ' · next' : ''}</span>`;
    ol.append(li);
  });
}

const inStyle = (t) => t.source === 'file' || S.style === 'all' || t.style === S.style;
// (a released track that failed to decode again just now sits out for a minute: memory pressure passes)
const usable = (t) => inStyle(t) && !(t.badUntil > performance.now());

function pickNext(exclude) {
  for (let k = 0; k < S.crate.length; k++) {
    const t = S.crate[(S.crateNext + k) % S.crate.length];
    // kept within the crate, so a track added at crateNext is the next one up even after the crate grows
    if (!exclude.includes(t) && usable(t)) { S.crateNext = (S.crateNext + k + 1) % S.crate.length; return t; }
  }
  return null;
}

function loadNext(i) {
  const deck = S.mixer.decks[i], other = S.mixer.decks[1 - i];
  const t = pickNext([deck.track, other.track]) || (deck.track ? null : S.crate[0]);
  if (!t) { if (deck.track && !deck.playing) startSynced(deck, other); return; }
  loadTrack(i, t);
}

function loadTrack(i, t, why = '') {
  // a track whose audio was released (trimCrate) is decoded again first; a later load or preview of this deck wins
  S.want[i] = t;
  if (!t.buffer) {
    // by the time it's decoded the deck may be on air, or lined up as the next transition's incoming: then leave it
    revive(t).then((ok) => {
      if (S.want[i] !== t) return;
      if (S.mixer.airness(S.mixer.decks[i]) > 0.01 || S.dj?.pending) { S.want[i] = null; return; }
      if (ok) loadTrack(i, t, why); else loadNext(i);
    });
    return;
  }
  const deck = S.mixer.decks[i], other = S.mixer.decks[1 - i];
  if (t.pendingAnalysis && other.track !== t) { applyAnalysis(t, t.pendingAnalysis); t.pendingAnalysis = null; }
  deck.load(t);
  startSynced(deck, other);
  S.ears.resetHabit(i);
  t.plays = (t.plays || 0) + 1;
  deck._manualEQ = false; deck.setEQ('low', 0); deck.setEQ('mid', 0); deck.setEQ('high', 0);
  log(`deck ${deck.name} ← "${t.name}" (${t.bpm.toFixed(1)} bpm${other.playing ? ', beat-matched to deck ' + other.name : ''})${why}`);
  if (t.source === 'file') separate(t);
  renderCrate();
  scheduleTrim();
}

// the fly's headphone preview: play a candidate from its drop in the off-air deck (heard only in the cue ear)
function previewTrack(i, t) {
  S.want[i] = t;
  // (decoded again first if need be; by then the deck may have come on air, and a preview must never be heard)
  if (!t.buffer) {
    const a = S.dj?.aud, mine = () => a && S.dj.aud === a && a.cands[a.k] === t;
    if (mine()) a.t0 = Infinity;                    // the fly's 5 s of listening start when it actually plays
    revive(t).then((ok) => {
      if (S.want[i] !== t || S.mixer.airness(S.mixer.decks[i]) >= 0.01) return;
      if (ok) { previewTrack(i, t); if (mine()) { a.t0 = S.ctx.currentTime; a.acc = 0; a.n = 0; } }
      else if (mine()) { a.cands.splice(a.k--, 1); S.dj.nextCandidate(); }   // unreadable: the next candidate
    });
    return;
  }
  const deck = S.mixer.decks[i], other = S.mixer.decks[1 - i];
  deck.load(t);
  const drop = t.cues?.find((c) => c.name === 'drop');
  startSynced(deck, other, drop ? t.firstBeat + drop.beat * 60 / t.bpm : t.firstBeat);
  S.ears.resetHabit(i);
  renderCrate();
  scheduleTrim();
}

// tracks the fly could play next on deck i: in style, not on a deck, least-played first (crate order breaks ties)
function candidates(i, n) {
  const onDecks = S.mixer.decks.map((d) => d.track);
  const pool = [];
  for (let k = 0; k < S.crate.length; k++) {
    const t = S.crate[(S.crateNext + k) % S.crate.length];
    if (usable(t) && !onDecks.includes(t)) pool.push(t);
  }
  pool.sort((a, b) => (a.plays || 0) - (b.plays || 0));
  return pool.slice(0, n);
}

function startSynced(deck, other, startPos = null) {
  const t = deck.track;
  if (other.playing && other.track) {
    deck.rate = S.mixer.rateFor(t, S.mixer.masterBpm || other.bpm);
    const b = other.beatAt(S.ctx.currentTime + 0.15);
    const bar = Math.ceil(b / 4) * 4;
    deck.play(other.timeOfBeat(bar), startPos ?? t.firstBeat);
  } else {
    deck.rate = S.mixer.masterBpm ? S.mixer.rateFor(t, S.mixer.masterBpm) : 1;
    deck.play(S.ctx.currentTime + 0.05, deck.anchorPos || t.firstBeat);
  }
  if (!S.tempo) { S.tempo = { base: t.bpm, cur: t.bpm, applied: t.bpm, taps: [] }; S.mixer.setTempo(t.bpm); }
  S.mixer.masterBpm ||= t.bpm;
}

// ---------------- stem separation for dropped tracks (web worker) ----------------
// Only deck tracks keep stems (trimCrate), so a dropped track is split when it's loaded on a deck: the deck plays the
// full mix until they're ready, then switches on a bar line. The worker holds the whole spectrogram (about 0.5 GB for
// 4 minutes), so long mixes go without.
const STEM_MAX_S = 12 * 60;
let stemWorker = null, stemJobs = new Map(), stemId = 0;
function separate(t) {
  if (window.flyNoStems || t.stems || t.stemProgress != null || t.noStems || !t.buffer) return;   // tests skip it (CPU heavy)
  const b = t.buffer;
  if (b.duration > STEM_MAX_S) {
    t.noStems = true;
    log(`"${t.name}" runs ${fmt(b.duration)}: no stem separation over ${STEM_MAX_S / 60} minutes (it would need gigabytes)`);
    return;
  }
  if (!stemWorker) {
    const w = stemWorker = new Worker('js/stems-worker.js');
    w.onmessage = (e) => { w.started = true; onStems(e); };
    // the worker itself broke (it reports a failed job as a message): drop it with the job it was on (the oldest) and
    // queue the rest on a fresh one, so no deck waits on "separating stems" forever. A worker that never got going
    // (its script didn't load: the server was restarting) isn't the track's fault: all its jobs are queued again
    w.onerror = (e) => {
      if (stemWorker !== w) return;                 // a late error from a worker already replaced
      w.terminate(); stemWorker = null;
      const jobs = [...stemJobs.values()].map((j) => j.t), lost = w.started ? jobs.shift() : null;
      stemJobs.clear();
      for (const x of [lost, ...jobs]) if (x) x.stemProgress = null;
      if (lost) { lost.noStems = true; log(`no stems for "${lost.name}": the separation failed (${safeName(e.message || 'worker error')})`); }
      if (w.started) for (const x of jobs) if (S.mixer.decks.some((d) => d.track === x)) separate(x);
      renderCrate();
    };
  }
  const id = ++stemId;
  stemJobs.set(id, { t, sr: b.sampleRate }); t.stemProgress = 0;
  const L = b.getChannelData(0).slice(), R = (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice();
  stemWorker.postMessage({ id, L, R, sr: b.sampleRate }, [L.buffer, R.buffer]);
}
function onStems(e) {
  const { id, progress, drums, music, error } = e.data, job = stemJobs.get(id);
  if (!job) return;
  const tr = job.t;
  if (progress != null) { tr.stemProgress = progress; return; }
  stemJobs.delete(id); tr.stemProgress = null;
  if (error) { tr.noStems = true; log(`no stems for "${tr.name}": the separation failed (${safeName(error)})`); renderCrate(); return; }
  const decks = S.mixer.decks.filter((d) => d.track === tr);
  if (!decks.length) { renderCrate(); return; }                 // it left the deck meanwhile: split again when it's back
  const mk = (chs) => { const b = S.ctx.createBuffer(2, chs[0].length, job.sr); b.copyToChannel(chs[0], 0); b.copyToChannel(chs[1], 1); return b; };
  tr.stems = { drums: mk(drums), music: mk(music) };
  log(`stems ready for "${tr.name}": drums and music can now be muted separately`);
  // decks already playing it switch to stems on the next bar, seamlessly
  for (const d of decks) if (d.playing) d.respawn(d.nextBarTime());
  renderCrate();
}

// ---------------- crate memory ----------------
// Decoded audio is big (a 4-minute track: ~90 MB, ~270 MB with stems) and Safari reloads a page that holds a few GB.
// So only tracks that can come up soon keep theirs: the decks' (with stems), the fly's audition, and the next ones it
// would consider, decoded again ahead of time from the File (which stays). The rest keep their grid, analysis and
// waveform. A track picked before it's back is decoded on load (loadTrack / previewTrack wait for it).
const KEEP = 3;                                      // an audition's worth of candidates
let trimTimer = 0;
const reviving = new Map();
function scheduleTrim() { clearTimeout(trimTimer); trimTimer = setTimeout(trimCrate, 1500); }
function trimCrate() {
  if (!S.mixer) return;
  const onDeck = new Set(S.mixer.decks.map((d) => d.track));
  const soon = new Set([...(S.dj?.aud?.cands || []), ...candidates(0, KEEP)]);
  for (let k = 0, n = 0; k < S.crate.length && n < 2; k++) {       // and the next two loadNext would take
    const t = S.crate[(S.crateNext + k) % S.crate.length];
    if (inStyle(t) && !onDeck.has(t)) { soon.add(t); n++; }
  }
  for (const t of S.crate) {
    if (!t.file || onDeck.has(t)) continue;         // demos are rendered, not decoded: they stay
    t.stems = null; t.rev = null;
    if (soon.has(t)) revive(t); else if (!reviving.has(t)) t.buffer = null;
  }
}
function revive(t) {
  if (t.buffer) return Promise.resolve(true);
  if (!reviving.has(t)) reviving.set(t, decodeAgain(t).finally(() => reviving.delete(t)));
  return reviving.get(t);
}
async function decodeAgain(t) {
  let data;
  try { data = await t.file.arrayBuffer(); } catch (e) {
    // the file was moved or deleted since it was dropped
    const k = S.crate.indexOf(t);
    if (k >= 0) { S.crate.splice(k, 1); if (k < S.crateNext) S.crateNext--; }
    log(`"${t.name}" can't be read any more (${safeName(e.message)}): taken out of the crate`);
    renderCrate();
    return false;
  }
  try {
    t.buffer = await S.ctx.decodeAudioData(data);
    if (t.pendingAnalysis && !S.mixer.decks.some((d) => d.track === t)) { applyAnalysis(t, t.pendingAnalysis); t.pendingAnalysis = null; }
    return true;
  } catch (e) {
    // it decoded when it was dropped, so this is the moment (memory pressure), not the file: it sits out a minute
    t.badUntil = performance.now() + 60000;
    log(`"${t.name}" couldn't be decoded again just now (${safeName(e.message || 'decode error')}); trying another track`);
    return false;
  }
}

// Dropped tracks play next, in the order they were dropped. The same recording twice (by SHA-1) is skipped: the fly
// could mix a song into itself.
const hashing = new Set();                          // being decoded now (two drops can overlap)
async function addFiles(files) {
  // each file goes in after the previous one of this drop (a second drop arriving meanwhile can't interleave it)
  let last = null, k = 0;
  try {
    for (const f of files) {
      if (!f.type.startsWith('audio') && !/\.(mp3|wav|ogg|flac|m4a|aac|aiff?)$/i.test(f.name)) continue;
      const sha = await f.arrayBuffer().then(sha1).catch(() => null);
      if (sha && (hashing.has(sha) || S.crate.some((t) => t.sha === sha) || S.mixer.decks.some((d) => d.track?.sha === sha))) {
        log(`"${safeName(f.name)}" is already in the crate: skipped`);
        continue;
      }
      if (sha) hashing.add(sha);
      log(`analysing "${safeName(f.name)}"…`);
      try {
        const t = await trackFromFile(S.ctx, f);
        t.sha = sha; t.file = f;
        if (sha) await withAnalysis(t, f);
        const at = last && S.crate.includes(last) ? S.crate.indexOf(last) + 1 : S.crate.length ? S.crateNext % S.crate.length : 0;
        S.crate.splice(at, 0, t); last = t;
        if (++k % 4 === 0) trimCrate();               // a big drop doesn't hold every file decoded until it's all in
        log(`crate + "${t.name}" — ${t.bpm.toFixed(1)} bpm, ${t.key}${t.gridSource ? ' · analysed beat grid + song structure' : ''}`);
        renderCrate();
      } catch (e) { log(`could not decode "${safeName(f.name)}": ${safeName(e.message)}`); }
      finally { hashing.delete(sha); }
    }
  } finally { scheduleTrim(); }
}

// The server's analysis of a track (beat grid + song structure), found by the file's SHA-1:
//   200 the analysis · 202 queued, or the server is still hashing its library · 404 unknown · 410 failed, for good
// The first answer comes before the track goes into the crate; the rest is asked in the background. An unknown track
// is uploaded for gentle background analysis once, and again only if the server lost it in a restart.
async function withAnalysis(t, f) {
  const r = await fetch(`/analysis/${t.sha}`).catch(() => null);
  if (r?.status === 200) useAnalysis(t, await r.json(), true);
  else pollAnalysis(t, f, r).catch(() => {});      // no analysis: the in-browser grid and the listener flies' section sense stand in
}

// a track on a deck takes its analysis when it next leaves it (its beat grid can't jump mid-play); a released one when
// it's decoded again (the grid fit checks the audio)
function useAnalysis(t, a, quiet) {
  if (!t.buffer || S.mixer.decks.some((d) => d.track === t)) t.pendingAnalysis = a;
  else if (!applyAnalysis(t, a)) { log(`"${t.name}": analysis not used (${t.analysisRejected || 'too few beats'})`); return; }
  if (!quiet) { log(`"${t.name}": beat grid + song structure analysed`); renderCrate(); }
}

async function pollAnalysis(t, f, r) {
  const url = `/analysis/${t.sha}`, ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.mp3'])[0];
  // hadIt: since the upload the server had it queued, or was away; a 404 after that means it restarted and lost it
  let uploads = 0, sendFails = 0, fails = 0, indexing = 0, hadIt = false;
  const failed = () => log(`"${t.name}": the server's analysis failed; the in-browser beat grid stays`);
  for (;;) {
    let wait = 30000;
    if (!r || r.status >= 500) {                    // away (restarting?): keep asking for a while
      if (++fails > 20) return;
      hadIt ||= uploads > 0;
    } else if (r.status === 200) { useAnalysis(t, await r.json(), false); return; }
    else if (r.status === 410) { failed(); return; }
    else if (r.status === 202) {
      fails = 0; hadIt ||= uploads > 0;
      // still hashing the library: ask again shortly, before uploading anything
      if ((await r.json().catch(() => ({}))).status === 'indexing' && indexing++ < 60) wait = 3000;
    } else if (r.status === 404 && (!uploads || (hadIt && uploads < 2))) {
      fails = 0;
      const p = await upload(url, f, ext);
      if (p?.status === 410) { failed(); return; }
      if (p?.status === 429) { log(`"${t.name}": analysis queue full, using the browser's grid`); return; }
      if (p && !p.ok) { log(`"${t.name}": not uploaded for analysis (the server answered ${p.status})`); return; }
      if (p) { uploads++; hadIt = false; } else if (++sendFails > 3) return;
    } else return;                                  // a 404 right after the upload: this server doesn't analyse tracks
    await new Promise((ok) => setTimeout(ok, wait));
    if (t.gridSource || (!S.crate.includes(t) && !S.mixer.decks.some((d) => d.track === t))) return;   // done, or gone
    r = await fetch(url).catch(() => null);
  }
}

// one upload at a time: each holds the whole file in memory
let uploading = Promise.resolve();
function upload(url, f, ext) {
  return (uploading = uploading.then(async () => fetch(url, { method: 'POST', body: await f.arrayBuffer(), headers: { 'X-Ext': ext } }))
    .catch(() => null));
}

// ---------------- start ----------------
// A failure before the splash goes shows on it and gives the button back (the half-built audio graph is dropped, so a
// second press starts clean); after it, it goes in the log. Tracks dropped or picked before Start wait in S.queued.
async function start() {
  if (!S.hello) { $('#splash-msg').textContent = 'waiting for the brain server… (python -m flybrain.server)'; return; }
  $('#btn-start').disabled = true;
  try { await startUp(); } catch (e) {
    console.error(e);
    const why = safeName(e?.message || String(e));
    if (S.started) { log(`something broke while starting: ${why}`); return; }
    // (closing fires the old context's statechange: unhook it first, or it puts up a resume button for a dead context)
    if (S.ctx) S.ctx.onstatechange = null;
    try { S.ctx?.close(); } catch { /* already closed */ }
    document.querySelector('#resume')?.remove();
    S.crate = S.crate.filter((t) => t.file);           // demos rendered before the failure are rendered again
    Object.assign(S, { ctx: null, mixer: null, ears: null, synth: null, perf: null, dj: null, mc: null });
    $('#splash-msg').textContent = `the fly couldn't start: ${why}. Press Start to try again (or reload the page).`;
    $('#btn-start').disabled = false;
  }
}
async function startUp() {
  const ctx = S.ctx = new AudioContext({ latencyHint: 'interactive' });
  // Safari can suspend / interrupt audio (sleep, Bluetooth switch, a call): offer a one-tap resume instead of silence
  const resume = () => ctx.resume().then(() => document.querySelector('#resume')?.remove()).catch(() => {});
  ctx.onstatechange = () => {
    if (ctx.state === 'running') { document.querySelector('#resume')?.remove(); return; }   // it came back on its own
    if (document.querySelector('#resume')) return;
    const b = document.createElement('button'); b.id = 'resume'; b.textContent = '▶ audio paused by the browser: tap to resume';
    Object.assign(b.style, { position: 'fixed', left: '50%', top: '12px', transform: 'translateX(-50%)', zIndex: 99, fontSize: '15px', padding: '10px 18px' });
    b.onclick = resume; document.body.append(b);
  };
  if (!S.visBound) {                                 // once: a retried start must not leave one bound to a dead context
    S.visBound = true;
    document.addEventListener('visibilitychange', () => {
      const c = S.ctx;
      if (!document.hidden && c && c.state === 'suspended') c.resume().then(() => document.querySelector('#resume')?.remove()).catch(() => {});
    });
  }
  const mixer = S.mixer = new Mixer(ctx);
  mixer.vol = +$('#volume').value;                  // silent until the decks start, then a 2 s fade up to it
  const bands = S.hello.inputs.filter((c) => c.ear).map((c) => ({ name: c.name, ear: c.ear, lo: c.lo, hi: c.hi }));
  S.bands = bands;
  S.ears = new Ears(ctx, mixer, bands);
  S.synth = new FlySynth(ctx, mixer.master, S.hello.outputs);
  S.synth.midi = S.midiOuts?.get($('#midi-out').value) || null;     // a MIDI port picked before Start
  S.perf = new Performer(mixer, S.synth, log);
  S.perf.onActivity = lightPad;
  S.dj = new FlyDJ(mixer, S.ears, S.synth, S.perf, S.hello.outputs, log);
  S.dj.epic = +$('#epic').value;
  S.dj.neuronsDecide = $('#neurons').checked;
  S.dj.trained = !!S.hello.trained;
  if (S.hello.trained?.readout) {
    if ((S.hello.flies || 1) >= 2) S.dj.setListeners(S.hello.trained.readout, S.hello.outputs);
    else S.dj.setReadout(S.hello.trained.readout, S.hello.outputs);
  }
  if ((S.hello.flies || 1) >= 2) {
    S.ears.listenRaw();
    // each listener fly hears its own deck, raw: there's no cue / room choice to make
    const er = $('#ears-room'); er.disabled = true; er.parentElement.title = 'with two or three flies each listener fly hears its own deck, so there is no room mix to choose';
  }
  if ((S.hello.flies || 1) >= 2 && S.hello.sections) {
    S.dj.setSections(S.hello.sections, S.hello.outputs);
    log(`section sense v2: the listener flies' ${S.hello.sections.groups.length} output-neuron types → intro / main / breakdown / outro, on each deck's bar grid`);
  }
  if ((S.hello.flies || 1) === 3) log('🪰🪰🪰 <b>three flies</b>: a listener fly on each deck (each hears its deck in both ears) feeds a <b>DJ fly</b> — its left ear hears listener A, its right ear listener B');
  else if ((S.hello.flies || 1) === 2) log('🪰🪰 <b>two flies</b>: one listener per deck; the on-air deck\'s fly performs');
  if (S.hello.trained) log(`this fly's brain is <b>trained</b>: ${S.hello.trained.synapses.toLocaleString()} synapses learned when a DJ builds, leaves space, mixes and peaks`);
  S.mc = S.dj.mc = new MC(log);
  hookVisualiser();
  S.mc.enabled = $('#mc').checked;
  // the MC hypes builds: "are you ready?" halfway, the shout lands on the drop
  S.perf.buildKind = buildKind;
  S.perf.onBuild = (T0, Td) => {
    const now = S.ctx.currentTime;
    S.dj.shout('ready', Math.max(0, (T0 + Td) / 2 - now));
    setTimeout(() => { S.mc.last = -1e9; S.dj.shout('hype'); }, Math.max(0, (Td - now) * 1000));
  };
  S.dj.onLoadNext = loadNext;
  S.dj.loadPending = (i) => !!S.want[i] && S.want[i] !== S.mixer.decks[i].track;   // a load still decoding its track
  S.dj.onArrive = (deck, { snap, at }) => {
    if (!S.tempo || !$('#follow').checked || !deck.track) return;
    const bpm = styleTempo(S.mixer.tempoOf(deck.track));    // its own speed in the set's frame (a half-time track: ×2)
    if (Math.abs(bpm / S.tempo.base - 1) < 0.005) return;
    if (snap) {
      // tempo jumps with the cut, on the beat the new track lands
      S.tempo.snap = { bpm, at, name: deck.track.name };     // applied by the control loop when the audio clock gets there
    } else {
      S.tempo.glideTo = bpm;
      log(`tempo journey → drifting toward ${bpm.toFixed(1)} BPM ("${deck.track.name}")`);
    }
  };
  S.dj.picker = { candidates, preview: previewTrack, choose: (i, t, why) => loadTrack(i, t, why) };
  // (a deck that ends at the fader's midpoint, e.g. mid double drop, leaves the other one playing: no reload there)
  mixer.decks.forEach((d, i) => { d.onEnded = () => { log(`deck ${d.name} track ended`); if (mixer.airness(d) > 0.5 + 1e-6) loadNext(i); }; });
  buildMoves();
  bindDeckUI();
  if (await mixer.initKeylock()) mixer.setKeylock($('#keylock').checked);
  else { $('#keylock').checked = false; $('#keylock').disabled = true; }
  bindPerformance();

  $('#splash-msg').textContent = 'rendering demo tracks…';
  S.style = $('#crate-style').value;
  const jobs = [...Array(desiCount).keys()].map((i) => async () => describeDemo(await renderDesi(i)))
    .concat([...Array(demoCount).keys()].map((i) => async () => describeDemo(await renderDemo(i))));
  if (S.style === 'club') jobs.push(...jobs.splice(0, desiCount));
  S.crate.push(await jobs.shift()());
  S.crate.push(await jobs.shift()());
  $('#splash').classList.add('gone');
  S.started = true;
  mixer.fadeIn(2);
  loadNext(0);
  loadNext(1);
  log('the fly is listening: left ear on deck A, right ear on deck B');
  renderCrate();
  startClock(control, 25);
  requestAnimationFrame(anim);
  if (S.queued.length) addFiles(S.queued.splice(0));       // tracks dropped before Start: into the crate now
  for (const job of jobs) { S.crate.push(await job()); renderCrate(); }
}

// your tempo change wins over the holds that keep scheduled moves on the beat (they may land off it: your call)
function manualTempo() { S.dj.holdTempoUntil = 0; S.perf.holdUntil = 0; S.tempo.snap = null; }

// ---------------- control loop (40 Hz) ----------------
// ticked from a worker's timer: browsers throttle a hidden page's own timers (WebKit down to once a second, even while
// it plays audio: a background tab, or a window covered by the full-screen visualiser), not a worker's
function startClock(f, ms) {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = () => f();
    w.onerror = () => { w.terminate(); setInterval(f, ms); };
    S.clock = w;
  } catch (e) { setInterval(f, ms); }
}
let lastCtl = performance.now();
function control() {
  const now = performance.now(), dt = Math.min(0.2, (now - lastCtl) / 1000); lastCtl = now;
  const feed = { sugar: now < S.feed.sugar ? 1 : 0, bitter: now < S.feed.bitter ? 1 : 0, wind: S.wind };
  const flies = S.hello.flies || 1;
  if (flies >= 2) {
    // one listener fly per deck, each hearing its deck in both ears; taste and wind go to the performing fly
    const [a, b] = S.ears.updatePerDeck(dt);
    if (flies === 3) send({ type: 'drive', levels: a, levels2: b, levels3: feed });
    else send({ type: 'drive', levels: { ...a, ...feed }, levels2: { ...b, ...feed } });
    S.levels = { ...Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith('earL'))),
                 ...Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith('earR'))) };
  } else {
    const lv = { ...S.ears.update(dt), ...feed };
    send({ type: 'drive', levels: lv });
    S.levels = lv;
  }
  S.dj.tick(dt);
  if (now - (S.busAt || 0) > 100) { S.busAt = now; postState(); }

  // master tempo (your setting + the fly's ride), glided so changes sound like riding the pitch fader
  if (S.tempo) {
    // the tempo jumps with a cut on the beat the new track lands (by the audio clock: a hidden page's timers lag)
    const sn = S.tempo.snap;
    if (sn && S.ctx.currentTime >= sn.at) {
      S.tempo.snap = null; S.tempo.base = S.tempo.cur = sn.bpm; S.tempo.glideTo = null;
      log(`tempo → ${sn.bpm.toFixed(1)} BPM with the cut ("${sn.name}")`);
    }
    // held while a transition is lined up, or while a move has cuts / restores fixed on the audio clock: a rate change
    // would move the bar lines away from them. The tempo fader and the glide stay put too, so they go on from there
    const held = S.ctx.currentTime < Math.max(S.dj.holdTempoUntil || 0, S.perf.holdUntil || 0);
    if (S.tempo.glideTo && !held) {            // tempo journey toward the on-air track's own BPM (~20 s)
      S.tempo.base += (S.tempo.glideTo - S.tempo.base) * Math.min(1, dt / 20);
      if (Math.abs(S.tempo.glideTo - S.tempo.base) < 0.05) { S.tempo.base = S.tempo.glideTo; S.tempo.glideTo = null; }
    }
    const ride = S.dj.auto && $('#ride').checked ? S.dj.tempoOffset : 0;
    const target = S.tempo.base * (1 + ride);
    if (!held) S.tempo.cur += (target - S.tempo.cur) * Math.min(1, dt / 0.6);
    if (!held && Math.abs(S.tempo.cur - S.tempo.applied) > 0.02) { S.mixer.applyTempo(S.tempo.cur); S.tempo.applied = S.tempo.cur; }
  }
  // follow the on-air deck's key
  const on = S.mixer.onAir();
  if (on.track && on.track !== S.lastOnAir && S.mixer.airness(on) > 0.6) {
    S.lastOnAir = on.track;
    const how = [...(S.history || [])].reverse().find((h) => S.ctx.currentTime - h.t < 40 && /echo out|hard cut|drop-swap|dropping into|double drop|1-bar kill|spinback|blend|cut to/.test(h.text));
    (S.tracklist ||= []).push({ t: S.ctx.currentTime, name: on.track.name, bpm: on.bpm, key: on.track.key || '', how: how ? how.text : 'first track' });
  }
  if (on.playing && on.track) {
    const sel = $('#scale').value;
    if (sel === 'auto') S.synth.setKey(on.track.root ?? 45, on.track.scale === 'minor' ? 'minpent' : (on.track.scale || 'minpent'));
    else S.synth.setKey(on.track.root ?? 45, sel);
    const style = on.track.style === 'desi' ? 'desi' : 'club';
    if (style !== S.synth.style) { S.synth.style = style; log(style === 'desi' ? 'fly voice → <b>dhol + sitar</b> (motor neurons drum, descending neurons play sitar)' : 'fly voice → club synth'); }
  }

  // 16th-note grid for the fly voice, clocked from the on-air deck
  const ctx = S.ctx, horizon = ctx.currentTime + 0.12;
  if (S.nextGrid < ctx.currentTime) S.nextGrid = on.playing ? on.nextBeatTime(4) : ctx.currentTime + 0.02;
  let guard = 0;
  while (S.nextGrid < horizon && guard++ < 8) {
    const spb16 = 60 / (on.bpm || 120) / 4;
    S.synth.gridStep(S.nextGrid, spb16);
    S.nextGrid = on.playing ? on.nextBeatTime(4, S.nextGrid + 0.001) : S.nextGrid + spb16;
  }
}

// ---------------- UI ----------------
function buildMoves() {
  const el = $('#moves'); el.innerHTML = '';
  S.dj.moves.forEach((m) => {
    const d = document.createElement('div'); d.className = 'move';
    d.innerHTML = `<div class="nm">${m.label}<small>${m.slots.length} neurons → ${m.action}</small></div><div class="bar"><div></div></div>`;
    m.el = d; m.barEl = d.querySelector('.bar div');
    el.append(d);
  });
}

function bindDeckUI() {
  S.mixer.decks.forEach((d, i) => {
    const root = $(`#deck-${d.name}`);
    d.ui = { root, name: $('.track-name', root), bpm: $('.bpm', root), time: $('.time', root), wave: $('.wave', root),
             habit: $('.habit div', root), play: $('.btn-play', root) };
    d.ui.play.onclick = () => { if (d.playing) d.stop(); else if (d.track) startSynced(d, S.mixer.decks[1 - i]); else loadNext(i); };
    $('.btn-next', root).onclick = () => loadNext(i);
    // fix a wrong tempo detection: rescale the beat grid (the first beat stays put). Not on an analysed track: its grid
    // is All-In-One's downbeats, and its sections, exit bar and cues are counted in its bars (anim greys the buttons)
    const rescale = (f) => {
      const t = d.track; if (!t || t.gridSource) return;
      t.bpm *= f;
      if (t.cues) t.cues = t.cues.map((c) => ({ ...c, beat: Math.round(c.beat * f) }));
      t.energy = analyzeEnergy(t.buffer, t.bpm, t.firstBeat).energy;
      if (t.source === 'file' && t.style !== 'desi') t.style = t.bpm >= 155 ? 'dnb' : t.bpm < 108 ? 'hiphop' : t.style === 'dnb' || t.style === 'hiphop' ? 'club' : t.style;
      d.setRate(S.mixer.rateFor(t, S.mixer.masterBpm || t.bpm));
      log(`deck ${d.name}: "${t.name}" tempo corrected to ${t.bpm.toFixed(1)} BPM (${t.style})`);
      renderCrate();
    };
    $('.btn-half', root).onclick = () => rescale(0.5);
    $('.btn-double', root).onclick = () => rescale(2);
    d.ui.oct = [$('.btn-half', root), $('.btn-double', root)];
    for (const b of d.ui.oct) b.dataset.tip = b.title;
    for (const band of ['high', 'mid', 'low']) {
      const inp = $(`.eq-${band}`, root);
      inp.oninput = () => { d._manualEQ = true; d.setEQ(band, +inp.value); };
      inp.ondblclick = () => { inp.value = 0; d.setEQ(band, 0); d._manualEQ = false; };
      d.ui[band] = inp;
    }
    root.querySelectorAll('.cue').forEach((b) => { b.onclick = () => S.perf.hotCue(d, +b.dataset.cue); });
    d.ui.stems = [...root.querySelectorAll('.stem')];
    d.ui.stemStatus = $('.stem-status', root);
    d.ui.stems.forEach((b) => { b.onclick = () => { const n = b.dataset.stem; d.setStem(n, !d.stemOn[n], d.playing ? d.nextBeatTime(1) : S.ctx.currentTime); }; });
    const f = $('.filter', root);
    f.oninput = () => { d._manualFilter = true; d.setFilter(+f.value); };
    f.ondblclick = () => { f.value = 0; d._manualFilter = false; };
    d.ui.filter = f;
  });
}

// ---------------- performance pads & keyboard ----------------
const PAD_OF = {};   // activity name -> pad elements to light
function lightPad(name) {
  for (const el of PAD_OF[name] || []) { el.classList.add('lit'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('lit'), 450); }
}
function runAct(act, shift = false) {
  const P = S.perf, [kind, arg] = act.split(':');
  if (!S.started) return;
  const beats = S.fxBeats;
  if (kind === 'fx') P.beatFx(arg, beats, 'you');
  else if (kind === 'roll') P.roll(+arg, Math.max(1, beats), 'you');
  else if (kind === 'scratch') P.scratch(arg, Math.max(1, beats), 'you');
  else if (kind === 'build') P.buildDrop({ bars: shift ? 8 : +arg, kind: buildKind() });
  else if (kind === 'chop') P.chop({ bars: 2, who: 'you' });
  else if (kind === 'doubledrop') { const end = P.doubleDrop({ who: 'you' }); if (end) S.dj.afterCut(end); else log('double drop needs both decks playing'); }
  else if (kind === 'mashup') P.mashup({ who: 'you' }) || log('mashup needs both decks playing');
  else if (kind === 'layer') P.layer({ who: 'you' }) || log('loop layer needs both decks playing');
  else if (kind === 'stutter') P.stutter('you');
  else if (kind === 'reverse') P.reverse('you');
  else if (kind === 'tease') P.bassTease('you');
  else if (kind === 'drumsout') P.drumsOut({ bars: 4, who: 'you' });
  else if (kind === 'melodyout') P.melodyOut({ bars: 8, who: 'you' }) || log('strip to drums needs stems (still separating?)');
  else if (kind === 'hardcut') { const at = P.hardCut('you'); if (at) S.dj.afterCut(at); }
  else if (kind === 'killdrop') { const at = P.killDrop('you'); if (at) S.dj.afterCut(at); else log('1-bar kill needs both decks playing'); }
  else if (kind === 'acid') P.acid({ bars: 4, pattern: S.dj.spikePattern(), who: 'you' });
  else if (kind === 'singalong') P.singalong({ bars: 4, who: 'you' });
  else if (kind === 'pump') P.pump('you');
  else if (kind === 'dub') P.dub('you');
  else if (kind === 'resfilter') P.resFilter('you');
  else if (kind === 'fill') P.fill('you');
  else if (kind === 'dropswap') { const at = P.dropSwap('you'); if (at) S.dj.afterCut(at); else log('drop swap needs both decks playing'); }
  else if (kind === 'echoout') { const at = P.echoOut('you'); if (at) S.dj.afterCut(at); }
  else if (kind === 'spincut') { const at = P.spinCut('you'); if (at) S.dj.afterCut(at); }
  else if (kind === 'brake') P.brake('you');
  else if (kind === 'backspin') P.backspin('you');
  else if (kind === 'jump') P.beatJump(+arg);
  else if (kind === 'sample') P.sample(arg, 'you');
}
// the style's home tempo range, if the music can get there without sounding wrong:
// within 8% of its own tempo on vinyl-style pitch, within 20% with key lock on
function styleTempo(bpm) {
  const r = S.dj?.persona?.bpm;
  if (!r) return bpm;
  const t = Math.min(r[1], Math.max(r[0], bpm));
  return Math.abs(t / bpm - 1) <= (S.mixer?.keylock ? 0.2 : 0.08) ? t : bpm;
}

// build style: the dropdown, or the current DJ style's favourite
function buildKind() { const v = $('#build-kind').value; return v === 'auto' ? (S.dj?.persona?.build?.kind || 'roll') : v; }

function bindPerformance() {
  S.fxBeats = 1;
  const keyMap = {};
  for (const k of Object.keys(PAD_OF)) delete PAD_OF[k];          // (bound again on a retried start)
  document.querySelectorAll('.pad').forEach((b) => {
    const act = b.dataset.act, name = act.startsWith('fx:') || act.startsWith('sample:') ? act.split(':')[1]
      : act.startsWith('build') ? 'build' : act.split(':')[0];
    (PAD_OF[name] ||= []).push(b);
    b.onclick = (e) => runAct(act, e.shiftKey);
    const k = b.querySelector('kbd')?.textContent;
    if (k && k.length === 1) keyMap[k.toLowerCase()] = act;
  });
  PAD_OF.echo = [...(PAD_OF.echo || []), ...(PAD_OF.echoout || [])];
  keyMap[' '] = 'build:4';
  S.keyMap = keyMap;
  $('#beats').querySelectorAll('button').forEach((b) => b.onclick = () => {
    $('#beats').querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel'); S.fxBeats = +b.dataset.b;
  });
  $('#epic').oninput = (e) => { S.dj.epic = +e.target.value; };
  $('#pace').oninput = (e) => { S.dj.moveTarget = +e.target.value; $('#pace-val').textContent = e.target.value; };
  $('#min-on').oninput = (e) => { S.dj.minOnAir = +e.target.value; $('#min-on-val').textContent = `${e.target.value} s`; };
  // "play like" DJ styles
  const sel = $('#persona');
  if (!sel.options.length) for (const [k, st] of Object.entries(STYLES)) { const o = document.createElement('option'); o.value = k; o.textContent = st.name; sel.append(o); }
  const applyPersona = () => {
    S.dj.setPersona(sel.value);
    const st = S.dj.persona;
    $('#persona-tag').textContent = st.tagline;
    // move the tempo into the style's home range (gently) if the music can get there without sounding pitched
    if (st.bpm && S.tempo) {
      const target = styleTempo(S.tempo.base);
      if (target !== S.tempo.base) { S.tempo.glideTo = target; log(`${st.name} plays ${st.bpm[0]}–${st.bpm[1]} BPM → tempo drifting to ${target.toFixed(0)}`); }
      else if (S.tempo.base < st.bpm[0] || S.tempo.base > st.bpm[1]) log(`${st.name} usually plays ${st.bpm[0]}–${st.bpm[1]} BPM; this music is too far away to get there, so the tempo stays`);
    }
    log(`the fly now plays like <b>${st.name}</b>`);
  };
  sel.onchange = applyPersona;
  // set planner
  if (!$('#arc').options.length) for (const [k, a] of Object.entries(ARCS)) { const o = document.createElement('option'); o.value = k; o.textContent = a.name; $('#arc').append(o); }
  $('#set-start').onclick = () => {
    const k = $('#arc').value, min = +$('#set-len').value;
    S.dj.startSet(k, min); S.arcHistory = [];
    log(k === 'free' ? '📋 set plan off — the fly plays freely' : `📋 set plan: <b>${ARCS[k].name}</b>, ${min} minutes — epicness, track choice, tempo, builds and breakdowns follow the arc`);
  };
  $('#persona-tag').textContent = STYLES.fly.tagline;
  // tempo
  const setBase = (b) => { if (!S.tempo) return; S.tempo.base = Math.max(70, Math.min(180, b)); S.tempo.glideTo = null; manualTempo(); };
  $('#bpm').oninput = (e) => setBase(+e.target.value);
  $('#keylock').onchange = (e) => { S.mixer?.setKeylock(e.target.checked); log(`key lock ${e.target.checked ? 'on: tempo changes keep the pitch' : 'off: tempo moves the pitch, like vinyl'}`); };
  $('#bpm-down').onclick = () => setBase(S.tempo.base - 1);
  $('#bpm-up').onclick = () => setBase(S.tempo.base + 1);
  $('#bpm-reset').onclick = () => { const t = S.mixer.onAir().track; if (t) { setBase(t.bpm); log(`tempo back to ${t.bpm.toFixed(1)} BPM`); } };
  $('#bpm-tap').onclick = () => {
    const now = performance.now(), taps = S.tempo.taps;
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now); if (taps.length > 6) taps.shift();
    if (taps.length >= 3) { const bpm = 60000 * (taps.length - 1) / (taps[taps.length - 1] - taps[0]); setBase(bpm); log(`tap tempo → ${bpm.toFixed(1)} BPM`); }
  };
  // Single-key shortcuts (once, even if Start is pressed again after a failure). They can be switched off (WCAG
  // 2.1.4), and a focused control keeps its own keys: Space on a focused button presses it, not BUILD & DROP.
  if (S.keysBound) return;
  S.keysBound = true;
  const cueKeys = { 1: [0, 0], 2: [0, 1], 3: [0, 2], 4: [0, 3], 7: [1, 0], 8: [1, 1], 9: [1, 2], 0: [1, 3] };
  document.addEventListener('keydown', (e) => {
    if (!S.keysOn || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('button, input, select, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    const k = e.key.toLowerCase();
    if (k in cueKeys && S.started) { const [d, c] = cueKeys[k]; S.perf.hotCue(S.mixer.decks[d], c); return; }
    // by key position: with Shift, e.key is '_' / '+'
    const up = ['Equal', 'NumpadAdd'].includes(e.code) || e.key === '=' || e.key === '+', down = ['Minus', 'NumpadSubtract'].includes(e.code) || e.key === '-' || e.key === '_';
    if ((up || down) && S.tempo) { S.tempo.base += (up ? 1 : -1) * (e.shiftKey ? 0.1 : 1); S.tempo.glideTo = null; manualTempo(); return; }
    const act = S.keyMap[k];
    if (act) { e.preventDefault(); runAct(act, e.shiftKey); lightPad(act.startsWith('build') ? 'build' : act.split(':')[1] || act); }
  });
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// only touch the DOM when a value actually changes (keeps Safari's compositor calm)
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
const setStyle = (el, k, v) => { if (el.style[k] !== v) el.style[k] = v; };

let lastAnim = performance.now(), lastStat = performance.now();
function anim() {
  requestAnimationFrame(anim);
  const now = performance.now();
  if (now - lastAnim < 32 || document.hidden) return;   // ~30 fps is plenty
  const dt = (now - lastAnim) / 1000; lastAnim = now;
  S.brainView?.draw();
  S.raster?.draw(dt);
  if (S.levels) {
    drawEar($('#ear-L'), S.bands.filter((b) => b.ear === 'L'), S.levels, '#35e0c2');
    drawEar($('#ear-R'), S.bands.filter((b) => b.ear === 'R'), S.levels, '#ff5ca8');
  }
  const mx = S.mixer, colors = ['#35e0c2', '#ff5ca8'];
  mx.decks.forEach((d, i) => {
    drawWave(d.ui.wave, d, colors[i]);
    setText(d.ui.name, d.track ? `${d.track.name}${d.track.key ? '  ·  ' + d.track.key : ''}` : '—');
    setText(d.ui.bpm, d.track ? `${d.bpm.toFixed(1)} BPM${d.rate !== 1 ? ` (${((d.rate - 1) * 100).toFixed(1)}%)` : ''}` : '— BPM');
    setText(d.ui.time, d.track ? `${fmt(Math.max(0, d.position()))} / ${fmt(d.duration)}` : '0:00');
    setStyle(d.ui.habit, 'width', `${(S.ears.habit[i] * 100).toFixed(0)}%`);
    setText(d.ui.play, d.playing ? '■' : '▶');
    for (const b of d.ui.stems) { b.disabled = !d.hasStems; b.classList.toggle('off', !d.stemOn[b.dataset.stem]); }
    // greyed rather than disabled: some browsers show no tooltip on a disabled button, and this one says why
    const fixed = !!d.track?.gridSource;
    for (const b of d.ui.oct) if (b.classList.contains('locked') !== fixed) {
      b.classList.toggle('locked', fixed); b.setAttribute('aria-disabled', fixed);
      b.title = fixed ? 'this track\'s tempo comes from its analysed beat grid (its sections and exit are counted on it)' : b.dataset.tip;
    }
    setText(d.ui.stemStatus, d.hasStems ? '' : d.track?.stemProgress != null ? `separating stems ${Math.round(d.track.stemProgress * 100)}%` : d.track ? 'no stems' : '');
    d.ui.root.classList.toggle('onair', mx.airness(d) > 0.5);
    if (!d._manualFilter && document.activeElement !== d.ui.filter) d.ui.filter.value = d.filterVal;
    if (!d._manualEQ) d.ui.low.value = d.eqVals.low;
  });
  for (const n of ['sweep', 'lpf', 'trans', 'crush', 'flanger', 'reverb']) if (mx.fx.isActive(n)) lightPad(n);
  if (document.activeElement !== $('#xfader')) $('#xfader').value = mx.x;
  drawArc(now);
  if (S.tempo) {
    setText($('#bpm-val'), S.tempo.cur.toFixed(1));
    if (document.activeElement !== $('#bpm')) $('#bpm').value = S.tempo.base;
  }
  const p = S.dj.pref, bar = $('#pref-bar div');
  setStyle(bar, 'left', `${(50 + Math.min(0, p) * 50).toFixed(0)}%`); setStyle(bar, 'width', `${(Math.abs(p) * 50).toFixed(0)}%`);
  S.dj.moves.forEach((m) => {
    setStyle(m.barEl, 'width', `${(m.level * 100).toFixed(0)}%`);
    m.el.classList.toggle('fire', m.fired && now - m.fired < 500);
  });
  if (now - lastStat > 1000) {
    const secs = (now - lastStat) / 1000;
    $('#st-rate').textContent = Math.round(S.stats.spikes / secs).toLocaleString();
    $('#st-load').textContent = S.stats.load.toFixed(2);
    $('#st-time').textContent = (S.stats.t / 1000).toFixed(1);
    S.stats.spikes = 0; lastStat = now;
  }
}

// the set plan graph: plan line, "now" marker, and how hard the fly has actually been playing (epicness dots)
let lastArcSample = 0;
function drawArc(nowMs) {
  const c = $('#arc-graph'), g = c.getContext('2d'), W = c.width, H = c.height, arc = S.dj?.arc;
  if (!arc) { if (c._drawn !== 'free') { g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H); g.fillStyle = '#7c8598'; g.font = '11px ui-monospace, monospace'; g.fillText('no plan — pick an arc and press Start set', 8, H / 2 + 4); c._drawn = 'free'; } setText($('#set-status'), ''); if ($('#epic') !== document.activeElement && S.dj) $('#epic').value = S.dj.epic; return; }
  c._drawn = 'arc';
  const t = S.ctx.currentTime, frac = (t - arc.start) / arc.length;
  if (nowMs - lastArcSample > 1000) { lastArcSample = nowMs; (S.arcHistory ||= []).push([frac, S.dj.epic]); }
  g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#8aa0ff'; g.lineWidth = 2; g.beginPath();
  for (let x = 0; x <= W; x += 3) { const y = H - 4 - energyAt(arc.points, x / W) * (H - 8); x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  g.fillStyle = '#ffb347';
  for (const [f, e] of S.arcHistory || []) g.fillRect(f * W - 1, H - 4 - ((e - 0.1) / 0.9) * (H - 8) - 1, 2, 2);
  g.fillStyle = '#fff36b'; g.fillRect(Math.min(W - 2, frac * W), 0, 2, H);
  const left = Math.max(0, arc.length * (1 - frac));
  setText($('#set-status'), `energy ${energyAt(arc.points, frac).toFixed(2)} · ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} left`);
  if ($('#epic') !== document.activeElement) $('#epic').value = S.dj.epic;
}

// ---------------- visualiser feed ----------------
// Every move goes through the Performer, whoever makes it, so its methods are wrapped: a call that logged something
// happened, and becomes one 'move' event. What caused it rides along in S.trigger: the neuron group whose burst fired
// it (FlyDJ.fire), the transition that came due (FlyDJ.tick), or else it's read from the "who" text.
const ACTS = ['beatFx', 'roll', 'scratch', 'brake', 'backspin', 'sample', 'buildDrop', 'chop', 'doubleDrop', 'mashup', 'layer',
  'drumsOut', 'melodyOut', 'stutter', 'reverse', 'bassTease', 'dub', 'resFilter', 'pump', 'singalong', 'fill', 'acid',
  'killDrop', 'hardCut', 'echoOut', 'dropSwap', 'spinCut'];
const ARG_AT = { beatFx: 0, roll: 0, scratch: 0, sample: 0 };        // the rest take (who) or ({ bars, who })
const STYLE_GROUP = { drop: 'escape', echo: 'echo', spin: 'reject', cut: 'trans', double: 'arousal', kill: 'flange', blend: 'steer' };

function ctxToAbs(t) {
  const ts = S.ctx.getOutputTimestamp?.();
  if (ts?.performanceTime) return performance.timeOrigin + ts.performanceTime + (t - ts.contextTime) * 1000;
  return absNow() + (t - S.ctx.currentTime) * 1000;
}

function performer() {
  const flies = S.hello.flies || 1, onIdx = S.mixer.onAir() === S.mixer.decks[0] ? 0 : 1;
  return flies === 3 ? 2 : flies === 2 ? onIdx : 0;
}

function moveEvent(act, args, ret) {
  const who = args.map((a) => (typeof a === 'string' ? a : a?.who)).filter((w) => typeof w === 'string' && w).pop() || '';
  const text = who.replace(/<[^>]+>/g, '');
  const arg = act in ARG_AT ? args[ARG_AT[act]] : act === 'blend' ? args[0] : (args[0]?.bars ?? null);
  let group = S.trigger?.group || null, fly = performer();
  if (!group && /SPACE neurons/.test(text)) {
    group = 'SPACE';
    if ((S.hello.flies || 1) >= 2) fly = S.mixer.onAir() === S.mixer.decks[0] ? 0 : 1;   // the on-air deck's listener
  } else if (!group && /arousal surge/.test(text)) group = 'arousal';
  else if (!group && /motor neurons/.test(text)) group = 'sing';
  const beats = act in ARG_AT && act !== 'sample' ? (typeof args[1] === 'number' ? args[1] : 1)
    : act === 'blend' ? 4 * (S.dj.persona.blendBars || 8) : typeof args[0]?.bars === 'number' ? 4 * args[0].bars : null;
  const ev = { type: 'move', act, arg, beats, who: text, by: !text || text === 'you' ? 'you' : /set plan/.test(text) ? 'plan' : 'fly',   // the fly always names itself
    group, fly, intensity: S.trigger?.intensity ?? null, transition: S.trigger?.transition ?? null,
    lands: typeof ret === 'number' && ret > S.ctx.currentTime ? ctxToAbs(ret) : null,
    text: (S.lastLog || '').replace(/<[^>]+>/g, ''), t: absNow() };
  (S.recentMoves ||= []).push(ev);
  if (S.recentMoves.length > 16) S.recentMoves.shift();
  bus?.postMessage(ev);
}

function hookVisualiser() {
  const P = S.perf, dj = S.dj;
  let depth = 0;
  for (const name of ACTS) {
    const f = P[name].bind(P);
    P[name] = (...args) => {
      const n0 = S.logN || 0;
      depth++;
      let r;
      try { r = f(...args); } finally { depth--; }
      if (depth === 0 && (S.logN || 0) > n0) { S.moved = true; moveEvent(name, args, r); }
      return r;
    };
  }
  const fire = dj.fire.bind(dj);
  dj.fire = (key, label, intensity, count) => {
    S.trigger = { group: MOVES.find((m) => m.label === label)?.key || key, intensity };
    try { return fire(key, label, intensity, count); } finally { S.trigger = null; }
  };
  const tick = dj.tick.bind(dj);
  dj.tick = (dt) => {
    const p = dj.pending, due = p && S.ctx.currentTime >= p.at;
    if (due) { S.trigger = { group: STYLE_GROUP[p.style], transition: p.style }; S.moved = false; }
    try { tick(dt); } finally { if (due) S.trigger = null; }
    // a blend isn't a Performer call: the fly just starts moving the crossfader
    if (due && !dj.pending && dj.commit && !S.moved) {
      S.trigger = { group: 'steer', transition: 'blend' };
      moveEvent('blend', [p.dir > 0 ? 'B' : 'A', '<b>the fly</b>']);
      S.trigger = null;
    }
  };
  if (S.busHooked) return;                          // (a second Start after a failure)
  S.busHooked = true;
  bus?.addEventListener('message', (e) => {
    if (e.data?.type === 'sync?') { bus.postMessage({ type: 'sync', moves: S.recentMoves || [] }); postState(); }
  });
}

function postState() {
  if (!bus || !S.mixer) return;
  const mx = S.mixer, dj = S.dj, on = mx.onAir(), flies = S.hello.flies || 1;
  let beat = null;
  if (on.playing && on.track) { const nb = on.nextBeatTime(1); beat = { at: ctxToAbs(nb), spb: 60 / on.bpm, n: Math.round(on.beatAt(nb)) }; }
  const p = dj.pending, lv = S.levels || {}, ear = (e) => S.bands.filter((b) => b.ear === e).map((b) => +(lv[b.name] || 0).toFixed(3));
  bus.postMessage({
    type: 'state', t: absNow(), flies, performer: performer(), onAir: on === mx.decks[0] ? 0 : 1, xf: mx.x,
    decks: mx.decks.map((d) => ({ name: d.name, track: d.track?.name || null, bpm: d.bpm, playing: d.playing,
      pos: d.track ? d.position() : 0, dur: d.track ? d.duration : 0, air: mx.airness(d) })),
    beat, pref: dj.pref, epic: dj.epic, persona: dj.persona.name, arc: dj.arc ? ARCS[dj.arc.key].name : null, auto: dj.auto,
    sense: { space: dj.sense.space.on, peak: dj.sense.peak.on, mix: S.ctx.currentTime < (dj.mixWindow || 0) },
    listeners: dj.listeners?.map((l) => Object.fromEntries(Object.entries(l.r).map(([k, r]) => [k, { rank: r.rank ?? 0.5, on: !!r.active }]))) || null,
    pending: p ? { style: p.style, dir: p.dir, at: ctxToAbs(p.at), group: STYLE_GROUP[p.style] } : null,
    groups: Object.fromEntries(dj.moves.map((m) => [m.key, +m.level.toFixed(3)])),
    ears: { L: ear('L'), R: ear('R') }, load: S.stats.load,
  });
}

function bindGlobalUI() {
  // master volume (after the ceiling; recordings and the fly's room-mix ears are taken before it)
  const vol = $('#volume'), showVol = () => { const v = +vol.value; $('#volume-val').textContent = v > 0 ? `${(20 * Math.log10(v)).toFixed(0)} dB` : 'off'; };
  const v0 = +store.get('flybrain-volume', '0.5');
  vol.value = Number.isFinite(v0) ? Math.max(0, Math.min(1, v0)) : 0.5; showVol();
  vol.oninput = () => { showVol(); S.mixer?.setVolume(+vol.value); store.set('flybrain-volume', vol.value); };
  // keyboard shortcuts on / off; a mouse click doesn't leave a button focused (its focus would swallow the shortcuts)
  const keys = $('#keys');
  keys.checked = store.get('flybrain-keys', '1') !== '0'; S.keysOn = keys.checked;
  keys.onchange = () => { S.keysOn = keys.checked; store.set('flybrain-keys', keys.checked ? '1' : '0'); };
  // a control used with the mouse hands its focus back, so the single-key shortcuts keep working (keyboard focus stays)
  document.addEventListener('click', (e) => { const b = e.detail > 0 && e.target.closest?.('button'); if (b) b.blur(); });
  document.addEventListener('pointerup', (e) => { const el = e.target.closest?.('input[type=range], input[type=checkbox]'); if (el) setTimeout(() => el.blur(), 0); });
  S.queued = [];
  $('#btn-viz').onclick = () => window.open('viz.html', 'flybrain-viz', 'popup,width=1440,height=860');
  $('#btn-start').onclick = start;
  $('#xfader').oninput = (e) => { S.mixer.setCrossfader(+e.target.value); S.dj.userHold = 8; };
  $('#auto').onchange = (e) => { S.dj.auto = e.target.checked; log(`fly autopilot ${S.dj.auto ? 'on' : 'off'}`); };
  $('#neurons').onchange = (e) => { S.dj.neuronsDecide = e.target.checked; log(e.target.checked ? 'the <b>neurons decide more</b>: exits, track picks and move variants' : 'exits, track picks and move variants follow the designed rules'); };
  $('#ears-room').onchange = (e) => { S.ears.setMode(e.target.checked ? 'room' : 'split'); log(`fly ears: ${e.target.checked ? 'room mix (it hears itself)' : 'split cue, A left / B right'}`); };
  $('#voice-level').oninput = (e) => { S.dj.voiceLevel = +e.target.value; };
  $('#quantize').onchange = (e) => { S.synth.quantize = e.target.checked; };
  $('#mc').onchange = (e) => { if (S.mc) S.mc.enabled = e.target.checked; };
  $('#wind').oninput = (e) => { S.wind = +e.target.value; };
  $('#btn-sugar').onclick = () => { S.feed.sugar = performance.now() + 3000; log('🍬 sugar on the proboscis (sugar gustatory neurons, 3 s)'); };
  $('#btn-bitter').onclick = () => { S.feed.bitter = performance.now() + 3000; log('🍋 bitter taste (bitter gustatory neurons, 3 s)'); };
  $('#btn-reset').onclick = () => { send({ type: 'reset' }); log('brain reset: all membrane potentials back to rest'); };
  // before Start there's no audio context to decode with: hold the files, say so on the splash
  const take = (files) => {
    if (S.started) { addFiles(files); return; }
    S.queued.push(...files);
    $('#splash-msg').textContent = `${S.queued.length} file${S.queued.length > 1 ? 's' : ''} waiting: they go in the crate when you press "Start the fly"`;
  };
  $('#file-in').onchange = (e) => { take([...e.target.files]); e.target.value = ''; };
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dragging');
    take([...e.dataTransfer.files]);
  });
  $('#btn-rec').onclick = toggleRecord;
  $('#btn-export').onclick = exportSet;
  $('#crate-style').onchange = (e) => { S.style = e.target.value; S.crateNext = 0; renderCrate(); scheduleTrim(); log(`crate style → ${S.style}; the fly picks from it at the next track change`); };
  $('#midi-out').onchange = (e) => { if (S.synth) S.synth.midi = S.midiOuts?.get(e.target.value) || null; };
  // MIDI permission is asked only when you go to pick a port, not on every Start
  for (const ev of ['focus', 'pointerdown']) $('#midi-out').addEventListener(ev, initMidi);
}

let midiAsked = false;
async function initMidi() {
  if (midiAsked || !navigator.requestMIDIAccess) return;
  midiAsked = true;
  try {
    const acc = await navigator.requestMIDIAccess();
    S.midiOuts = acc.outputs;
    for (const [id, o] of acc.outputs) { const opt = document.createElement('option'); opt.value = id; opt.textContent = o.name; $('#midi-out').append(opt); }
  } catch (e) { /* MIDI not permitted */ }
}

// markdown set report: style, plan, tracklist with how each track came in, what the fly did, the whole log
function exportSet() {
  if (!S.ctx) return;
  const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const hist = S.history || [];
  const count = (re) => hist.filter((h) => re.test(h.text)).length;
  const lines = [
    `# Fly Brain DJ set — ${new Date().toLocaleString()}`, '',
    `- Length: ${fmtT(S.ctx.currentTime)}`,
    `- Played like: ${S.dj.persona.name}`,
    `- Set plan: ${S.dj.arc ? ARCS[S.dj.arc.key].name : 'free'}`,
    `- Brain: ${S.hello.n_neurons.toLocaleString()} neurons, ${S.hello.n_connections.toLocaleString()} connections (FlyWire v783)`, '',
    '## Tracklist', '',
    ...(S.tracklist || []).map((x, i) => `${i + 1}. \`${fmtT(x.t)}\` **${x.name}** — ${x.bpm.toFixed(1)} BPM${x.key ? ', ' + x.key : ''}  \n   _${x.how}_`), '',
    '## What the fly did', '',
    `| Move | Times |`, `|---|---|`,
    ...[['builds & drops', /build/], ['scratches', /scratch/], ['loop rolls', /loop roll/], ['echo / reverb throws', /→ (echo|reverb|dub)/],
        ['live chops', /live chops/], ['drums out / sing-alongs', /drums out|sing-along/], ['mashups & layers', /mashup|loop layer/],
        ['transitions', /echo out|hard cut|drop-swap|double drop|1-bar kill|spinback cut|long EQ blend/], ['tracks the fly picked', /the fly's pick/],
        ['MC shouts', /on the mic/]].map(([n, re]) => `| ${n} | ${count(re)} |`), '',
    '## Full log', '', '```', ...hist.map((h) => `${fmtT(h.t)}  ${h.text}`), '```', '',
  ];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
  a.download = `fly-brain-set-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  download(a);
  log('📝 set exported: tracklist, move counts and full log');
}

// a blob download, its URL freed once the download has surely started (a recording holds the whole set in memory)
function download(a) {
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10 * 60000);   // (Safari may first ask whether to allow downloads)
}

let rec = null;
function toggleRecord() {
  if (!S.ctx) return;
  if (rec) { rec.stop(); return; }
  const dest = S.ctx.createMediaStreamDestination();
  S.mixer.out.connect(dest);
  const chunks = [];
  rec = new MediaRecorder(dest.stream);
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
    a.download = `fly-brain-set-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${/mp4/.test(rec.mimeType) ? 'm4a' : 'webm'}`;   // Safari records mp4
    download(a);
    S.mixer.out.disconnect(dest); rec = null;
    exportSet();
    $('#btn-rec').textContent = '● Record set'; $('#rec-status').textContent = 'saved';
  };
  rec.start(1000);
  $('#btn-rec').textContent = '■ Stop recording'; $('#rec-status').textContent = 'recording…';
}

window.flyDJ = S;
S.api = { addFiles, loadTrack, loadNext };      // for tools/djbench.mjs
window.renderCrate = () => renderCrate();   // handy for poking at it from the devtools console
bindGlobalUI();
connect();
