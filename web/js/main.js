import { Mixer } from './decks.js';
import { Ears } from './ears.js';
import { FlySynth } from './synth.js';
import { FlyDJ } from './flydj.js';
import { Performer } from './perform.js';
import { STYLES } from './djstyles.js';
import { ARCS, energyAt } from './setplan.js';
import { MC } from './mc.js';
import { BrainView, Raster, drawEar, drawWave } from './viz.js';
import { trackFromFile, renderDemo, demoCount, describeDemo } from './tracks.js';
import { analyzeEnergy } from './analysis.js';
import { renderDesi, desiCount } from './desi.js';

const $ = (s, el = document) => el.querySelector(s);
const S = {
  ws: null, hello: null, ctx: null, mixer: null, ears: null, synth: null, dj: null,
  brainView: null, raster: null, xy: null,
  crate: [], crateNext: 0, style: 'desi', feed: { sugar: 0, bitter: 0 }, wind: 0,
  stats: { spikes: 0, frames: 0, load: 0, t: 0 }, nextGrid: 0, started: false, lastDrive: 0,
};

// ---------------- log ----------------
function log(html) {
  const li = document.createElement('li');
  const t = S.ctx ? S.ctx.currentTime : 0;
  (S.history ||= []).push({ t, text: html.replace(/<[^>]+>/g, '') });
  li.innerHTML = `<span class="t">${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}</span>${html}`;
  const ul = $('#log'); ul.prepend(li);
  while (ul.children.length > 80) ul.lastChild.remove();
}

// ---------------- brain connection ----------------
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
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
  };
}

async function onHello(h) {
  if (S.hello) return;
  S.hello = h;
  const tb = h.trained;
  $('#st-brain').textContent = tb ? `trained brain · ${tb.synapses.toLocaleString()} learned synapses` : 'naive brain';
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
  S.brainView?.addSpikes(f.viz);
  if (!S.started) return;
  S.raster.add(f.out);
  S.dj.onFrame(f.out, S.hello.frame_ms);
  S.synth.addSpikes(f.out, S.ctx.currentTime);
}

function send(obj) { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(obj)); }

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

function pickNext(exclude) {
  for (let k = 0; k < S.crate.length; k++) {
    const t = S.crate[(S.crateNext + k) % S.crate.length];
    if (!exclude.includes(t) && inStyle(t)) { S.crateNext += k + 1; return t; }
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
  const deck = S.mixer.decks[i], other = S.mixer.decks[1 - i];
  deck.load(t);
  startSynced(deck, other);
  S.ears.resetHabit(i);
  t.plays = (t.plays || 0) + 1;
  deck._manualEQ = false; deck.setEQ('low', 0); deck.setEQ('mid', 0); deck.setEQ('high', 0);
  log(`deck ${deck.name} ← "${t.name}" (${t.bpm.toFixed(1)} bpm${other.playing ? ', beat-matched to deck ' + other.name : ''})${why}`);
  renderCrate();
}

// the fly's headphone preview: play a candidate from its drop in the off-air deck (heard only in the cue ear)
function previewTrack(i, t) {
  const deck = S.mixer.decks[i], other = S.mixer.decks[1 - i];
  deck.load(t);
  const drop = t.cues?.find((c) => c.name === 'drop');
  startSynced(deck, other, drop ? t.firstBeat + drop.beat * 60 / t.bpm : t.firstBeat);
  S.ears.resetHabit(i);
  renderCrate();
}

// tracks the fly could play next on deck i: in style, not on a deck, least-played first (crate order breaks ties)
function candidates(i, n) {
  const onDecks = S.mixer.decks.map((d) => d.track);
  const pool = [];
  for (let k = 0; k < S.crate.length; k++) {
    const t = S.crate[(S.crateNext + k) % S.crate.length];
    if (inStyle(t) && !onDecks.includes(t)) pool.push(t);
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
let stemWorker = null, stemJobs = new Map(), stemId = 0;
function separate(t) {
  stemWorker ||= new Worker('js/stems-worker.js');
  stemWorker.onmessage = (e) => {
    const { id, progress, drums, music } = e.data, tr = stemJobs.get(id);
    if (!tr) return;
    if (progress != null) { tr.stemProgress = progress; return; }
    const mk = (chs) => { const b = S.ctx.createBuffer(2, chs[0].length, tr.buffer.sampleRate); b.copyToChannel(chs[0], 0); b.copyToChannel(chs[1], 1); return b; };
    tr.stems = { drums: mk(drums), music: mk(music) };
    tr.stemProgress = null; stemJobs.delete(id);
    log(`stems ready for "${tr.name}": drums and music can now be muted separately`);
    // decks already playing it switch to stems on the next bar, seamlessly
    for (const d of S.mixer.decks) if (d.track === tr && d.playing) { const at = d.nextBarTime(); d.jumpTo(at, d.position(at)); }
    renderCrate();
  };
  const id = ++stemId, b = t.buffer;
  stemJobs.set(id, t); t.stemProgress = 0;
  const L = b.getChannelData(0).slice(), R = (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice();
  stemWorker.postMessage({ id, L, R, sr: b.sampleRate }, [L.buffer, R.buffer]);
}

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('audio') && !/\.(mp3|wav|ogg|flac|m4a|aac|aiff?)$/i.test(f.name)) continue;
    log(`analysing "${f.name}"…`);
    try {
      const t = await trackFromFile(S.ctx, f);
      S.crate.splice(S.crateNext % (S.crate.length + 1), 0, t);   // user tracks play next
      log(`crate + "${t.name}" — ${t.bpm.toFixed(1)} bpm, ${t.key}`);
      separate(t);
      renderCrate();
    } catch (e) { log(`could not decode "${f.name}": ${e.message}`); }
  }
}

// ---------------- start ----------------
async function start() {
  if (!S.hello) { $('#splash-msg').textContent = 'waiting for the brain server… (python -m flybrain.server)'; return; }
  $('#btn-start').disabled = true;
  const ctx = S.ctx = new AudioContext({ latencyHint: 'interactive' });
  const mixer = S.mixer = new Mixer(ctx);
  const bands = S.hello.inputs.filter((c) => c.ear).map((c) => ({ name: c.name, ear: c.ear, lo: c.lo, hi: c.hi }));
  S.bands = bands;
  S.ears = new Ears(ctx, mixer, bands);
  S.synth = new FlySynth(ctx, mixer.master, S.hello.outputs);
  S.perf = new Performer(mixer, S.synth, log);
  S.perf.onActivity = lightPad;
  S.dj = new FlyDJ(mixer, S.ears, S.synth, S.perf, S.hello.outputs, log);
  S.dj.epic = +$('#epic').value;
  S.dj.trained = !!S.hello.trained;
  if (S.hello.trained?.readout) S.dj.setReadout(S.hello.trained.readout, S.hello.outputs);
  if (S.hello.trained) log(`this fly's brain is <b>trained</b>: ${S.hello.trained.synapses.toLocaleString()} synapses learned when a DJ builds, leaves space, mixes and peaks`);
  S.mc = S.dj.mc = new MC(log);
  S.mc.enabled = $('#mc').checked;
  // the MC hypes builds: "are you ready?" halfway, the shout lands on the drop
  S.perf.buildKind = buildKind;
  S.perf.onBuild = (T0, Td) => {
    const now = S.ctx.currentTime;
    S.dj.shout('ready', Math.max(0, (T0 + Td) / 2 - now));
    setTimeout(() => { S.mc.last = -1e9; S.dj.shout('hype'); }, Math.max(0, (Td - now) * 1000));
  };
  S.dj.onLoadNext = loadNext;
  S.dj.onArrive = (deck, { snap, at }) => {
    if (!S.tempo || !$('#follow').checked || !deck.track) return;
    const bpm = styleTempo(deck.track.bpm);
    if (Math.abs(bpm / S.tempo.base - 1) < 0.005) return;
    if (snap) {
      // tempo jumps with the cut, on the beat the new track lands
      setTimeout(() => { S.tempo.base = S.tempo.cur = bpm; S.tempo.glideTo = null; log(`tempo → ${bpm.toFixed(1)} BPM with the cut ("${deck.track.name}")`); },
        Math.max(0, (at - S.ctx.currentTime) * 1000));
    } else {
      S.tempo.glideTo = bpm;
      log(`tempo journey → drifting toward ${bpm.toFixed(1)} BPM ("${deck.track.name}")`);
    }
  };
  S.dj.picker = { candidates, preview: previewTrack, choose: (i, t, why) => loadTrack(i, t, why) };
  mixer.decks.forEach((d, i) => { d.onEnded = () => { log(`deck ${d.name} track ended`); if (mixer.airness(d) > 0.5) loadNext(i); }; });
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
  loadNext(0);
  loadNext(1);
  log('the fly is listening: left ear on deck A, right ear on deck B');
  renderCrate();
  setInterval(control, 25);
  requestAnimationFrame(anim);
  initMidi();
  for (const job of jobs) { S.crate.push(await job()); renderCrate(); }
}

// ---------------- control loop (40 Hz) ----------------
let lastCtl = performance.now();
function control() {
  const now = performance.now(), dt = Math.min(0.2, (now - lastCtl) / 1000); lastCtl = now;
  const lv = { ...S.ears.update(dt) };
  lv.sugar = now < S.feed.sugar ? 1 : 0;
  lv.bitter = now < S.feed.bitter ? 1 : 0;
  lv.wind = S.wind;
  send({ type: 'drive', levels: lv });
  S.levels = lv;
  S.dj.tick(dt);

  // master tempo (your setting + the fly's ride), glided so changes sound like riding the pitch fader
  if (S.tempo) {
    if (S.tempo.glideTo) {                     // tempo journey toward the on-air track's own BPM (~20 s)
      S.tempo.base += (S.tempo.glideTo - S.tempo.base) * Math.min(1, dt / 20);
      if (Math.abs(S.tempo.glideTo - S.tempo.base) < 0.05) { S.tempo.base = S.tempo.glideTo; S.tempo.glideTo = null; }
    }
    const ride = S.dj.auto && $('#ride').checked ? S.dj.tempoOffset : 0;
    const target = S.tempo.base * (1 + ride);
    S.tempo.cur += (target - S.tempo.cur) * Math.min(1, dt / 0.6);
    if (Math.abs(S.tempo.cur - S.tempo.applied) > 0.02) { S.mixer.applyTempo(S.tempo.cur); S.tempo.applied = S.tempo.cur; }
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
    // fix a wrong tempo detection: rescale the beat grid (the first beat stays put)
    const rescale = (f) => {
      const t = d.track; if (!t) return;
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
  $('#beats').querySelectorAll('button').forEach((b) => b.onclick = () => {
    $('#beats').querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel'); S.fxBeats = +b.dataset.b;
  });
  $('#epic').oninput = (e) => { S.dj.epic = +e.target.value; };
  // "play like" DJ styles
  const sel = $('#persona');
  for (const [k, st] of Object.entries(STYLES)) { const o = document.createElement('option'); o.value = k; o.textContent = st.name; sel.append(o); }
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
  for (const [k, a] of Object.entries(ARCS)) { const o = document.createElement('option'); o.value = k; o.textContent = a.name; $('#arc').append(o); }
  $('#set-start').onclick = () => {
    const k = $('#arc').value, min = +$('#set-len').value;
    S.dj.startSet(k, min); S.arcHistory = [];
    log(k === 'free' ? '📋 set plan off — the fly plays freely' : `📋 set plan: <b>${ARCS[k].name}</b>, ${min} minutes — epicness, track choice, tempo, builds and breakdowns follow the arc`);
  };
  $('#persona-tag').textContent = STYLES.fly.tagline;
  // tempo
  const setBase = (b) => { if (!S.tempo) return; S.tempo.base = Math.max(70, Math.min(180, b)); S.tempo.glideTo = null; };
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
  const cueKeys = { 1: [0, 0], 2: [0, 1], 3: [0, 2], 4: [0, 3], 7: [1, 0], 8: [1, 1], 9: [1, 2], 0: [1, 3] };
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k in cueKeys && S.started) { const [d, c] = cueKeys[k]; S.perf.hotCue(S.mixer.decks[d], c); return; }
    if ((k === '-' || k === '=') && S.tempo) { S.tempo.base += (k === '=' ? 1 : -1) * (e.shiftKey ? 0.1 : 1); S.tempo.glideTo = null; return; }
    const act = keyMap[k];
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

function bindGlobalUI() {
  $('#btn-start').onclick = start;
  $('#xfader').oninput = (e) => { S.mixer.setCrossfader(+e.target.value); S.dj.userHold = 8; };
  $('#auto').onchange = (e) => { S.dj.auto = e.target.checked; log(`fly autopilot ${S.dj.auto ? 'on' : 'off'}`); };
  $('#ears-room').onchange = (e) => { S.ears.setMode(e.target.checked ? 'room' : 'split'); log(`fly ears: ${e.target.checked ? 'room mix (it hears itself)' : 'split cue, A left / B right'}`); };
  $('#voice-level').oninput = (e) => { S.dj.voiceLevel = +e.target.value; };
  $('#quantize').onchange = (e) => { S.synth.quantize = e.target.checked; };
  $('#mc').onchange = (e) => { if (S.mc) S.mc.enabled = e.target.checked; };
  $('#wind').oninput = (e) => { S.wind = +e.target.value; };
  $('#btn-sugar').onclick = () => { S.feed.sugar = performance.now() + 3000; log('🍬 sugar on the proboscis (sugar gustatory neurons, 3 s)'); };
  $('#btn-bitter').onclick = () => { S.feed.bitter = performance.now() + 3000; log('🍋 bitter taste (bitter gustatory neurons, 3 s)'); };
  $('#btn-reset').onclick = () => { send({ type: 'reset' }); log('brain reset: all membrane potentials back to rest'); };
  $('#file-in').onchange = (e) => S.ctx && addFiles(e.target.files);
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dragging');
    if (S.ctx) addFiles(e.dataTransfer.files); else log('press "Start the fly" first, then drop tracks');
  });
  $('#btn-rec').onclick = toggleRecord;
  $('#btn-export').onclick = exportSet;
  $('#crate-style').onchange = (e) => { S.style = e.target.value; S.crateNext = 0; renderCrate(); log(`crate style → ${S.style}; the fly picks from it at the next track change`); };
  $('#midi-out').onchange = (e) => { S.synth.midi = S.midiOuts?.get(e.target.value) || null; };
}

async function initMidi() {
  if (!navigator.requestMIDIAccess) return;
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
  a.click();
  log('📝 set exported: tracklist, move counts and full log');
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
    a.download = `fly-brain-set-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm`;
    a.click();
    S.mixer.out.disconnect(dest); rec = null;
    exportSet();
    $('#btn-rec').textContent = '● Record set'; $('#rec-status').textContent = 'saved';
  };
  rec.start(1000);
  $('#btn-rec').textContent = '■ Stop recording'; $('#rec-status').textContent = 'recording…';
}

window.flyDJ = S;
window.renderCrate = () => renderCrate();   // handy for poking at it from the devtools console
bindGlobalUI();
connect();
