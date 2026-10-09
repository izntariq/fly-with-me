// Fly Brain DJ — visualiser (viz.html).
//
// The flies' brains in 3D at their real FlyWire positions (138,639 neurons each), every spike lit as it happens:
//   three flies   the two listener flies (top; each hears one deck) stream their descending-neuron spikes into the
//                 DJ fly's ears (bottom, large): the same taps the server wires into its left / right ear bands
//   two / one     the listener flies side by side / the single fly
//
// The picture plays along with the DJ. Every move starts an effect of its own, on the beat: echo throws leave ghost
// brains behind, reverb blooms, flangers and filters sweep the colours, rolls and stutters loop the spikes, scratches
// jerk the brain back and forth, a tape stop freezes time, a build pushes the camera in until the drop explodes,
// transitions swing the light from one listener fly to the other, and the sampler fires horns, sirens, lasers, CO2.
//
// It's interactive: drag to turn the brains, scroll to zoom, double-click to reset. Hover a neuron to see what it is and
// which move it drives; click it to stimulate its cell type in that fly (real Poisson drive in the running model); if the
// burst is strong enough the DJ fly answers with the move.
//
// A small side panel shows the move being made and the neurons whose burst fired it (they ring in the brain, with a line
// from the card), the queued transition, the drop countdown and the recent moves.
//
// Safe mode (photosensitivity): several looks gate, strobe or invert the picture on the 16th note (8-10 Hz, inside the
// 3-30 Hz range that can trigger seizures). The page opens behind a warning; safe mode is the default when the system
// asks for reduced motion, and S or the panel button switches it. In safe mode one pass after the looks (soften) lets
// no light or colour change faster than ~0.5 Hz and drops invert, shake and slices: see SAFE below.
//
// Brain activity: the brain server's websocket (the frames the DJ app gets); pokes go back the same way.
// Moves, decks, beat: the DJ app, over BroadcastChannel('flybrain-dj') (web/js/main.js: hookVisualiser, postState).
import { MOVES } from './flydj.js';

const $ = (s) => document.querySelector(s);
const clock = () => performance.now() / 1000;                        // this page's clock, seconds
const fromAbs = (ms) => (ms - performance.timeOrigin) / 1000;        // shared epoch ms -> this page's clock
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeHTML = (html) => esc(String(html).replace(/<(?!\/?b>)[^>]*>/g, '')).replace(/&lt;(\/?)b&gt;/g, '<$1b>');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const TAU = Math.PI * 2;
const DECK = ['#35e0c2', '#ff5ca8'];

// neuron super-classes (flybrain/mapping.py SUPER_CLASSES + 1; 0 = unknown): colour + how brightly the cloud shows it
const CLASS = [
  [0.55, 0.58, 0.68, 0.10],   // unknown
  [0.26, 0.40, 0.98, 0.10],   // optic lobes
  [0.66, 0.46, 1.00, 0.22],   // central brain
  [0.20, 0.95, 0.80, 0.34],   // sensory (the ears: Johnston's organ)
  [0.30, 0.66, 1.00, 0.16],   // visual projection
  [0.80, 1.00, 0.38, 0.34],   // ascending
  [1.00, 0.32, 0.85, 0.60],   // descending: the DJ's hands
  [0.35, 1.00, 0.62, 0.34],   // sensory ascending
  [0.38, 0.58, 1.00, 0.16],   // visual centrifugal
  [1.00, 0.72, 0.30, 0.80],   // motor
  [1.00, 0.40, 0.40, 0.50],   // endocrine
  [0.40, 0.75, 0.95, 0.16],   // nerve cord (male CNS)
  [1.00, 0.52, 0.20, 0.80],   // leg / wing motor neurons (male CNS)
];

// ---------------- what the moves are called ----------------
const FAM = { fx: '#4cc3ff', rhythm: '#c8ff5a', scratch: '#ffb347', sampler: '#fff36b', build: '#ff5a5a', big: '#b36bff', transition: '#ff4fd8' };
const FXN = { echo: 'Echo throw', reverb: 'Reverb throw', flanger: 'Flanger', trans: 'Trans gate', crush: 'Bitcrush', lpf: 'Low-pass dip', sweep: 'High-pass sweep' };
const SAMPLE = { horn: 'Air horn', siren: 'Siren', laser: 'Laser', boom: 'Boom', riser: 'Riser', dhol: 'Dhol roll', co2: 'CO₂ blast' };
const ROLL = { 0.25: '¼', 0.125: '⅛', 0.0625: '1/16' };
const NAMED = {
  brake: ['Tape stop', 'rhythm'], backspin: ['Spinback', 'rhythm'], stutter: ['Stutter', 'rhythm'], reverse: ['Reverse', 'rhythm'],
  fill: ['Snare fill', 'rhythm'], chop: ['Live chops', 'big'], mashup: ['Mashup', 'big'], layer: ['Loop layer', 'big'],
  drumsOut: ['Drums out', 'big'], melodyOut: ['Strip to drums', 'big'], bassTease: ['Bass tease', 'big'], singalong: ['Sing-along', 'big'],
  acid: ['303 acid line', 'big'], dub: ['Dub throw', 'fx'], resFilter: ['Resonant filter', 'fx'], pump: ['Sidechain pump', 'fx'],
  doubleDrop: ['Double drop', 'transition'], killDrop: ['1-bar kill', 'transition'], hardCut: ['Hard cut', 'transition'],
  echoOut: ['Echo out', 'transition'], dropSwap: ['Drop swap', 'transition'], spinCut: ['Spinback cut', 'transition'],
};
function describe(ev) {
  const a = ev.arg;
  if (ev.act === 'beatFx') return [FXN[a] || String(a), 'fx'];
  if (ev.act === 'roll') return [`Loop roll ${ROLL[a] || ''}`.trim(), 'rhythm'];
  if (ev.act === 'scratch') return [`${String(a || 'baby').replace(/^./, (c) => c.toUpperCase())} scratch`, 'scratch'];
  if (ev.act === 'sample') return [SAMPLE[a] || String(a), 'sampler'];
  if (ev.act === 'buildDrop') return [a ? `Build & drop · ${a} bars` : 'Build & drop', 'build'];
  if (ev.act === 'blend') return [`EQ blend → deck ${a}`, 'transition'];
  return NAMED[ev.act] || [ev.act, 'big'];
}
const WHY = { drop: 'giant fiber most excited', echo: 'echo neurons most excited', spin: 'aversion neurons most excited',
  cut: 'rhythm neurons most excited', double: 'whole brain aroused', kill: 'flanger neurons most excited', blend: 'a calm fly' };
const STYLE_NAME = { drop: 'Drop swap', echo: 'Echo out', spin: 'Spinback cut', cut: 'Hard cut', double: 'Double drop', kill: '1-bar kill', blend: 'EQ blend' };

// ---------------- state ----------------
const V = {
  hello: null, n: 0, pos: null, flies: 1, ws: null, state: null, stateAt: -1e9, performer: 0,
  moves: [], cur: null, logs: [], rate: 0, load: 0, groupCache: new Map(),
  hl: null, fx: [], waves: [], lasers: [], confetti: [], titles: [], panel: true,
  earC: null, tapSlot: null, rot: null, L: [], X: null, rotPhase: 0, lastT: clock(),
  user: { yaw: 0, pitch: 0, zoom: 1 }, hover: null, pokes: [], openedAt: clock(),
  safe: false, soft: null, warn: true,
};

// ---------------- safe mode ----------------
// The choice is remembered ('flash' or 'safe'); no choice yet -> the warning shows and nothing is drawn until it's
// answered (its default button follows prefers-reduced-motion). Storage can throw (private windows): then just ask.
const SAFE_KEY = 'flybrain-viz-motion';
const reducedMotion = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
const stored = (() => { try { return localStorage.getItem(SAFE_KEY); } catch { return null; } })();
function setSafe(on, remember = true) {
  V.safe = !!on; V.soft = null;
  if (remember) try { localStorage.setItem(SAFE_KEY, on ? 'safe' : 'flash'); } catch { /* not remembered */ }
  const b = $('#safe');
  if (b) { b.textContent = `safe mode: ${on ? 'on' : 'off'}`; b.setAttribute('aria-pressed', String(!!on)); }
}
function answerWarning(safe) { setSafe(safe); V.warn = false; $('#warn').hidden = true; glc.focus?.(); }
if (stored === 'safe' || stored === 'flash') { setSafe(stored === 'safe', false); V.warn = false; $('#warn').hidden = true; }
else {
  setSafe(reducedMotion, false);
  if (reducedMotion) $('#warn-rm').hidden = false;
  $('#warn-flash').onclick = () => answerWarning(false);
  $('#warn-safe').onclick = () => answerWarning(true);
  (reducedMotion ? $('#warn-safe') : $('#warn-flash')).focus();
}
$('#safe').onclick = () => setSafe(!V.safe);
// One pass over the look X after every effect has run, so no effect can get past it. Light and colour (gate,
// brightness, saturation, size, cloud, wash, tint) and the camera (zoom, nudges, yaw) go through a one-pole low-pass
// (time constant SAFE.tau: a 16th-note gate at 8.5 Hz keeps ~3% ripple, a 3 Hz flicker ~1/6 of its depth; a step takes
// ~0.7 s to rise), with the boosts capped; invert, shake and slices are dropped and the beat breathing is scaled down.
const SAFE = { tau: 0.3, keys: ['gate', 'bright', 'sat', 'size', 'cloud', 'tintK', 'zoom', 'dx', 'dy', 'yaw'],
  bright: [0.3, 1.4], size: 1.8, wash: 0.1, beat: 0.35, laser: 0.3 };
function soften(X, dt) {
  if (!V.safe) return X;
  X.bright = Math.min(SAFE.bright[1], Math.max(SAFE.bright[0], X.bright)); X.size = Math.min(SAFE.size, X.size);
  X.wash = X.wash.map((v) => Math.min(SAFE.wash, v));
  X.invert = 0; X.shake = 0; X.slice = 0; X.beat *= SAFE.beat;
  const S = V.soft || (V.soft = { ...X, wash: [...X.wash], tint: [...X.tint] }), a = 1 - Math.exp(-dt / SAFE.tau);
  for (const k of SAFE.keys) X[k] = S[k] += (X[k] - S[k]) * a;
  for (const k of ['wash', 'tint']) X[k] = S[k] = S[k].map((v, i) => v + (X[k][i] - v) * a);
  return X;
}

// ---------------- WebGL ----------------
const glc = $('#gl'), hudc = $('#hud'), hud = hudc.getContext('2d');
const gl = glc.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
const COMMON = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D u_pos;
uniform mat3 u_rot;
uniform vec3 u_fly[3];          // centre (NDC) and scale of each fly
uniform float u_aspect;         // height / width
uniform vec4 u_cls[13];
uniform float u_pixel;          // bitcrush: snap positions to a grid
uniform vec2 u_wob;             // acid / sing-along: wave (amount, phase)
uniform vec3 u_slice;           // live chops: (amount, seed, bands)
const vec4 OFF = vec4(2.0, 2.0, 2.0, 1.0);
float hash(float n) { return fract(sin(n) * 43758.5453); }
vec4 neuron(int i) { return texelFetch(u_pos, ivec2(i & 1023, i >> 10), 0); }
vec2 place(vec3 p, int f, out float persp) {
  vec3 q = u_rot * p;
  if (u_wob.x > 0.0) q.y += u_wob.x * sin(q.x * 6.0 + u_wob.y);
  if (u_slice.x > 0.0) q.x += u_slice.x * (hash(floor((q.y + 1.0) * u_slice.z) * 12.9898 + u_slice.y) - 0.5);
  if (u_pixel > 0.0) q.xy = floor(q.xy / u_pixel + 0.5) * u_pixel;
  persp = 1.0 / (1.0 + q.z * 0.3);
  vec3 fl = u_fly[f];
  return fl.xy + q.xy * fl.z * persp * vec2(u_aspect, 1.0);
}
`;
const DOT = `#version 300 es
precision highp float; in vec3 v_c; out vec4 o;
void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard; o = vec4(v_c * exp(-r * 3.2), 1.0); }`;
const SRC = {
  bg: [`#version 300 es
    out vec2 v_p;
    void main() { v_p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0; gl_Position = vec4(v_p, 0.0, 1.0); }`,
  `#version 300 es
    precision highp float;
    in vec2 v_p; out vec4 o;
    uniform vec3 u_flash; uniform vec2 u_c; uniform float u_aspect; uniform float u_beat;
    void main() {
      vec2 d = (v_p - u_c) * vec2(1.0 / u_aspect, 1.0);
      float r = dot(d, d);
      vec3 base = vec3(0.012, 0.016, 0.03) + vec3(0.02, 0.022, 0.05) * exp(-r * 0.9) * (1.0 + 0.8 * u_beat);
      o = vec4(base + u_flash * exp(-r * 0.8), 1.0);
    }`],
  cloud: [COMMON + `
    uniform int u_f; uniform float u_px; uniform float u_gain;
    out vec3 v_c;
    void main() {
      vec4 p = neuron(gl_VertexID);
      if (p.w < 0.0) { gl_Position = OFF; gl_PointSize = 0.0; return; }
      float s; vec2 xy = place(p.xyz, u_f, s);
      gl_Position = vec4(xy, 0.0, 1.0);
      gl_PointSize = u_px;
      vec4 c = u_cls[int(p.w)];
      v_c = c.rgb * c.a * u_gain * s * s;
    }`,
  `#version 300 es
    precision highp float; in vec3 v_c; out vec4 o;
    void main() { o = vec4(v_c, 1.0); }`],
  spike: [COMMON + `
    layout(location = 0) in float a_idx; layout(location = 1) in float a_t; layout(location = 2) in float a_f;
    uniform float u_now; uniform float u_life; uniform vec3 u_spx; uniform vec3 u_fgain; uniform float u_gain; uniform float u_rise;
    out vec3 v_c;
    void main() {
      float age = u_now - a_t;
      if (a_idx < 0.0 || age < 0.0 || age > u_life) { gl_Position = OFF; gl_PointSize = 0.0; return; }
      vec4 p = neuron(int(a_idx));
      if (p.w < 0.0) { gl_Position = OFF; gl_PointSize = 0.0; return; }
      int f = int(a_f);
      float s; vec2 xy = place(p.xyz, f, s);
      xy.y += u_rise * age;
      gl_Position = vec4(xy, 0.0, 1.0);
      float hot = exp(-age * 20.0);
      gl_PointSize = u_spx[f] * s * (0.55 + 1.2 * hot);
      v_c = mix(u_cls[int(p.w)].rgb, vec3(1.0), 0.5 * hot) * exp(-age * 5.0 / max(1.0, u_life / 0.9)) * u_gain * u_fgain[f];
    }`, DOT],
  part: [COMMON + `
    layout(location = 0) in float a_idx; layout(location = 1) in float a_t; layout(location = 2) in float a_f;
    uniform float u_now; uniform float u_travel; uniform vec3 u_ear[2]; uniform float u_ppx; uniform vec3 u_deck[2];
    out vec3 v_c;
    void main() {
      float lag = float(gl_InstanceID) * 0.022;
      float k = (u_now - a_t - lag) / u_travel;
      if (a_idx < 0.0 || k < 0.0 || k > 1.0) { gl_Position = OFF; gl_PointSize = 0.0; return; }
      int side = int(a_f);
      vec4 src = neuron(int(a_idx));
      if (src.w < 0.0) { gl_Position = OFF; gl_PointSize = 0.0; return; }
      float s0, s1;
      vec2 A = place(src.xyz, side, s0);
      vec2 B = place(u_ear[side], 2, s1);
      vec2 d = B - A, C = (A + B) * 0.5 + vec2(-d.y, d.x) * (side == 0 ? 0.28 : -0.28);
      float t = k * k * (3.0 - 2.0 * k);
      gl_Position = vec4(mix(mix(A, C, t), mix(C, B, t), t), 0.0, 1.0);
      float tail = 1.0 - float(gl_InstanceID) / 7.0;
      gl_PointSize = u_ppx * tail * (0.6 + 0.7 * sin(3.1416 * k));
      v_c = u_deck[side] * tail * sin(3.1416 * min(1.0, k * 1.15));
    }`, DOT],
  ring: [COMMON + `
    layout(location = 0) in float a_idx; layout(location = 1) in float a_t; layout(location = 2) in float a_f; layout(location = 3) in vec3 a_c;
    uniform float u_now; uniform float u_hlife; uniform vec3 u_spx;
    out vec3 v_c;
    void main() {
      float age = u_now - a_t, k = age / u_hlife;
      if (a_idx < 0.0 || k < 0.0 || k > 1.0) { gl_Position = OFF; gl_PointSize = 0.0; return; }
      int f = int(a_f);
      vec4 p = neuron(int(a_idx));
      if (p.w < 0.0) { gl_Position = OFF; gl_PointSize = 0.0; return; }
      float s; vec2 xy = place(p.xyz, f, s);
      gl_Position = vec4(xy, 0.0, 1.0);
      gl_PointSize = u_spx[f] * s * (2.4 + 3.0 * k);
      v_c = a_c * (1.0 - k) * (0.65 + 0.35 * cos(age * 16.0));
    }`,
  `#version 300 es
    precision highp float; in vec3 v_c; out vec4 o;
    void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
      float ring = smoothstep(0.5, 0.72, r) * (1.0 - smoothstep(0.82, 1.0, r)); o = vec4(v_c * (ring + 0.25 * exp(-r * r * 12.0)), 1.0); }`],
};

function program([vs, fs]) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i), name = u.name.replace(/\[0\]$/, ''); loc[name] = gl.getUniformLocation(p, u.name); }
  return { p, loc };
}

// a ring buffer of point records on the GPU; only what was written since the last draw is uploaded
class Ring {
  constructor(cap, sizes) {
    this.cap = cap; this.stride = sizes.reduce((a, b) => a + b, 0);
    this.data = new Float32Array(cap * this.stride).fill(-1);
    this.head = 0; this.lo = -1; this.n = 0;
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW);
    let off = 0;
    sizes.forEach((sz, i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, sz, gl.FLOAT, false, this.stride * 4, off * 4); off += sz; });
    gl.bindVertexArray(null);
  }
  push(...v) {
    const o = this.head * this.stride;
    for (let i = 0; i < this.stride; i++) this.data[o + i] = v[i];
    if (this.lo < 0) this.lo = this.head;
    this.n++; this.head = (this.head + 1) % this.cap;
  }
  upload() {
    if (!this.n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const S = this.stride, sub = (a, b) => gl.bufferSubData(gl.ARRAY_BUFFER, a * S * 4, this.data, a * S, (b - a) * S);
    if (this.n >= this.cap) sub(0, this.cap);
    else if (this.lo + this.n <= this.cap) sub(this.lo, this.lo + this.n);
    else { sub(this.lo, this.cap); sub(0, this.lo + this.n - this.cap); }
    this.lo = -1; this.n = 0;
  }
}

let P, spikes, parts, rings, emptyVao, posTex;
function initGL() {
  if (!gl) throw new Error('this browser has no WebGL2');
  P = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, program(v)]));
  spikes = new Ring(1 << 18, [1, 1, 1]);
  parts = new Ring(1 << 13, [1, 1, 1]);
  rings = new Ring(1 << 13, [1, 1, 1, 3]);
  emptyVao = gl.createVertexArray();
}

// neuron positions: brain_xyz.bin = 4 x uint16 per neuron (x, y, z on one scale; class). Centred, x in [-1, 1],
// y up (dorsal), and the fly's left on screen left (we look at the brain from behind, over the DJ's shoulder).
function loadPositions(buf) {
  const q = new Uint16Array(buf), n = q.length / 4;
  const lo = [65535, 65535, 65535], hi = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (!q[4 * i] && !q[4 * i + 1] && !q[4 * i + 2]) continue;
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[4 * i + a]); hi[a] = Math.max(hi[a], q[4 * i + a]); }
  }
  const c = lo.map((v, a) => (v + hi[a]) / 2), half = Math.max(...hi.map((v, a) => v - lo[a])) / 2;
  const TW = 1024, TH = Math.ceil(n / TW), pos = new Float32Array(TW * TH * 4).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!q[4 * i] && !q[4 * i + 1] && !q[4 * i + 2]) continue;
    pos[4 * i] = (q[4 * i] - c[0]) / half;
    pos[4 * i + 1] = -(q[4 * i + 1] - c[1]) / half;
    pos[4 * i + 2] = -(q[4 * i + 2] - c[2]) / half;
    pos[4 * i + 3] = q[4 * i + 3];
  }
  // how far the shape reaches from its centre (the FlyWire brain is wide, the whole male CNS tall)
  V.ext = { x: 0, y: 0 };
  for (let i = 0; i < n; i++) if (pos[4 * i + 3] >= 0) { V.ext.x = Math.max(V.ext.x, Math.abs(pos[4 * i])); V.ext.y = Math.max(V.ext.y, Math.abs(pos[4 * i + 1])); }
  posTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, posTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TW, TH, 0, gl.RGBA, gl.FLOAT, pos);
  V.n = n; V.pos = pos;
}
const centroid = (idx) => {
  const c = [0, 0, 0]; let k = 0;
  for (const i of idx) { if (V.pos[4 * i + 3] < 0) continue; c[0] += V.pos[4 * i]; c[1] += V.pos[4 * i + 1]; c[2] += V.pos[4 * i + 2]; k++; }
  return k ? c.map((v) => v / k) : [0, 0, 0];
};

// ---------------- the beat ----------------
function beatInfo(t) {
  const b = V.state?.beat, live = b && t - V.stateAt < 2, spb = live ? b.spb : 0.5;
  const x = live ? b.n + (t - fromAbs(b.at)) / spb : t / spb;          // position in beats
  const n = Math.floor(x), phase = x - n, env = live ? Math.exp(-phase * 6) : 0;
  const sub = (d) => (((x * d) % 1) + 1) % 1;                           // position inside a 1/d-beat step
  return { x, n, phase, env, down: ((n % 4) + 4) % 4 === 0 ? env : 0, spb, sub, live };
}
const nextGrid = (t, B, beats = 1) => t + (Math.ceil(B.x / beats - 1e-6) * beats - B.x) * B.spb;

// ---------------- move effects ----------------
// Each move adds effects (kind, t0..t1, colour); every frame each live effect changes the look X.
function fresh(t) {
  return { now: t, rotSpeed: 1, yaw: 0, pitch: 0, zoom: 1, dx: 0, dy: 0, focus: 0, shake: 0, gate: 1,
    bright: 1, sat: 1, hue: 0, tint: [0, 0, 0], tintK: 0, invert: 0, cloud: 1, size: 1, life: 1, rise: 0,
    echo: 0, echoDelay: 0.25, echoScale: 0.06, echoK: 0, pixel: 0, wob: 0, wobPh: 0, slice: 0, sliceSeed: 0,
    wash: [0, 0, 0], beat: 1, cls: new Array(CLASS.length).fill(1), listen: null, travel: 1 };
}
const mixTint = (X, c, k) => { if (k <= 0) return; const w = X.tintK + k; X.tint = X.tint.map((v, i) => (v * X.tintK + c[i] * k) / w); X.tintK = Math.min(1, w); };
const addWash = (X, c, k) => { X.wash = X.wash.map((v, i) => v + c[i] * k); };
const hump = (k) => Math.sin(Math.PI * Math.min(1, Math.max(0, k)));

const LOOK = {
  echo(X, e, t, k) { X.echo = Math.max(X.echo, e.rep || 3); X.echoDelay = e.delay; X.echoScale = e.grow || 0.06; X.echoK = Math.max(X.echoK, 1 - k * 0.7); mixTint(X, e.c, 0.2 * (1 - k)); },
  reverb(X, e, t, k) { const a = hump(k * 1.4); X.size *= 1 + 1.8 * a; X.life *= 1 + 2 * a; addWash(X, e.c, 0.08 * a); X.sat *= 1 - 0.3 * a; },
  flanger(X, e, t, k) { const a = hump(k); X.hue += 1.3 * a * Math.sin(TAU * (t - e.t0) / (2 * e.spb)); X.echo = Math.max(X.echo, 1); X.echoDelay = 0.035; X.echoScale = 0.025; X.echoK = Math.max(X.echoK, 0.9 * a); },
  gate(X, e, t, k, B) { X.gate *= B.sub(4) < 0.5 ? 1 : 0.1; },
  crush(X, e, t, k, B) { X.pixel = Math.max(X.pixel, 0.045); X.gate *= B.sub(2) < 0.5 ? 1 : 0.35; X.sat *= 1.5; },
  lpf(X, e, t, k) { const a = hump(k); X.bright *= 1 - 0.5 * a; X.hue -= 0.55 * a; X.size *= 1 + 0.9 * a; X.life *= 1 + a; X.cloud *= 1 - 0.3 * a; },
  hpf(X, e, t, k) { const a = hump(k); X.sat *= 1 - 0.75 * a; X.bright *= 1 + 0.7 * a; X.size *= 1 - 0.45 * a; X.cloud *= 1 - 0.55 * a; },
  resfilter(X, e, t, k) { X.hue += TAU * k; X.sat *= 1.3; X.size *= 1 + 0.4 * hump(k); },
  loop(X, e, t) { X.now = Math.min(X.now, e.t0 + ((t - e.t0) % (V.safe ? Math.max(0.4, e.loop) : e.loop))); X.gate *= 0.75 + 0.25 * Math.cos(TAU * (t - e.t0) / e.loop); },   // safe: replays ≤2.5 Hz
  reverse(X, e, t, k) { X.now = Math.min(X.now, e.t0 - (t - e.t0)); X.rotSpeed *= -2; X.hue += Math.PI * hump(k) * 0.5; },
  scratch(X, e, t, k, B) {
    const w = Math.sin(TAU * e.rate * (t - e.t0) / e.spb) * hump(k * 1.1);
    X.yaw += 0.34 * w; X.dx += 14 * w;
    if (e.gate) X.gate *= B.sub(4) < 0.5 ? 1 : 0.15;
  },
  tapestop(X, e, t, k) { const d = Math.max(0, t - e.t0), D = e.t1 - e.t0; X.now = Math.min(X.now, e.t0 + d - d * d / (2 * D)); X.rotSpeed *= 1 - k; X.sat *= 1 - 0.85 * k; X.bright *= 1 - 0.55 * k; X.dy += 26 * k * k; },
  spinback(X, e, t, k) { X.yaw -= TAU * 1.25 * (1 - (1 - k) ** 3); X.echo = Math.max(X.echo, 3); X.echoDelay = 0.05; X.echoScale = 0.0; X.echoK = Math.max(X.echoK, 0.75); X.bright *= 1 - 0.35 * k; },
  build(X, e, t, k, B) {
    const a = k * k;
    X.zoom *= 1 + 0.22 * a; X.focus = Math.max(X.focus, a); X.size *= 1 + 0.6 * a; X.bright *= 1 + 0.7 * a; X.rotSpeed *= 1 + 5 * a;
    X.travel *= 1 + 2.5 * a; X.shake = Math.max(X.shake, 4 * a); addWash(X, e.c, 0.13 * a); X.rise = Math.max(X.rise, 0.12 * a);
    if (k > 0.8) X.gate *= B.sub(4) < 0.5 ? 1 : 0.25;
  },
  drop(X, e, t, k) {
    const a = Math.exp(-k * 5);
    X.zoom *= 1 + 0.3 * a; X.shake = Math.max(X.shake, 18 * a); X.size *= 1 + 2.4 * a; X.bright *= 1 + 1.3 * a;
    addWash(X, [1, 1, 1], 0.12 * a); addWash(X, e.c, 0.25 * a); if (t - e.t0 < e.spb / 4) X.invert = 1;
  },
  cut(X, e, t, k) { const a = Math.exp(-k * 5); X.zoom *= 1 + 0.12 * a; X.shake = Math.max(X.shake, 8 * a); addWash(X, e.c, 0.3 * a); X.bright *= 1 + 0.8 * a; },
  kill(X) { X.bright *= 0.05; X.cloud *= 0.12; X.beat = 0; },
  chop(X, e, t, k, B) { X.slice = Math.max(X.slice, 0.22); X.sliceSeed = Math.floor(B.x * 2); X.gate *= B.sub(2) < 0.7 ? 1 : 0.4; },
  mashup(X, e, t, k, B) { mixTint(X, hex(DECK[((B.n % 2) + 2) % 2]), 0.28 * hump(k * 8)); X.listen = [1, 1]; },
  layer(X, e) { X.echo = Math.max(X.echo, 2); X.echoDelay = 4 * e.spb; X.echoScale = 0.1; X.echoK = Math.max(X.echoK, 0.6); },
  drumsout(X, e, t, k) { const end = k > 0.94; X.beat = 0; X.size *= end ? 2 : 0.7; X.bright *= end ? 1.6 : 0.5; },
  strip(X, e, t, k, B) { X.sat *= 0.08; X.gate *= B.phase < 0.25 ? 1 : 0.35; X.cls = X.cls.map((g, i) => g * (i === 3 || i === 9 || i === 12 ? 1.4 : 0.45)); },
  tease(X, e, t, k) { const a = hump(Math.min(1, k * 3)) * (k < 0.9 ? 1 : 0); X.dy += 60 * a; X.zoom *= 1 - 0.08 * a; X.bright *= 1 - 0.6 * a; },
  pump(X, e, t, k, B) { const duck = Math.exp(-B.phase * 4) * hump(k * 6); X.zoom *= 1 - 0.06 * duck; X.bright *= 1 - 0.5 * duck; },
  singalong(X, e, t, k) { const a = hump(k * 6); X.cls = X.cls.map((g, i) => g * (i === 9 || i === 12 || i === 6 ? 1 + 0.8 * a : 1 - 0.7 * a)); X.wob = Math.max(X.wob, 0.02 * a); X.wobPh = t * 2; mixTint(X, [1, 0.72, 0.3], 0.2 * a); },
  fill(X, e, t, k, B) { X.gate *= B.sub(4) < 0.5 ? 1 : 0.1; X.zoom *= 1 + 0.08 * k; },
  acid(X, e, t, k) { const a = hump(k * 6); X.wob = Math.max(X.wob, 0.045 * a); X.wobPh = t * 7; mixTint(X, [0.55, 1, 0.2], 0.35 * a); X.hue += 0.5 * a * Math.sin(t * 3); },
  blend(X, e, t, k) { const inc = e.inc; X.listen = [0, 1].map((i) => (i === inc ? 0.6 + 0.4 * k : 1 - 0.4 * k)); mixTint(X, hex(DECK[inc]), 0.14 * hump(k)); },
  double(X, e, t, k, B) { X.listen = [1, 1]; mixTint(X, hex(DECK[((B.n % 2) + 2) % 2]), 0.3 * k); X.zoom *= 1 + 0.12 * k * k; X.shake = Math.max(X.shake, 3 * k); },
  horn(X, e, t, k) { addWash(X, [1, 0.9, 0.3], 0.18 * (1 - k)); X.shake = Math.max(X.shake, 5 * (1 - k)); },
  siren(X, e, t, k, B) { addWash(X, B.sub(1) < 0.5 ? [1, 0.1, 0.15] : [0.1, 0.3, 1], 0.17 * hump(k * 4)); },
  laser(X, e, t) { X.gate *= 0.85 + 0.15 * Math.sin(t * 60); },
  boom(X, e, t, k) { const a = Math.exp(-k * 4); X.shake = Math.max(X.shake, 16 * a); X.zoom *= 1 - 0.05 * a; X.bright *= 1 + 0.6 * a; },
  riser(X, e, t, k) { X.bright *= 1 + 0.6 * k; X.rise = Math.max(X.rise, 0.25 * k); X.size *= 1 + 0.4 * k; },
  dhol(X, e, t, k, B) { X.zoom *= 1 + 0.035 * Math.exp(-B.sub(2) * 6); },
  co2(X, e, t, k) { addWash(X, [0.9, 0.95, 1], 0.2 * Math.exp(-k * 4)); },
};

// the effects a move starts, timed to the beat (moves play from the next beat; builds and cuts land at `lands`)
function startEffects(ev) {
  const t = clock(), B = beatInfo(t), spb = B.spb, c = hex(ev.col);
  const beat = nextGrid(t, B) - t < 0.7 ? nextGrid(t, B) : t, bar = nextGrid(t, B, 4) - t < 2.2 ? nextGrid(t, B, 4) : beat;
  const lands = ev.lands ? fromAbs(ev.lands) : null, beats = ev.beats || 1;
  const add = (kind, t0, dur, extra = {}) => V.fx.push({ kind, t0, t1: t0 + Math.max(0.05, dur), c, spb, ...extra });
  const land = (kind) => { if (lands) add(kind, lands, kind === 'drop' ? 4 * spb : 2 * spb); };
  const a = ev.arg;
  switch (ev.act) {
    case 'beatFx':
      if (a === 'echo') add('echo', beat, beats * spb * 2.5, { delay: spb / 2, rep: 3 });
      else if (a === 'reverb') add('reverb', beat, beats * spb * 3);
      else if (a === 'flanger') add('flanger', beat, Math.max(2, beats) * spb);
      else if (a === 'trans') add('gate', beat, beats * spb);
      else if (a === 'crush') add('crush', beat, beats * spb);
      else if (a === 'lpf') add('lpf', beat, beats * spb);
      else if (a === 'sweep') add('hpf', beat, beats * spb);
      break;
    case 'dub': add('echo', beat, 4 * spb, { delay: 0.75 * spb, rep: 4, grow: 0.09 }); break;
    case 'resFilter': add('resfilter', bar, 4 * spb); break;
    case 'pump': add('pump', bar, 8 * spb); break;
    case 'roll': add('loop', beat, beats * spb, { loop: (a || 0.25) * spb }); break;
    case 'stutter': add('loop', beat, spb, { loop: spb / 4 }); break;
    case 'reverse': add('reverse', beat, spb); break;
    case 'scratch': {
      const rate = { baby: 2, chirp: 4, flare: 6, transformer: 4, orbit: 3, crab: 8 }[a] || 3;
      add('scratch', beat, beats * spb, { rate, gate: a === 'transformer' || a === 'crab' });
      break;
    }
    case 'brake': add('tapestop', beat, 1.5 * spb); break;
    case 'backspin': add('spinback', beat, 2 * spb); break;
    case 'fill': add('fill', beat, spb); break;
    case 'sample': {
      add(a in LOOK ? a : 'horn', t, { horn: 1.2, siren: 4 * spb, laser: 2 * spb, boom: 1.2, riser: 8 * spb, dhol: 4 * spb, co2: 2 }[a] || 1.2);
      if (a === 'horn') [0, 0.12, 0.24].forEach((d) => V.waves.push({ t0: t + d, col: '#fff36b', dur: 1.1 }));
      if (a === 'laser') V.lasers.push({ t0: t, t1: t + 2 * spb, col: ev.col, seed: Math.random() * TAU });
      if (a === 'co2') burst(t);
      if (a === 'boom') V.waves.push({ t0: t, col: '#ffffff', dur: 0.9, drop: true });
      break;
    }
    case 'buildDrop': {
      const len = 4 * (a || 4) * spb, T = lands || beat + len, T0 = Math.max(t, T - len);
      add('build', T0, T - T0);
      add('drop', T, 4 * spb);
      break;
    }
    case 'dropSwap': if (lands) { const T0 = Math.max(t, lands - 8 * spb); add('build', T0, lands - T0); } land('drop'); break;
    case 'doubleDrop': if (lands) add('double', t, lands - t); land('drop'); break;
    case 'killDrop': if (lands) { const T0 = Math.max(t, lands - 4 * spb); add('kill', T0, lands - T0); } land('drop'); break;
    case 'echoOut': add('echo', beat, lands ? lands - beat : 8 * spb, { delay: spb / 2, rep: 5, grow: 0.12 }); land('cut'); break;
    case 'spinCut': add('spinback', beat, lands ? lands - beat : 2 * spb); land('cut'); break;
    case 'hardCut': if (lands) land('cut'); else add('cut', beat, 2 * spb); break;
    case 'blend': add('blend', t, (ev.beats || 32) * spb, { inc: a === 'B' ? 1 : 0 }); break;
    case 'chop': add('chop', bar, (ev.beats || 8) * spb); break;
    case 'mashup': add('mashup', bar, (ev.beats || 64) * spb); break;
    case 'layer': add('layer', bar, (ev.beats || 32) * spb); break;
    case 'drumsOut': add('drumsout', bar, (ev.beats || 16) * spb); break;
    case 'melodyOut': add('strip', bar, (ev.beats || 32) * spb); break;
    case 'bassTease': add('tease', bar, 4.3 * spb); break;
    case 'singalong': add('singalong', bar, (ev.beats || 16) * spb); break;
    case 'acid': add('acid', bar, (ev.beats || 16) * spb); break;
  }
  V.titles.push({ t0: beat, text: ev.name, col: ev.col });
  if (V.titles.length > 3) V.titles.shift();
}

function look(t, B) {
  const X = fresh(t);
  V.fx = V.fx.filter((e) => t < e.t1 + 0.1);
  for (const e of V.fx) {
    if (t < e.t0 || t > e.t1) continue;
    LOOK[e.kind]?.(X, e, t, (t - e.t0) / (e.t1 - e.t0), B);
  }
  return X;
}

// colour grade: hue turn about the grey axis, saturation, tint, invert -> the 11 class colours (alpha: cloud strength)
function grade(X) {
  const c = Math.cos(X.hue), s = Math.sin(X.hue), k = 1 / 3, r3 = Math.sqrt(k);
  const m = [c + (1 - c) * k, k * (1 - c) - r3 * s, k * (1 - c) + r3 * s,
             k * (1 - c) + r3 * s, c + (1 - c) * k, k * (1 - c) - r3 * s,
             k * (1 - c) - r3 * s, k * (1 - c) + r3 * s, c + (1 - c) * k];
  const out = new Float32Array(CLASS.length * 4);
  CLASS.forEach(([r, g, b, a], i) => {
    let v = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
    const l = 0.3 * v[0] + 0.59 * v[1] + 0.11 * v[2];
    v = v.map((x, j) => Math.max(0, (l + (x - l) * X.sat) * (1 - X.tintK) + X.tint[j] * X.tintK));
    if (X.invert) v = v.map((x) => Math.max(0, 1 - x));
    out.set([...v, a * X.cls[i]], i * 4);
  });
  return out;
}

// ---------------- layout & projection ----------------
function layout(X) {
  const W = innerWidth, H = innerHeight, narrow = W < 640;
  const side = V.panel && !narrow ? 332 : 0, cw = W - side, ch = narrow && V.panel ? H * 0.55 : H;
  let L;
  const ex = V.ext || { x: 1, y: 0.5 }, tall = ex.y > 0.8 * ex.x;
  if (tall) {
    // a whole CNS (brain on top, nerve cord below): the flies stand side by side, the DJ fly in the middle
    const fit = (wFrac, hFrac) => Math.min(hFrac * ch / (ex.y * H), wFrac * cw / (ex.x * H));
    if (V.flies >= 3) {
      const s = fit(0.32, 0.72), sl = s * 0.62;
      L = [{ x: cw * 0.16, y: ch * 0.54, s: sl }, { x: cw * 0.84, y: ch * 0.54, s: sl }, { x: cw * 0.5, y: ch * 0.49, s }];
    } else if (V.flies === 2) {
      const s = fit(0.42, 0.78);
      L = [{ x: cw * 0.27, y: ch * 0.52, s }, { x: cw * 0.73, y: ch * 0.52, s }];
    } else L = [{ x: cw * 0.5, y: ch * 0.5, s: fit(0.8, 0.84) }];
  } else if (V.flies >= 3) {
    const s = Math.min(0.62 * cw / H, 1.25 * ch / H, 1.0), sl = s * 0.45;
    L = [{ x: cw * 0.25, y: ch * 0.25, s: sl }, { x: cw * 0.75, y: ch * 0.25, s: sl }, { x: cw * 0.5, y: ch * 0.65, s }];
  } else if (V.flies === 2) {
    const s = Math.min(0.44 * cw / H, 0.9 * ch / H);
    L = [{ x: cw * 0.27, y: ch * 0.48, s }, { x: cw * 0.73, y: ch * 0.48, s }];
  } else L = [{ x: cw * 0.5, y: ch * 0.48, s: Math.min(0.8 * cw / H, 1.6 * ch / H) }];
  // the camera: user zoom about the content centre, the build's push toward the performer, shake and nudges
  const cx = cw / 2, cy = ch / 2, z = V.user.zoom * X.zoom, pf = Math.min(V.performer, L.length - 1);
  const sh = X.shake ? [(Math.random() - 0.5) * 2 * X.shake, (Math.random() - 0.5) * 2 * X.shake] : [0, 0];
  return L.map((l, k) => {
    let x = l.x, y = l.y, s = l.s;
    if (k === pf && X.focus) { x += (cx - x) * 0.6 * X.focus; y += (cy - y) * 0.6 * X.focus; s *= 1 + 0.3 * X.focus; }
    return { x: cx + (x - cx) * z + X.dx + sh[0], y: cy + (y - cy) * z + X.dy + sh[1], s: s * z, base: l };
  });
}
function rotation(X) {
  const ph = V.rotPhase, yaw = 0.42 * Math.sin(ph * TAU / 46) + X.yaw + V.user.yaw;
  const pitch = 0.2 + 0.1 * Math.sin(ph * TAU / 29) + X.pitch + V.user.pitch;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [[cy, sy * sp, sy * cp], [0, cp, -sp], [-sy, cy * sp, cy * cp]];     // rows of Ry(yaw) * Rx(pitch)
}
function project(p, f) {
  const R = V.rot, L = V.L[f], H = innerHeight;
  const q = R.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]);
  const s = 1 / (1 + q[2] * 0.3);
  return [L.x + q[0] * L.s * s * H / 2, L.y - q[1] * L.s * s * H / 2];
}

// ---------------- the brain server ----------------
function connect() {
  const ws = V.ws = new WebSocket(`ws://${location.host}/ws${location.search}`);
  ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === 'hello') onHello(d); else if (d.type === 'frame') onFrame(d); };
  ws.onclose = () => { $('#stat').textContent = 'brain offline'; setTimeout(connect, 2000); };
}

// the brain this page was built for: the server greets every connection, and a restart can bring another brain (fly
// count, connectome, outputs); then the positions, ears and neuron slots here are wrong, so the page starts over
const helloKey = (h) => JSON.stringify([h.flies || 1, h.connectome || 'flywire', h.n_neurons, h.n_connections,
  h.inputs?.length, h.outputs?.length, h.trained?.synapses ?? 0]);

async function onHello(h) {
  if (V.hello) { if (helloKey(h) !== helloKey(V.hello)) location.reload(); return; }    // same brain: a reconnect
  V.hello = h; V.flies = h.flies || 1;
  loadPositions(await (await fetch('brain_xyz.bin')).arrayBuffer());
  // the DJ fly's ears: centroids of its left / right Johnston's organ neurons (where the listener streams land)
  const earIdx = (e) => h.inputs.filter((c) => c.ear === e).flatMap((c) => c.idx || []);
  V.earC = [centroid(earIdx('L')), centroid(earIdx('R'))];
  // the listener neurons the server wires into the DJ fly's ear bands (flybrain/server.py LISTENER_TAPS)
  if (h.dj_tap_types) { const taps = new Set(h.dj_tap_types); V.tapSlot = h.outputs.map((o) => o.cls === 'descending' && taps.has(o.type)); }
  V.performer = V.flies === 3 ? 2 : 0;
  requestAnimationFrame(draw);
  bus?.postMessage({ type: 'sync?' });             // the move history: the answer to the first ask came before this hello
}

function onFrame(f) {
  if (!V.pos) return;
  const t = clock();
  V.rate += (f.n / 0.02 - V.rate) * 0.05; V.load = f.load;
  const vz = f.vizs || [f.viz];
  for (let k = 0; k < vz.length; k++) for (const i of vz[k]) spikes.push(i, t + Math.random() * 0.02, k);
  if (V.flies === 3 && V.tapSlot && f.outs) {
    for (const k of [0, 1]) for (const [s] of f.outs[k]) if (V.tapSlot[s] && Math.random() < 0.7) parts.push(V.hello.out_idx[s], t + Math.random() * 0.02, k);
  }
}

// ---------------- the DJ app ----------------
const bus = 'BroadcastChannel' in window ? new BroadcastChannel('flybrain-dj') : null;
bus?.addEventListener('message', (e) => {
  const d = e.data;
  if (d.type === 'state') { V.state = d; V.stateAt = clock(); V.performer = d.performer ?? V.performer; renderDecks(); }
  else if (d.type === 'move') onMove(d);
  else if (d.type === 'sync' && V.hello) {
    // asked more than once (at load, at hello, while the DJ app is quiet): add only moves not shown yet, newest first
    const seen = new Set(V.moves.map((m) => m.t));
    for (const m of d.moves.slice(-7)) if (!seen.has(m.t)) onMove(m, true);
    V.moves.sort((a, b) => b.t - a.t); V.moves.length = Math.min(V.moves.length, 7);
    renderHist();
  }
  else if (d.type === 'log') { V.logs.unshift(d.html); V.logs.length = Math.min(V.logs.length, 3); $('#tick').innerHTML = V.logs.map((l) => `<div>${safeHTML(l)}</div>`).join(''); }
});
bus?.postMessage({ type: 'sync?' });
setInterval(() => { if (clock() - V.stateAt > 3) bus?.postMessage({ type: 'sync?' }); }, 2000);

// the output neurons behind a move: a MOVES group (flydj.js) or a listener's trained readout (SPACE / MIX / PEAK)
const matches = (m, o) => (m.types ? m.types.includes(o.type) : true) && (m.cls ? o.cls === m.cls : true) && (m.side ? o.side === m.side : true);
function groupNeurons(group) {
  if (V.groupCache.has(group)) return V.groupCache.get(group);
  const h = V.hello, m = MOVES.find((x) => x.key === group), idx = [];
  const ro = h.trained?.readout?.[group], ids = ro ? new Set(ro.neurons.map((n) => n.id)) : null;
  h.outputs.forEach((o, i) => { if (m ? matches(m, o) : ids ? ids.has(o.id) : false) idx.push(h.out_idx[i]); });
  V.groupCache.set(group, idx);
  return idx;
}
function groupLabel(ev) {
  const m = MOVES.find((x) => x.key === ev.group);
  if (m) return m.key === 'arousal' ? `all ${groupNeurons('arousal').length.toLocaleString()} descending neurons` : m.key === 'sing' ? 'motor neurons (proboscis / pharynx)' : m.label;
  const ro = V.hello.trained?.readout?.[ev.group];
  if (ro) return `listener fly ${ev.fly ? 'B' : 'A'} · ${ev.group} neurons (${[...new Set(ro.neurons.map((n) => n.type))].join(' · ')})`;
  return null;
}

function onMove(ev, replay = false) {
  if (!V.hello) return;
  const [name, fam] = describe(ev);
  Object.assign(ev, { name, fam, col: FAM[fam], local: fromAbs(ev.t), label: groupLabel(ev) });
  V.moves.unshift(ev); V.moves.length = Math.min(V.moves.length, 7);
  if (replay) return;
  V.cur = ev;
  const t = clock();
  if (ev.group) {
    const idx = groupNeurons(ev.group), c = hex(ev.col), f = ev.fly ?? V.performer;
    for (const i of idx) rings.push(i, t, f, ...c);
    V.hl = { idx, f, t0: t, col: ev.col, label: ev.label, c: centroid(idx) };
  } else V.hl = null;
  if (ev.fam === 'transition' || ev.fam === 'build') V.waves.push({ t0: t, col: ev.col, dur: 1.4 });
  startEffects(ev);
  renderCard(ev);
  renderHist();
}

// ---------------- side panel ----------------
function renderCard(ev) {
  const card = $('#card');
  $('#mv-lbl').textContent = ev.by === 'you' ? 'you did' : ev.by === 'plan' ? 'the set plan did' : V.flies === 3 ? 'the DJ fly is doing' : 'the fly is doing';
  const nm = $('#mv-name'); nm.textContent = ev.name; nm.style.color = ev.col;
  let who;
  if (ev.by === 'you') who = 'by you, from the pads / keys';
  else if (ev.by === 'plan') who = esc(ev.who);
  else if (ev.label) {
    who = `fired by <b>${esc(ev.label)}</b>`;
    if (ev.transition) who += ` <span class="dim">(${WHY[ev.transition] || ev.transition})</span>`;
    else if (ev.intensity) who += ` <span class="dim">· burst ×${ev.intensity.toFixed(1)}</span>`;
  } else who = esc(ev.who || '');
  $('#mv-who').innerHTML = who;
  const bar = $('#mv-int');
  bar.style.background = ev.col; bar.style.width = `${Math.round(100 * Math.min(1, ev.intensity ? (ev.intensity - 1) / 3 : ev.fam === 'transition' || ev.fam === 'build' ? 1 : 0.5))}%`;
  card.style.setProperty('--c', ev.col);
  card.classList.remove('hit'); void card.offsetWidth; card.classList.add('hit');
}
const ago = (s) => (s < 1.5 ? 'now' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}`);
function renderHist() {
  const t = clock();
  $('#hist').innerHTML = V.moves.slice(V.cur ? 1 : 0, 7).map((m) =>
    `<li><i style="background:${m.col}"></i><b>${esc(m.name)}</b><span>${esc(m.by === 'you' ? 'you' : m.label || m.who || '')}</span><em>${ago(t - m.local)}</em></li>`).join('');
}
function renderDecks() {
  const s = V.state;
  if (!s) return;
  $('#decks').innerHTML = s.decks.map((d, i) => `<div class="deck${s.onAir === i ? ' on' : ''}"><span class="l" style="color:${DECK[i]}">${d.name}</span>` +
    `<span class="tn">${esc(d.track || '—')}</span><span>${d.bpm ? d.bpm.toFixed(1) : ''}</span></div>`).join('') +
    `<div class="xf"><i style="left:${(100 * s.xf).toFixed(1)}%"></i></div>`;
}
function renderPanel(t) {
  const s = V.state, live = s && t - V.stateAt < 3;
  $('#stat').textContent = V.hello ? `${V.flies > 1 ? V.flies + ' flies · ' : ''}${V.hello.trained ? 'trained · ' : ''}${Math.round(V.rate / 1000)}k spikes/s · load ${V.load.toFixed(2)}` : 'connecting to the brain…';
  if (!live && !V.cur) {
    $('#mv-name').textContent = t - V.openedAt < 4 ? '…' : 'no DJ yet';
    $('#mv-who').innerHTML = t - V.openedAt < 4 ? 'listening for the DJ app…'
      : 'The DJ app isn\'t playing in this browser. Open <b>localhost:8765</b> here (reload it if it was already open) and press <b>Start the fly</b>. Its moves show up here.';
  }
  const p = live ? s.pending : null, nx = $('#next');
  if (p) {
    const left = Math.max(0, fromAbs(p.at) - t);
    if (V.pendKey !== p.at) { V.pendKey = p.at; V.pendTotal = Math.max(left, 0.1); }
    nx.innerHTML = `<span class="dim">NEXT</span> <b style="color:${FAM.transition}">${STYLE_NAME[p.style] || p.style}</b> into deck ${p.dir > 0 ? 'B' : 'A'}` +
      ` <span class="dim">in ${left.toFixed(1)}s · ${WHY[p.style] || ''}</span><div class="bar"><i style="width:${(100 * (1 - left / V.pendTotal)).toFixed(0)}%;background:${FAM.transition}"></i></div>`;
  } else nx.innerHTML = live ? `<span class="dim">${esc(s.persona)}${s.arc ? ' · ' + esc(s.arc) : ''} · epic ${Math.round(100 * s.epic)}%</span>` : '';
  const d = V.fx.find((e) => (e.kind === 'drop' || e.kind === 'cut') && e.t0 > t);
  $('#mv-lands').innerHTML = d ? `<span style="color:${V.cur?.col || '#fff'}">${d.kind} in ${(d.t0 - t).toFixed(1)}s</span>` : '';
  renderHist();
}

// ---------------- drawing ----------------
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  if (glc.width !== W || glc.height !== H) { glc.width = hudc.width = W; glc.height = hudc.height = H; }
  return dpr;
}

let lastPanel = 0;
function draw() {
  requestAnimationFrame(draw);
  if (V.glLost || V.warn) { V.lastT = clock(); return; }               // nothing on screen until the warning is answered
  const t = clock(), dt = Math.min(0.1, t - V.lastT), dpr = resize(), W = innerWidth, H = innerHeight;
  V.lastT = t;
  const B = beatInfo(t), X = V.X = soften(look(t, B), dt);
  V.rotPhase += dt * X.rotSpeed;
  V.rot = rotation(X); V.L = layout(X);
  const env = B.env * X.beat, pulse = 1 + 0.012 * env + 0.01 * B.down * X.beat;
  const onAir = V.state && t - V.stateAt < 3 ? V.state.onAir : -1;
  const listen = X.listen || [0, 1].map((k) => (onAir < 0 ? 1 : onAir === k ? 1 : 0.6));
  const gain = X.gate * X.bright;

  gl.viewport(0, 0, glc.width, glc.height);
  gl.disable(gl.BLEND);
  // background: dark, breathing on the beat, washed in the colours of the moves
  const pf = V.L[Math.min(V.performer, V.L.length - 1)];
  gl.useProgram(P.bg.p); gl.bindVertexArray(emptyVao);
  const inv = X.invert ? 0.25 : 0;
  gl.uniform3f(P.bg.loc.u_flash, X.wash[0] + inv, X.wash[1] + inv, X.wash[2] + inv);
  gl.uniform2f(P.bg.loc.u_c, pf.x / W * 2 - 1, 1 - pf.y / H * 2);
  gl.uniform1f(P.bg.loc.u_aspect, H / W); gl.uniform1f(P.bg.loc.u_beat, env);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  const R = V.rot, rotCM = new Float32Array([R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]);
  const flyU = (grow = 0) => {
    const a = new Float32Array(9);
    V.L.forEach((L, k) => { a[3 * k] = L.x / W * 2 - 1; a[3 * k + 1] = 1 - L.y / H * 2; a[3 * k + 2] = L.s * pulse * (1 + grow); });
    return a;
  };
  const flies = flyU(), cls = grade(X);
  const spx = new Float32Array([0, 1, 2].map((k) => (V.L[k] ? 9 * dpr * Math.sqrt(V.L[k].s) * X.size : 0)));
  const fgain = new Float32Array([V.flies >= 2 ? listen[0] : 1, V.flies >= 2 ? listen[1] : 1, 1]);
  const common = (pr, fl = flies) => {
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, posTex); gl.uniform1i(pr.loc.u_pos, 0);
    gl.uniformMatrix3fv(pr.loc.u_rot, false, rotCM); gl.uniform3fv(pr.loc.u_fly, fl);
    gl.uniform1f(pr.loc.u_aspect, H / W); gl.uniform4fv(pr.loc.u_cls, cls);
    gl.uniform1f(pr.loc.u_pixel, X.pixel); gl.uniform2f(pr.loc.u_wob, X.wob, X.wobPh); gl.uniform3f(pr.loc.u_slice, X.slice, X.sliceSeed, 7);
    if (pr.loc.u_now) gl.uniform1f(pr.loc.u_now, t);
    if (pr.loc.u_spx) gl.uniform3fv(pr.loc.u_spx, spx);
  };

  // the static brains: every neuron a faint dot in its class colour
  common(P.cloud); gl.bindVertexArray(emptyVao);
  V.L.forEach((L, k) => {
    const lg = k < 2 && V.flies >= 2 ? listen[k] : 1, fade = k !== V.performer && X.focus ? 1 - 0.7 * X.focus : 1;
    gl.uniform1i(P.cloud.loc.u_f, k); gl.uniform1f(P.cloud.loc.u_px, Math.max(1, dpr * Math.min(1.6, 0.6 + L.s)));
    gl.uniform1f(P.cloud.loc.u_gain, lg * fade * X.cloud * (0.55 + 0.35 * L.base.s) * (0.4 + 0.6 * gain) * (1 + 0.5 * env));
    gl.drawArrays(gl.POINTS, 0, V.n);
  });
  // rings on the neurons behind the latest move, and on the ones you stimulated
  rings.upload(); common(P.ring); gl.uniform1f(P.ring.loc.u_hlife, 2.6);
  gl.bindVertexArray(rings.vao); gl.drawArrays(gl.POINTS, 0, rings.cap);
  // spikes, plus the echo ghosts: the same spikes a little earlier and a little bigger
  spikes.upload();
  for (let e = X.echo; e >= 0; e--) {
    common(P.spike, e ? flyU(X.echoScale * e) : flies);
    gl.uniform1f(P.spike.loc.u_now, X.now - e * X.echoDelay);
    gl.uniform1f(P.spike.loc.u_life, 0.9 * X.life); gl.uniform1f(P.spike.loc.u_rise, X.rise);
    gl.uniform1f(P.spike.loc.u_gain, (0.85 + 0.3 * env) * gain * (e ? X.echoK * 0.62 ** e : 1));
    gl.uniform3fv(P.spike.loc.u_fgain, fgain);
    gl.bindVertexArray(spikes.vao); gl.drawArrays(gl.POINTS, 0, spikes.cap);
  }
  // listener flies -> the DJ fly's ears
  if (V.flies === 3 && V.earC) {
    parts.upload(); common(P.part);
    gl.uniform1f(P.part.loc.u_travel, 0.85 / X.travel); gl.uniform1f(P.part.loc.u_ppx, 5 * dpr * Math.sqrt(X.size));
    gl.uniform3fv(P.part.loc.u_ear, new Float32Array([...V.earC[0], ...V.earC[1]]));
    const dk = [0, 1].flatMap((k) => hex(DECK[k]).map((v) => v * listen[k] * (0.4 + 0.6 * X.gate)));
    gl.uniform3fv(P.part.loc.u_deck, new Float32Array(dk));
    gl.bindVertexArray(parts.vao); gl.drawArraysInstanced(gl.POINTS, 0, parts.cap, 7);
  }
  gl.bindVertexArray(null);

  drawHUD(t, dt, dpr, B, X, listen);
  if (t - lastPanel > 0.2) { lastPanel = t; renderPanel(t); }
}

function drawHUD(t, dt, dpr, B, X, listen) {
  const g = hud, W = innerWidth, H = innerHeight, s = V.state, live = s && t - V.stateAt < 3;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.textAlign = 'center'; g.textBaseline = 'top';
  g.shadowColor = 'rgba(0,0,0,.95)'; g.shadowBlur = 6;
  const text = (str, x, y, col, size = 11, weight = 600) => { g.font = `${weight} ${size}px ui-monospace, "SF Mono", Menlo, monospace`; g.fillStyle = col; g.fillText(str, x, y); };
  const tallShape = V.ext && V.ext.y > 0.8 * V.ext.x;
  const hy = (L) => (0.5 * (V.ext?.y ?? 0.5) + (tallShape ? 0.13 : 0.06)) * L.s * H;     // half the shape's height on screen
  const under = (L) => L.y + hy(L) + 8;
  const pf = V.L[Math.min(V.performer, V.L.length - 1)];

  // the move's name, big and fading, the moment it plays
  V.titles = V.titles.filter((m) => t - m.t0 < 1.6);
  g.shadowBlur = 0;
  for (const m of V.titles) {
    const k = (t - m.t0) / 1.6;
    if (k < 0) continue;
    g.globalAlpha = 0.5 * (1 - k) ** 1.5;
    text(m.text.toUpperCase(), pf.x, pf.y - hy(pf) - 30 - 16 * k, m.col, 34 + 10 * (1 - k), 800);
  }
  g.globalAlpha = 1; g.shadowBlur = 6;

  V.L.forEach((L, k) => {
    const y = under(L), deck = s?.decks?.[k];
    if (V.flies === 3 && k < 2) {
      // above the brain: its stream into the DJ fly leaves from underneath
      const y0 = Math.max(8, L.y - hy(L) - 54);
      g.globalAlpha = 0.5 + 0.5 * listen[k];
      text(`LISTENER FLY ${'AB'[k]}${live && s.onAir === k ? ' · ON AIR' : ''}`, L.x, y0, DECK[k], 11, 700);
      text(`hears deck ${'AB'[k]}${deck?.track ? ' · ' + clip(deck.track, 34) : ''}`, L.x, y0 + 15, '#8a93a8', 10.5, 500);
      const r = live ? s.listeners?.[k] : null;
      if (r) ['MIX', 'SPACE', 'PEAK'].forEach((name, j) => meter(g, L.x - 96 + j * 66, y0 + 33, name, r[name]?.rank ?? 0, !!r[name]?.on, DECK[k]));
      // what this fly hears: its 12 ear bands as bars around the brain
      const bands = live ? s.ears?.[k ? 'R' : 'L'] : null;
      if (bands) spectrum(g, L, bands, DECK[k], B.env);
      g.globalAlpha = 1;
    } else if (V.flies === 3) {
      text('DJ FLY', L.x, y, '#e6ebf5', 12, 800);
      text('left ear ← listener A · right ear ← listener B · plays the set', L.x, y + 16, '#8a93a8', 10.5, 500);
    } else if (V.flies === 2) {
      text(`FLY ${'AB'[k]}${live && s.onAir === k ? ' · ON AIR' : ''}`, L.x, y, DECK[k], 11, 700);
      if (deck?.track) text(clip(deck.track, 40), L.x, y + 15, '#8a93a8', 10.5, 500);
    } else text('THE FLY', L.x, y, '#e6ebf5', 12, 800);
  });
  // the DJ fly's ears, where the listener streams land
  if (V.flies === 3 && V.earC) V.earC.forEach((c, k) => {
    const [x, y] = project(c, 2);
    g.strokeStyle = DECK[k]; g.globalAlpha = (0.55 + 0.3 * B.env) * (0.5 + 0.5 * listen[k]); g.lineWidth = 1.2;
    g.beginPath(); g.arc(x, y, 9 + 3 * B.env, 0, TAU); g.stroke(); g.globalAlpha = 1;
    g.textAlign = k ? 'left' : 'right'; text(k ? 'R ear ← B' : 'A → L ear', x + (k ? 16 : -16), y + 10, DECK[k], 10, 700); g.textAlign = 'center';
  });
  // a line from the move card to the neurons that fired it
  const hl = V.hl;
  if (hl && t - hl.t0 < 3 && V.panel && innerWidth >= 640 && V.L[hl.f]) {
    const a = Math.min(1, 3 - (t - hl.t0)), [x, y] = project(hl.c, hl.f), card = $('#card').getBoundingClientRect();
    const x0 = card.left - 4, y0 = card.top + card.height / 2;
    g.globalAlpha = 0.8 * a; g.strokeStyle = hl.col; g.lineWidth = 1.4; g.setLineDash([4, 5]); g.lineDashOffset = -t * 30;
    g.beginPath(); g.moveTo(x0, y0); g.bezierCurveTo(x0 - 90, y0, x + 90, y - 60, x, y - 6); g.stroke(); g.setLineDash([]);
    g.globalAlpha = a; text(clip(hl.label || '', 44), x, V.flies === 3 && hl.f < 2 ? y + 16 : y - 26, hl.col, 11, 700);
    g.globalAlpha = 1;
  }
  // neurons you stimulated
  V.pokes = V.pokes.filter((p) => t - p.t0 < 2.5);
  for (const p of V.pokes) {
    if (!V.L[p.f]) continue;
    const [x, y] = project(p.c, p.f), a = 1 - (t - p.t0) / 2.5;
    g.globalAlpha = a; g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(x, y, 14 + 30 * (1 - a), 0, TAU); g.stroke();
    text(`⚡ ${p.label}`, x, y + 20 + 30 * (1 - a), '#ffffff', 11, 700);
    g.globalAlpha = 1;
  }
  // shockwaves (transitions, builds, drops, horns), lasers, confetti
  for (const f of V.fx) if (f.kind === 'drop' && t >= f.t0 && !f.waved) { f.waved = true; V.waves.push({ t0: t, col: '#ffffff', dur: 1.6, drop: true }); }
  V.waves = V.waves.filter((w) => t - w.t0 < (w.dur || 1.4));
  for (const w of V.waves) {
    const k = (t - w.t0) / (w.dur || 1.4);
    if (k < 0) continue;
    const r = (0.15 + k * 0.9) * pf.s * H * (w.drop ? 1.2 : 0.8);
    g.globalAlpha = (1 - k) * (w.drop ? 0.9 : 0.5); g.strokeStyle = w.col; g.lineWidth = (w.drop ? 5 : 2.5) * (1 - k) + 0.5;
    g.beginPath(); g.ellipse(pf.x, pf.y, r, r * 0.55, 0, 0, TAU); g.stroke();
  }
  V.lasers = V.lasers.filter((l) => t < l.t1);
  g.shadowBlur = 0; g.globalCompositeOperation = 'lighter';
  for (const l of V.lasers) {
    const k = (t - l.t0) / (l.t1 - l.t0);
    g.strokeStyle = l.col; g.lineWidth = 2.2; g.globalAlpha = (V.safe ? SAFE.laser : 0.75) * (1 - k);
    for (let i = 0; i < 6; i++) {
      const ang = l.seed + i * TAU / 6 + t * 1.6 * (i % 2 ? 1 : -1);
      g.beginPath(); g.moveTo(pf.x, pf.y); g.lineTo(pf.x + Math.cos(ang) * W, pf.y + Math.sin(ang) * W); g.stroke();
    }
  }
  V.confetti = V.confetti.filter((p) => t - p.t0 < 2.4);
  for (const p of V.confetti) {
    p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.99;
    g.globalAlpha = 1 - (t - p.t0) / 2.4; g.fillStyle = p.col;
    g.fillRect(p.x, p.y, 4, 7);
  }
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  // hover: which neuron the pointer is on
  const hv = V.hover;
  if (hv && !V.drag) {
    g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.globalAlpha = 0.9;
    g.beginPath(); g.arc(hv.x, hv.y, 7, 0, TAU); g.stroke(); g.globalAlpha = 1;
  }
}
function meter(g, x, y, name, v, on, col) {
  g.textAlign = 'left'; g.font = '600 9px ui-monospace, "SF Mono", Menlo, monospace';
  g.fillStyle = on ? col : '#6b7385'; g.fillText(name, x, y);
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x, y + 12, 58, 3);
  g.fillStyle = on ? col : '#59627a'; g.fillRect(x, y + 12, 58 * Math.max(0, Math.min(1, v)), 3);
  g.textAlign = 'center';
}
// a listener fly's ear bands as short bars (low bands left, high right): around the lower edge of a wide brain,
// or in an arc over the head of a tall CNS (its nerve cord hangs below)
function spectrum(g, L, bands, col, env) {
  const H = innerHeight, ex = V.ext || { x: 1, y: 0.5 }, tall = ex.y > 0.8 * ex.x, n = bands.length;
  const rx = ex.x * 0.5 * L.s * H * 1.05;
  const ry = tall ? 0.16 * ex.y * L.s * H : (0.5 * ex.y + 0.06) * L.s * H * 0.95;
  const cy = tall ? L.y - 0.36 * ex.y * L.s * H : L.y;
  g.save(); g.shadowBlur = 0; g.strokeStyle = col; g.lineWidth = 3; g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const a = tall ? -Math.PI * (0.92 - 0.84 * i / (n - 1)) : Math.PI * (0.92 - 0.84 * i / (n - 1)), v = Math.min(1, bands[i]);
    const x = L.x + Math.cos(a) * rx, y = cy + Math.sin(a) * ry, len = 4 + 22 * v;
    g.globalAlpha = (0.25 + 0.6 * v + 0.15 * env) * g.globalAlpha;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len * 0.6); g.stroke();
    g.globalAlpha = 1;
  }
  g.restore();
}
function burst(t) {
  const pf = V.L[Math.min(V.performer, V.L.length - 1)] || { x: innerWidth / 2, y: innerHeight / 2 };
  const cols = ['#ffffff', '#fff36b', '#35e0c2', '#ff5ca8', '#4cc3ff', '#b36bff'];
  for (let i = 0; i < 180; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, v = 350 + Math.random() * 650;
    V.confetti.push({ t0: t, x: pf.x, y: pf.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, col: cols[i % cols.length] });
  }
}

// ---------------- interaction ----------------
// drag = turn the brains, wheel = zoom, double-click = reset, hover = what a neuron is, click = stimulate its type
const tip = $('#tip');
function pick(mx, my) {
  if (!V.hello || !V.rot) return null;
  const h = V.hello; let best = null, bd = 14 * 14;
  V.L.forEach((L, f) => {
    h.out_idx.forEach((i, slot) => {
      if (V.pos[4 * i + 3] < 0) return;
      const [x, y] = project([V.pos[4 * i], V.pos[4 * i + 1], V.pos[4 * i + 2]], f), d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) { bd = d; best = { f, slot, i, x, y }; }
    });
  });
  return best;
}
function describeNeuron(hv) {
  const h = V.hello, o = h.outputs[hv.slot];
  const fly = V.flies === 3 ? ['listener fly A', 'listener fly B', 'DJ fly'][hv.f] : V.flies === 2 ? `fly ${'AB'[hv.f]}` : 'the fly';
  const drives = MOVES.filter((m) => !m.continuous && matches(m, o)).map((m) => m.action);
  const steers = MOVES.filter((m) => m.continuous && m.key !== 'arousal' && matches(m, o)).map((m) => m.action);
  const ro = Object.entries(h.trained?.readout || {}).filter(([, r]) => r.neurons.some((n) => n.id === o.id)).map(([k]) => k);
  const tap = V.flies === 3 && hv.f < 2 && V.tapSlot?.[hv.slot];
  const lines = [`<b>${esc(o.type || 'unnamed')}</b> <span class="dim">${esc(o.cls)}${o.side ? ' · ' + esc(o.side) : ''} · ${fly}</span>`];
  if (hv.f === V.performer && drives.length) lines.push(`drives: ${esc(drives.join(' · '))}`);
  else if (hv.f === V.performer && steers.length) lines.push(`steers: ${esc(steers.join(' · '))}`);
  if (ro.length) lines.push(`trained ${ro.join(' / ')} neuron`);
  if (tap) lines.push(`feeds the DJ fly's ${hv.f ? 'right' : 'left'} ear`);
  lines.push(`<span class="dim">click: stimulate every ${esc(o.type || 'such')} neuron in this fly</span>`);
  return lines.join('<br>');
}
function poke(hv) {
  const h = V.hello, o = h.outputs[hv.slot];
  const idx = o.type ? h.outputs.map((x, s) => (x.type === o.type ? h.out_idx[s] : -1)).filter((i) => i >= 0).slice(0, 64) : [hv.i];
  if (V.ws?.readyState === 1) V.ws.send(JSON.stringify({ type: 'poke', fly: hv.f, idx, hz: 180, ms: 900 }));
  const t = clock();
  for (const i of idx) rings.push(i, t, hv.f, 1, 1, 1);
  V.pokes.push({ t0: t, f: hv.f, c: centroid(idx), label: `${o.type || 'neuron'} ×${idx.length}` });
}
glc.addEventListener('pointerdown', (e) => { V.drag = { x: e.clientX, y: e.clientY, t: clock(), moved: 0 }; glc.setPointerCapture(e.pointerId); glc.style.cursor = 'grabbing'; });
glc.addEventListener('pointermove', (e) => {
  if (V.drag) {
    const dx = e.clientX - V.drag.x, dy = e.clientY - V.drag.y;
    V.drag.moved += Math.abs(dx) + Math.abs(dy); V.drag.x = e.clientX; V.drag.y = e.clientY;
    V.user.yaw += dx * 0.008; V.user.pitch = Math.max(-1.2, Math.min(1.2, V.user.pitch + dy * 0.006));
    tip.style.display = 'none';
    return;
  }
  const now = clock();
  if (now - (V.lastPick || 0) < 0.04) return;
  V.lastPick = now;
  V.hover = pick(e.clientX, e.clientY);
  if (V.hover) {
    tip.innerHTML = describeNeuron(V.hover); tip.style.display = 'block';
    tip.style.left = `${Math.min(innerWidth - 300, e.clientX + 16)}px`; tip.style.top = `${Math.min(innerHeight - 120, e.clientY + 14)}px`;
    glc.style.cursor = 'pointer';
  } else { tip.style.display = 'none'; glc.style.cursor = 'grab'; }
});
glc.addEventListener('pointerup', (e) => {
  const d = V.drag; V.drag = null; glc.style.cursor = 'grab';
  if (d && d.moved < 5 && clock() - d.t < 0.5) { const hv = pick(e.clientX, e.clientY); if (hv) poke(hv); }
});
glc.addEventListener('pointerleave', () => { V.hover = null; tip.style.display = 'none'; });
glc.addEventListener('wheel', (e) => { e.preventDefault(); V.user.zoom = Math.max(0.5, Math.min(3, V.user.zoom * Math.exp(-e.deltaY * 0.0012))); }, { passive: false });
glc.addEventListener('dblclick', () => { V.user = { yaw: 0, pitch: 0, zoom: 1 }; });

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('button, input, select, textarea, [contenteditable]')) return;
  if (V.warn) return;
  if (e.key === 's' || e.key === 'S') setSafe(!V.safe);
  if (e.key === 'h' || e.key === 'H') { V.panel = !V.panel; $('#side').classList.toggle('hidden', !V.panel); }
  if (e.key === 'f' || e.key === 'F') {
    const el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  }
});

// Safari drops WebGL contexts under GPU memory pressure: stop drawing, and when the context comes back start the page
// over (every buffer, texture and program went with the old one; the move history is asked for again)
glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); V.glLost = true; $('#msg').textContent = 'the GPU dropped the picture: waiting for it to come back…'; });
glc.addEventListener('webglcontextrestored', () => location.reload());

window.flyViz = V;          // handy in the devtools console
try { initGL(); connect(); } catch (e) { $('#msg').textContent = `can't draw the brain here: ${e.message}`; }
