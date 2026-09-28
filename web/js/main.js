import { Mixer } from './decks.js';
import { Ears } from './ears.js';
import { FlySynth } from './synth.js';
import { FlyDJ } from './flydj.js';
import { Performer } from './perform.js';
import { BrainView, Raster, drawEar, drawWave } from './viz.js';
import { trackFromFile, renderDemo, demoCount } from './tracks.js';
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
  S.crate.forEach((t, i) => {
    const li = document.createElement('li');
    if (!inStyle(t)) li.style.opacity = 0.35;
    if (A?.track === t) li.className = 'a'; else if (B?.track === t) li.className = 'b';
    li.innerHTML = `${t.name} <span class="meta">${t.bpm.toFixed(1)} bpm${t.key ? ' · ' + t.key : ''}${i === S.crateNext % S.crate.length ? ' · next' : ''}</span>`;
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
  deck.load(t);
  startSynced(deck, other);
  S.ears.resetHabit(i);
  deck._manualEQ = false; deck.setEQ('low', 0); deck.setEQ('mid', 0); deck.setEQ('high', 0);
  log(`deck ${deck.name} ← "${t.name}" (${t.bpm.toFixed(1)} bpm${other.playing ? ', beat-matched to deck ' + other.name : ''})`);
  renderCrate();
}

function startSynced(deck, other) {
  const t = deck.track;
  if (other.playing && other.track) {
    let r = other.bpm / t.bpm;
    if (r > 1.45) r /= 2; else if (r < 0.7) r *= 2;
    deck.rate = Math.min(1.12, Math.max(0.88, r));
    const b = other.beatAt(S.ctx.currentTime + 0.15);
    const bar = Math.ceil(b / 4) * 4;
    deck.play(other.timeOfBeat(bar), t.firstBeat);
  } else {
    deck.rate = 1;
    deck.play(S.ctx.currentTime + 0.05, deck.anchorPos || t.firstBeat);
  }
}

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('audio') && !/\.(mp3|wav|ogg|flac|m4a|aac|aiff?)$/i.test(f.name)) continue;
    log(`analysing "${f.name}"…`);
    try {
      const t = await trackFromFile(S.ctx, f);
      S.crate.splice(S.crateNext % (S.crate.length + 1), 0, t);   // user tracks play next
      log(`crate + "${t.name}" (${t.bpm.toFixed(1)} bpm detected)`);
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
  S.dj.onLoadNext = loadNext;
  mixer.decks.forEach((d, i) => { d.onEnded = () => { log(`deck ${d.name} track ended`); if (mixer.airness(d) > 0.5) loadNext(i); }; });
  buildMoves();
  bindDeckUI();
  bindPerformance();

  $('#splash-msg').textContent = 'rendering demo tracks…';
  S.style = $('#crate-style').value;
  const jobs = [...Array(desiCount).keys()].map((i) => () => renderDesi(i))
    .concat([...Array(demoCount).keys()].map((i) => () => renderDemo(i)));
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

  // follow the on-air deck's tempo and key
  const on = S.mixer.onAir();
  if (on.playing && on.track) {
    S.mixer.setTempo(on.bpm);
    const sel = $('#scale').value;
    if (sel === 'auto') S.synth.setKey(on.track.root ?? 45, on.track.scale === 'minor' ? 'minpent' : (on.track.scale || 'minpent'));
    else S.synth.setKey(on.track.root ?? 45, sel);
    const style = on.track.style === 'desi' ? 'desi' : (on.track.style === 'club' ? 'club' : (S.style === 'desi' ? 'desi' : 'club'));
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
    for (const band of ['high', 'mid', 'low']) {
      const inp = $(`.eq-${band}`, root);
      inp.oninput = () => { d._manualEQ = true; d.setEQ(band, +inp.value); };
      inp.ondblclick = () => { inp.value = 0; d.setEQ(band, 0); d._manualEQ = false; };
      d.ui[band] = inp;
    }
    root.querySelectorAll('.cue').forEach((b) => { b.onclick = () => S.perf.hotCue(d, +b.dataset.cue); });
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
  else if (kind === 'build') P.buildDrop({ bars: shift ? 8 : +arg });
  else if (kind === 'dropswap') P.dropSwap('you') || log('drop swap needs both decks playing');
  else if (kind === 'echoout') { if (P.echoOut('you')) S.dj.afterCut(); }
  else if (kind === 'spincut') { if (P.spinCut('you')) S.dj.afterCut(); }
  else if (kind === 'brake') P.brake('you');
  else if (kind === 'backspin') P.backspin('you');
  else if (kind === 'jump') P.beatJump(+arg);
  else if (kind === 'sample') P.sample(arg, 'you');
}
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
  const cueKeys = { 1: [0, 0], 2: [0, 1], 3: [0, 2], 4: [0, 3], 7: [1, 0], 8: [1, 1], 9: [1, 2], 0: [1, 3] };
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k in cueKeys && S.started) { const [d, c] = cueKeys[k]; S.perf.hotCue(S.mixer.decks[d], c); return; }
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
    setText(d.ui.name, d.track ? d.track.name : '—');
    setText(d.ui.bpm, d.track ? `${d.bpm.toFixed(1)} BPM${d.rate !== 1 ? ` (${((d.rate - 1) * 100).toFixed(1)}%)` : ''}` : '— BPM');
    setText(d.ui.time, d.track ? `${fmt(Math.max(0, d.position()))} / ${fmt(d.duration)}` : '0:00');
    setStyle(d.ui.habit, 'width', `${(S.ears.habit[i] * 100).toFixed(0)}%`);
    setText(d.ui.play, d.playing ? '■' : '▶');
    d.ui.root.classList.toggle('onair', mx.airness(d) > 0.5);
    if (!d._manualFilter && document.activeElement !== d.ui.filter) d.ui.filter.value = d.filterVal;
    if (!d._manualEQ) d.ui.low.value = d.eqVals.low;
  });
  for (const n of ['sweep', 'lpf', 'trans', 'crush', 'flanger', 'reverb']) if (mx.fx.isActive(n)) lightPad(n);
  if (document.activeElement !== $('#xfader')) $('#xfader').value = mx.x;
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

function bindGlobalUI() {
  $('#btn-start').onclick = start;
  $('#xfader').oninput = (e) => { S.mixer.setCrossfader(+e.target.value); S.dj.userHold = 8; };
  $('#auto').onchange = (e) => { S.dj.auto = e.target.checked; log(`fly autopilot ${S.dj.auto ? 'on' : 'off'}`); };
  $('#ears-room').onchange = (e) => { S.ears.setMode(e.target.checked ? 'room' : 'split'); log(`fly ears: ${e.target.checked ? 'room mix (it hears itself)' : 'split cue, A left / B right'}`); };
  $('#voice-level').oninput = (e) => { S.dj.voiceLevel = +e.target.value; };
  $('#quantize').onchange = (e) => { S.synth.quantize = e.target.checked; };
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
    $('#btn-rec').textContent = '● Record set'; $('#rec-status').textContent = 'saved';
  };
  rec.start(1000);
  $('#btn-rec').textContent = '■ Stop recording'; $('#rec-status').textContent = 'recording…';
}

window.flyDJ = S;   // handy for poking at it from the devtools console
bindGlobalUI();
connect();
