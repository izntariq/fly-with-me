// The fly on the decks: named descending/motor neurons -> DJ moves.
//
// Every move is triggered by a burst (fast rate well above its own slow baseline) in real, named cell types.
// Which neurons drive which move is an artistic mapping; that they fire, and when, is the connectome model.
//
//   steering   left vs right descending neurons (+ DNa01/DNa02 x8)  -> which deck the fly turns toward
//   arousal    all ~1,300 descending neurons surging together        -> cue build & drop
//   escape     DNp01 giant fiber (escape jump; loud high sounds)     -> loop roll, or tape stop if it's a big burst
//   echo       DNp02 · DNp06 · DNp11 · DNp55                          -> echo / reverb throw
//   scratch    DNg24 · DNg29 (strongly driven by the ear)             -> baby / chirp / flare / transformer by intensity
//   trans      DNb06 · DNge113 · DNge145 (low-frequency hearing)      -> trans gate, crush on big bursts
//   flange     DNg99 · DNp73 · DNge130                                -> flanger sweep / low-pass dip
//   wind       DNp18 · DNpe017 · DNbe001 (wind & gravity pathway)     -> reverb wash + dub siren
//   reject     DNp42 · DNpe007 · DNge067 · MDN (bitter, walk backward)-> spinback and cut to the other deck
//   filters    DNp12 · DNb05 · DNg56 per side                          -> that deck's high-pass
//   sing       brain motor neurons (proboscis / pharynx; sugar)       -> fly voice swell + air horn
//
// Transitions start on 16-beat phrase lines; the style is picked by whichever group is most excited right then:
//   giant fiber -> drop swap (2-bar build, slam into the other deck's drop)   echo group -> echo out
//   aversion -> spinback cut                                                  otherwise -> long EQ blend with bass swap

export const MOVES = [
  { key: 'arousal', label: 'All descending neurons', cls: 'descending', action: 'cue build & drop', continuous: true },
  { key: 'escape', label: 'Giant fiber DNp01', types: ['DNp01'], action: 'loop roll · tape stop', ratio: 1.5, min: 4, cool: 24 },
  { key: 'echo', label: 'DNp02 · DNp06 · DNp11 · DNp55', types: ['DNp02', 'DNp06', 'DNp11', 'DNp55'], action: 'echo · reverb throw', ratio: 1.5, min: 4, cool: 24 },
  { key: 'scratch', label: 'DNg24 · DNg29', types: ['DNg24', 'DNg29'], action: 'scratch: baby · chirp · flare · transformer', ratio: 1.5, min: 4, cool: 32 },
  { key: 'trans', label: 'DNb06 · DNge113 · DNge145', types: ['DNb06', 'DNge113', 'DNge145'], action: 'trans gate · crush', ratio: 1.5, min: 4, cool: 32 },
  { key: 'flange', label: 'DNg99 · DNp73 · DNge130', types: ['DNg99', 'DNp73', 'DNge130'], action: 'flanger · low-pass dip', ratio: 1.5, min: 3, cool: 32 },
  { key: 'wind', label: 'Wind DNs: DNp18 · DNpe017 · DNbe001', types: ['DNp18', 'DNpe017', 'DNbe001'], action: 'reverb wash · dub siren', ratio: 1.6, min: 4, cool: 32 },
  { key: 'reject', label: 'Aversion: DNp42 · DNpe007 · DNge067 · MDN', types: ['DNp42', 'DNpe007', 'DNge067', 'MDN'], action: 'spinback → cut to other deck', ratio: 3, min: 10, cool: 32 },
  { key: 'filtL', label: 'Left DNp12 · DNb05 · DNg56', types: ['DNp12', 'DNb05', 'DNg56'], side: 'left', action: 'deck A high-pass', continuous: true },
  { key: 'filtR', label: 'Right DNp12 · DNb05 · DNg56', types: ['DNp12', 'DNb05', 'DNg56'], side: 'right', action: 'deck B high-pass', continuous: true },
  { key: 'sing', label: 'Brain motor neurons', cls: 'motor', action: 'fly voice swell · air horn', continuous: true },
  { key: 'steer', label: 'Steering DNa01 · DNa02', types: ['DNa01', 'DNa02'], action: 'crossfader weight', continuous: true },
];

import { camelotDistance, camelotName } from './analysis.js';
import { STYLES } from './djstyles.js';
import { ARCS, energyAt, trackIntensity } from './setplan.js';
import { SectionSense } from './sections.js';

// How the fly adapts its playing to the style of what's on air (detected for your own tracks).
//   cool: cooldown multiplier   build: how keen on build-ups   remap: swap a move for a better-fitting one
const PROFILE = {
  club: { cool: 1, build: 1 },
  desi: { cool: 1, build: 1 },
  hiphop: { cool: 1, build: 0.25, remap: { escape: 'scratch', trans: 'scratch' } },      // turntablism, not EDM builds
  dnb: { cool: 0.8, build: 1, remap: { scratch: 'escape' } },                           // fast rolls
  chill: { cool: 2, build: 0.2, remap: { escape: 'echo', trans: 'wind', scratch: 'echo' } }, // space, not chops
};
// in a breakdown (low energy) the fly reaches for space instead of chops
const BREAKDOWN = { escape: 'echo', scratch: 'wind', trans: 'flange' };
// with section sense: the kind of move that suits each section (DJ craft: effects with a purpose, in their place)
//   intro / outro: filter-type moves and space, no flourishes;  break: space;  verse: rhythmic;  chorus: anything
const SECTION_FIT = {
  intro: { escape: 'flange', scratch: 'flange', trans: 'flange' },
  outro: { escape: 'echo', scratch: 'echo', trans: 'flange' },
  break: { escape: 'echo', scratch: 'wind', trans: 'flange' },
};
// the big moves: on a 4-bar line in a chorus, now and then (every ~32 bars), a strong burst plays one of these instead
const BIG = { escape: 'chop', scratch: 'chop', echo: 'tease', trans: 'pump', flange: 'acid', wind: 'singalong' };

// A listener fly's section sense: its trained readout neurons, averaged over both sides (a listener hears one deck in
// both ears, as in training), z-scored and smoothed. Live levels sit offset from the offline ones, so each section is
// detected RELATIVE to this fly's own last ~3 minutes (where the current value ranks), with on/off hysteresis:
//   MIX  on in its top 20% (intros)      SPACE on in its top 10% (breakdowns)      PEAK off in its bottom 25%
const REL = { MIX: [0.8, 0.7], SPACE: [0.9, 0.8], PEAK: [0.3, 0.25] };   // [on above rank, off below rank]

class ListenerSense {
  constructor(readout, outputs) {
    const slotOf = new Map(outputs.map((o, i) => [o.id, i]));
    this.r = {};
    this.slot = new Map();
    for (const [name, spec] of Object.entries(readout || {})) {
      const ns = spec.neurons.map((n) => ({ slot: slotOf.get(n.id), mu: n.mu, sd: n.sd })).filter((n) => n.slot != null);
      this.r[name] = { ns, on: spec.on, off: spec.off, tau: spec.tau_s, rate: new Float32Array(ns.length), z: 0, active: false, hist: [] };
      ns.forEach((n, i) => { if (!this.slot.has(n.slot)) this.slot.set(n.slot, []); this.slot.get(n.slot).push([name, i]); });
    }
    this.isDN = outputs.map((o) => o.cls === 'descending');
    this.dnCount = 0;                                   // descending spikes this frame (how excited the fly is)
  }
  update(spikes, dtMs) {
    const dt = dtMs / 1000, a = Math.exp(-dtMs / 200), cnt = new Map();
    this.dnCount = 0;
    for (const [s] of spikes) { if (this.slot.has(s)) cnt.set(s, (cnt.get(s) || 0) + 1); if (this.isDN[s]) this.dnCount++; }
    const state = {};
    for (const [name, r] of Object.entries(this.r)) {
      let z = 0;
      r.ns.forEach((n, i) => { r.rate[i] = a * r.rate[i] + (1 - a) * (cnt.get(n.slot) || 0) / dt; z += (r.rate[i] - n.mu) / n.sd; });
      r.z += (z / Math.max(1, r.ns.length) - r.z) * dt / r.tau;
      // rank of the current value among the last ~3 min (sampled every 0.2 s)
      if ((this.tick = (this.tick || 0) + 1) % (10 * Object.keys(this.r).length) < Object.keys(this.r).length) { r.hist.push(r.z); if (r.hist.length > 900) r.hist.shift(); }
      const rank = r.hist.length > 150 ? r.hist.reduce((c, v) => c + (v < r.z), 0) / r.hist.length : 0.5;
      const [on, off] = REL[name] || [0.9, 0.8];
      r.rank = rank;
      r.active = name === 'PEAK' ? (r.active ? rank > off : rank > on) : (r.active ? rank > off : rank > on);
      state[name] = r.active;
    }
    this.state = state;
    return state;
  }
}

// beats a transition starts ahead of its phrase line, so the cut / drop itself lands on it: drop-swaps and double
// drops build for 2 bars from the bar after the start, a kill takes a bar, cuts / echoes / spins come in on the next bar
const cosine = (p, q) => { let d = 0, a = 0, b = 0; for (let k = 0; k < p.length; k++) { d += p[k] * q[k]; a += p[k] * p[k]; b += q[k] * q[k]; } return a && b ? d / Math.sqrt(a * b) : 0; };

const LEAD = { blend: 0, echo: 4, spin: 4, cut: 4, kill: 8, drop: 12, double: 12 };

export class FlyDJ {
  constructor(mixer, ears, synth, perf, outputs, log) {
    this.mixer = mixer; this.ears = ears; this.synth = synth; this.perf = perf; this.log = log;
    this.auto = true;
    this.epic = 0.6;          // 0 = chill selector, 1 = festival headliner
    this.moves = MOVES.map((m) => ({ ...m, slots: [], fast: 0, slow: 0, lastFire: -1e9, level: 0 }));
    // each group also keeps a rate per cell type in it, so the type that leads a burst can pick the move's variant
    for (const m of this.moves) if (m.types) { const n = m.types.length; Object.assign(m, { tN: new Float32Array(n), tCount: new Float32Array(n), tFast: new Float32Array(n), tSlow: new Float32Array(n) }); }
    const moveOf = outputs.map(() => []), typeIn = outputs.map(() => []);
    outputs.forEach((o, i) => this.moves.forEach((m, k) => {
      const typeOk = m.types ? m.types.includes(o.type) : true;
      const clsOk = m.cls ? o.cls === m.cls : true;
      const sideOk = m.side ? o.side === m.side : true;
      if (typeOk && clsOk && sideOk) { m.slots.push(i); moveOf[i].push(k); typeIn[i].push(m.types ? m.types.indexOf(o.type) : -1); if (m.types) m.tN[m.types.indexOf(o.type)]++; }
    }));
    this.moveOf = moveOf; this.typeIn = typeIn;
    // the descending neurons by cell type: a listener fly's response to a track as a pattern over types (track picks)
    const types = new Map();
    this.dnType = outputs.map((o) => (o.cls === 'descending' ? (types.has(o.type) ? types.get(o.type) : types.set(o.type, types.size).get(o.type)) : -1));
    this.nTypes = types.size;
    this.typeN = new Float32Array(this.nTypes);
    this.dnType.forEach((k) => { if (k >= 0) this.typeN[k]++; });
    // intent groups split by brain side: the ears are ~30x ipsilateral, so the left-side neurons hear deck A (left ear)
    // and the right-side ones deck B — section sense reads only the side of the deck that's on air
    this.sideKeys = ['echo', 'scratch', 'trans'];
    this.sideIdx = outputs.map((o, i) => {
      const k = this.sideKeys.findIndex((key) => this.moves.find((m) => m.key === key).slots.includes(i));
      return k < 0 ? -1 : k * 2 + (o.side === 'right' ? 1 : 0);
    });
    this.sideN = new Float32Array(6);
    this.sideIdx.forEach((j) => { if (j >= 0) this.sideN[j]++; });
    this.sideHz = new Float32Array(6);
    this.byKey = Object.fromEntries(this.moves.map((m) => [m.key, m]));
    this.sideOf = outputs.map((o) => (o.cls === 'descending' ? (o.side === 'left' ? -1 : o.side === 'right' ? 1 : 0) : 0));
    this.steerSlots = new Set(this.byKey.steer.slots);
    this.L = 0; this.R = 0; this.bias = 0; this.pref = 0; this.t = 0;
    this.arFast = 0; this.arSlow = 0;
    this.tempoOffset = 0;     // fractional tempo change the fly wants (arousal -> faster)
    this.commit = 0;          // direction of an in-progress blend (+1 toward B, -1 toward A)
    this.pending = null;      // {at, style, dir} transition scheduled on a phrase line
    this.userHold = 0;        // seconds of manual crossfader override remaining
    this.voiceLevel = 0.6;
    this.onLoadNext = null;   // (deckIdx) => void  (plain crate order, used when the fly isn't choosing)
    this.picker = null;       // {candidates(i, n), preview(i, track), choose(i, track, why)}
    this.aud = null;          // headphone audition in progress
    this.offAirSince = [0, 0];
    this.onAirSince = 0;
    this.minOnAir = 45;       // seconds a track stays on air before the fly may leave it (unless it runs out)
    this.phraseMoves = true;  // the fly's own moves wait for the next 4-bar line (DJs throw effects on the phrase)
    this.sectionFit = true;   // and pick a move that suits the sensed section
    this.queue = [];         // moves waiting for their slot on the phrase grid (one per group, up to 3)
    this.groupFires = {};     // recent fire times per neuron group (fairness)
    this.lastBig = -1e9;
    this.moveTarget = 8;      // moves per minute the fly aims for; the burst threshold adapts to reach it
    this.thr = 1;             // that adaptive threshold (x the burst ratio and minimum): < 1 = smaller bursts count
    this.moveTimes = [];
    this.slotLine = -1;
    this.lastAny = -1e9; this.lastBuild = -1e9; this.lastHorn = -1e9;
    this.onArrive = null;     // (deck, {snap, at}) => void — a new track is now the one on air
    this.trained = false;     // a brain trained by flybrain.train: its MIX neurons flag mixing windows
    // section sense from intent neurons, with detectors picked on the training tracks (docs/TRAINING.md):
    //   SPACE (echo group, trained only): 4 s rate ranks in the top 5% of the last 2 min  -> we're in a breakdown
    //   PEAK (scratch group): 4 s rate > 1.9x its 2-min average                         -> we're in a main section
    this.sense = { space: { f: [0, 0], hist: [[], []], on: false }, peak: { f: [0, 0], l: [0, 0], on: false },
                   mix: { f: [0, 0], s: [0, 0] } };
    this.persona = STYLES.fly; // "play like" DJ style: flavours which moves, transitions and builds the fly uses
    this.frameCounts = [];    // recent per-frame descending-neuron spike counts (for spike-driven chop patterns)
    this.mc = null;           // MC voice (mc.js)
    // the neurons decide more: when to leave an analysed track (steering), which track comes next (the pattern of
    // neurons it excites) and which variant of a move plays (the cell type that led the burst). Off: the designed rules
    this.neuronsDecide = true;
    this.leaveDrive = 0;      // the DJ fly's steering toward the other deck, held over ~8 s
  }

  setPersona(key) { this.persona = STYLES[key] || STYLES.fly; }

  // trained readout (brains/readout.json): for each section, the specific trained neurons that signal it, with the
  // z-score stats and on/off thresholds picked on the training tracks
  // chained mode: a listener fly per deck (trained readout) tells the DJ fly where each deck is in its track
  setListeners(readout, outputs) {
    this.listeners = [new ListenerSense(readout, outputs), new ListenerSense(readout, outputs)];
    const n = this.nTypes, F = () => new Float32Array(n);
    // per listener: this frame's rate per type and its long-run baseline (~3 min); the on-air track's print (~20 s)
    this.lp = n ? { frame: [F(), F()], base: [F(), F()], air: F(), t: 0 } : null;
  }
  // section sense v2 (sections.js): a classifier + arrangement prior per listener fly, on its deck's bar grid
  setSections(spec, outputs) { this.sections = this.mixer.decks.map((d) => new SectionSense(spec, outputs, d)); this.useSections = true; }
  sectionsOn() { return this.sections && this.useSections !== false ? this.sections : null; }
  // where a deck is in its track: the analysed song structure (tracks.js applyAnalysis) when the track has one,
  // otherwise what that deck's listener fly senses (sections.js)
  whereIs(deck) {
    const t = deck?.track;
    if (!t) return null;
    if (t.sections && this.useSections !== false) {
      const bar = Math.max(0, Math.min(t.sections.length - 1, Math.floor(deck.beatAt() / 4)));
      return { section: t.sections[bar], conf: 1, held: 99, frac: deck.position() / deck.duration, bar, known: true };
    }
    return this.sectionsOn()?.[this.mixer.decks.indexOf(deck)]?.state || null;
  }
  onListeners(outA, outB, dtMs) {
    this.sections?.forEach((s, i) => s.update(i ? outB : outA, dtMs));
    const L = this.listeners;
    if (!L) return;
    L[0].update(outA, dtMs); L[1].update(outB, dtMs);
    // track previews are scored by the listener fly of the deck being previewed
    const a = this.aud, now = this.mixer.ctx.currentTime;
    if (a && now - a.t0 > 1.2) { a.acc += L[a.deck].dnCount; a.n += dtMs / 1000; }
    if (this.lp) this.listenPrint([outA, outB], dtMs, a && now - a.t0 > 1.2 ? a : null);
  }
  // how each listener fly responds, as a rate per descending cell type, measured against its own long-run baseline:
  // the on-air track's print, and each auditioned candidate's
  listenPrint(outs, dtMs, aud) {
    const P = this.lp, dt = dtMs / 1000, n = this.nTypes;
    P.t += dt;
    const kb = Math.min(1, dt / Math.min(180, P.t)), ka = Math.min(1, dt / Math.min(20, P.t));   // warm up fast
    const on = this.mixer.onAir() === this.mixer.decks[0] ? 0 : 1;
    for (let i = 0; i < 2; i++) {
      const f = P.frame[i], b = P.base[i];
      f.fill(0);
      for (const [s] of outs[i]) { const k = this.dnType[s]; if (k >= 0) f[k]++; }
      for (let k = 0; k < n; k++) { f[k] /= dt * this.typeN[k]; b[k] += (f[k] - b[k]) * kb; }
    }
    for (let k = 0; k < n; k++) P.air[k] += (P.frame[on][k] - P.air[k]) * ka;
    if (aud) { aud.sum ||= new Float32Array(n); aud.frames = (aud.frames || 0) + 1; const f = P.frame[aud.deck]; for (let k = 0; k < n; k++) aud.sum[k] += f[k]; }
  }
  // the on-air track's print: how its listener's descending types fire, against that listener's baseline
  airPrint() {
    const P = this.lp;
    if (!P || P.t < 20) return null;
    const b = P.base[this.mixer.onAir() === this.mixer.decks[0] ? 0 : 1];
    return P.air.map((v, k) => v - b[k]);
  }

  setReadout(readout, outputs) {
    const slotOf = new Map(outputs.map((o, i) => [o.id, i]));
    this.readout = {};
    for (const [name, r] of Object.entries(readout || {})) {
      const ns = r.neurons.map((n) => ({ slot: slotOf.get(n.id), side: n.side === 'right' ? 1 : 0, mu: n.mu, sd: n.sd })).filter((n) => n.slot != null);
      this.readout[name] = { ns, on: r.on, off: r.off, tau: r.tau_s, rate: new Float32Array(ns.length), z: [0, 0], active: false };
    }
    this.readoutSlot = new Map();
    for (const [name, r] of Object.entries(this.readout)) r.ns.forEach((n, i) => this.readoutSlot.set(n.slot, [name, i]));
  }

  updateSense(dt) {
    const sp = this.sense.space, pk = this.sense.peak, mx = this.sense.mix, now0 = this.mixer.ctx.currentTime;
    const tick = (this._senseTick = (this._senseTick || 0) + 1) % 10 === 0;
    for (let side = 0; side < 2; side++) {
      const hz = (g) => this.sideHz[g * 2 + side];                // per-neuron rate on this side, this frame
      sp.f[side] += (hz(0) - sp.f[side]) * dt / 4;
      pk.f[side] += (hz(1) - pk.f[side]) * dt / 4; pk.l[side] += (hz(1) - pk.l[side]) * dt / 120;
      mx.f[side] += (hz(2) - mx.f[side]) * dt / 0.3; mx.s[side] += (hz(2) - mx.s[side]) * dt / 10;
      if (tick) { sp.hist[side].push(sp.f[side]); if (sp.hist[side].length > 600) sp.hist[side].shift(); }
    }
    // read the side of the on-air deck (split ears); in room mode both ears hear the same mix, so average them
    const split = this.ears.mode === 'split', side = this.mixer.onAir() === this.mixer.decks[0] ? 0 : 1;
    const pickF = (arr) => (split ? arr[side] : (arr[0] + arr[1]) / 2);
    const hist = split ? sp.hist[side] : sp.hist[0].map((v, i) => (v + (sp.hist[1][i] ?? v)) / 2);
    const cur = pickF(sp.f);
    const rank = hist.length > 150 ? hist.filter((v) => v < cur).length / hist.length : 0;
    let spaceOn = this.trained && rank > 0.95, peakOn = this.t > 30 && pickF(pk.f) > 1.9 * (pickF(pk.l) + 0.5);
    const LS = this.sectionsOn() || this.listeners;
    if (LS?.[0].state) {
      // chained flies: the on-air deck's own listener fly says where that track is (or its analysed structure)
      const known = (d) => { const w = this.whereIs(d); return w?.known ? { SPACE: w.section === 'break', MIX: w.section === 'intro' || w.section === 'outro', PEAK: w.section === 'chorus' } : null; };
      const st = known(this.mixer.decks[side]) || LS[side].state, other = known(this.mixer.decks[1 - side]) || LS[1 - side].state;
      spaceOn = !!st.SPACE; peakOn = this.t > 30 && !!st.PEAK;
      if (st.MIX) this.mixWindow = this.mixer.ctx.currentTime + 8 * this.beat();
      if (st.MIX && !this._mixOn) this.log(`<b>listener fly ${side ? 'B' : 'A'}</b> senses a <b>mixing window</b> (intro / outro) on the on-air deck${other.MIX ? ' — and the other deck is in one too' : ''}`);
      this._mixOn = !!st.MIX;
    } else if (this.readout?.SPACE) {
      // trained readout: z-scored rate of the chosen neurons (on-air side in split mode), 4 s smoothing, hysteresis
      const state = {};
      for (const [name, r] of Object.entries(this.readout)) {
        for (const sd of [0, 1]) {
          const idx = r.ns.map((n, i) => (n.side === sd ? i : -1)).filter((i) => i >= 0);
          const zNow = idx.length ? idx.reduce((acc, i) => acc + (r.rate[i] - r.ns[i].mu) / r.ns[i].sd, 0) / idx.length : 0;
          r.z[sd] += (zNow - r.z[sd]) * dt / r.tau;
        }
        const z = split ? r.z[side] : (r.z[0] + r.z[1]) / 2;
        r.active = r.active ? z > r.off : z > r.on;
        state[name] = r.active;
      }
      spaceOn = !!state.SPACE; peakOn = this.t > 30 && !!state.PEAK;
      if (state.MIX) this.mixWindow = this.mixer.ctx.currentTime + 8 * this.beat();   // held open while MIX is on
      if (state.MIX && !this._mixOn) this.log('<b>MIX neurons</b> (trained readout) sense a <b>mixing window</b>');
      this._mixOn = !!state.MIX;
    }
    // trained MIX neurons on the on-air side bursting → a mixing window (intro / outro) for the next 32 beats
    if (this.trained && !this.readout?.MIX && !this.listeners && pickF(mx.f) > pickF(mx.s) * 1.3 + 3) {
      const now = this.mixer.ctx.currentTime;
      if (!(now < this.mixWindow)) this.log('<b>MIX neurons</b> (trained, on-air side) burst → mixing window open');
      this.mixWindow = now + 32 * this.beat();
    }
    if (spaceOn && !sp.on) {
      this.log(this.listeners ? `<b>listener fly ${side ? 'B' : 'A'}</b> senses a <b>breakdown</b> on the on-air deck` : '<b>SPACE neurons</b> (trained) sense a <b>breakdown</b>');
      if (this.auto && this.t > 15 && !this.perf.busy() && !this.holdMoves() && now0 - (this.lastSpace || -1e9) > 16 * this.beat()) {
        this.lastSpace = now0; this.moveTimes.push(now0);
        this.doMove(this.mixer.onAir().hasStems && Math.random() < 0.3 ? 'drumsout' : (this.frameCounts.at(-1) % 2 ? 'reverb' : 'echo'), '<b>SPACE neurons</b>');
      }
    }
    sp.on = spaceOn; pk.on = peakOn;
  }
  // the fly on the mic; its latest spike count picks the phrase
  shout(kind = 'hype', delay = 0) {
    this.mc?.shout({ persona: this.persona.key === 'fly' ? null : this.persona, desi: this.mixer.onAir().track?.style === 'desi', kind, delay, pickN: this.frameCounts.at(-1) || 0 });
  }

  // ---------------- set planner ----------------
  startSet(arcKey, minutes) {
    const pts = ARCS[arcKey]?.points;
    this.arc = pts ? { key: arcKey, points: pts, start: this.mixer.ctx.currentTime, length: minutes * 60, last: null } : null;
  }
  arcEnergy(now = this.mixer.ctx.currentTime) {
    if (!this.arc) return null;
    return energyAt(this.arc.points, (now - this.arc.start) / this.arc.length);
  }
  // follow the plan: epicness tracks the arc; the fly builds into its peaks and breaks the music down in its dips
  tickArc(now) {
    const E = this.arcEnergy(now);
    if (E == null) return;
    this.epic = 0.1 + 0.9 * E;
    const a = this.arc, prev = a.last ?? E;
    a.last = E;
    if ((now - a.start) / a.length > 1) { this.log('📋 the set plan is complete — the fly plays on freely'); this.arc = null; return; }
    // rising through 0.9 → build into the peak; falling through 0.45 → a breakdown.
    // If the fly is busy when the arc crosses, the move waits until it's free (while the arc is still in that zone).
    if (prev < 0.9 && E >= 0.9) a.want = 'peak';
    if (prev > 0.45 && E <= 0.45) a.want = 'break';
    if (a.want === 'peak' && E < 0.8) a.want = null;
    if (a.want === 'break' && E > 0.55) a.want = null;
    if (a.want && !this.perf.busy() && !this.holdMoves()) {
      if (a.want === 'peak') {
        const pb = this.persona.build || {}, bars = this.buildBars(8);
        if (bars && this.perf.buildDrop({ kind: pb.kind || 'snare', bars, horn: pb.horn ?? true, who: '📋 <b>set plan: peak</b>' })) this.lastBuild = now;
      } else {
        this.doMove(this.mixer.onAir().hasStems ? 'drumsout' : 'singalong', '📋 <b>set plan: breakdown</b>');
      }
      a.want = null;
    }
  }
  // a 16-step chop pattern straight from the last 16 brain frames: busy frames play a slice, quiet ones rest
  spikePattern() {
    const c = this.frameCounts.slice(-16);
    if (c.length < 16) return null;
    const med = [...c].sort((a, b) => a - b)[8];
    return c.map((n) => (n > med ? n % 4 : -1));
  }

  profile() { return PROFILE[this.mixer.onAir().track?.style] || PROFILE.club; }
  // where the on-air track is: energy of the current bar, and whether we're just after one of its drops
  section() {
    const d = this.mixer.onAir(), t = d.track;
    if (!t) return { energy: 1, afterDrop: false };
    const beat = d.beatAt(), bar = Math.floor(beat / 4);
    const energy = t.energy ? t.energy[Math.max(0, Math.min(t.energy.length - 1, bar))] : 1;
    const afterDrop = (t.cues || []).some((c) => c.name.startsWith('drop') && beat - c.beat >= 0 && beat - c.beat < 32);
    return { energy, afterDrop };
  }

  get coolScale() { return 2 - 1.6 * this.epic; }
  ratioOf(m) { return 1 + (m.ratio - 1) * (1.4 - 0.8 * this.epic); }
  beat() { return 60 / (this.mixer.onAir().bpm || 120); }

  // one brain frame (20 ms)
  onFrame(spikes, dtMs) {
    const dt = dtMs / 1000;
    const counts = new Float32Array(this.moves.length);
    const sideC = new Float32Array(6);
    let L = 0, R = 0;
    for (const m of this.moves) m.tCount?.fill(0);
    for (const [s] of spikes) {
      const mk = this.moveOf[s];
      for (let j = 0; j < mk.length; j++) { counts[mk[j]]++; const ti = this.typeIn[s][j]; if (ti >= 0) this.moves[mk[j]].tCount[ti]++; }
      if (this.sideIdx[s] >= 0) sideC[this.sideIdx[s]]++;
      const w = this.steerSlots.has(s) ? 8 : 1;
      if (this.sideOf[s] < 0) L += w; else if (this.sideOf[s] > 0) R += w;
    }
    this.frameCounts.push(L + R); if (this.frameCounts.length > 64) this.frameCounts.shift();
    for (let j = 0; j < 6; j++) this.sideHz[j] = sideC[j] / dt / Math.max(1, this.sideN[j]);
    if (this.readout) {
      const cnt = new Map();
      for (const [s] of spikes) if (this.readoutSlot.has(s)) cnt.set(s, (cnt.get(s) || 0) + 1);
      const a = Math.exp(-dtMs / 200);
      for (const r of Object.values(this.readout)) r.ns.forEach((n, i) => { r.rate[i] = a * r.rate[i] + (1 - a) * (cnt.get(n.slot) || 0) / dt; });
    }
    const now = this.mixer.ctx.currentTime, beat = this.beat();
    const a = this.aud;
    if (a && !this.listeners && now - a.t0 > 1.2) { a.acc += a.deck === 0 ? L : R; a.n += dt; }
    this.moves.forEach((m, k) => {
      const hz = counts[k] / dt / Math.max(1, m.slots.length);
      m.fast += (hz - m.fast) * Math.min(1, dt / 0.3);
      m.slow += (hz - m.slow) * Math.min(1, dt / 10);
      m.level = Math.min(1, m.fast / 60);
      if (m.tCount) for (let j = 0; j < m.tCount.length; j++) {
        const th = m.tCount[j] / dt / Math.max(1, m.tN[j]);
        m.tFast[j] += (th - m.tFast[j]) * Math.min(1, dt / 0.3); m.tSlow[j] += (th - m.tSlow[j]) * Math.min(1, dt / 10);
      }
      if (!m.continuous && this.auto && this.t > 15 && m.slots.length && !this.perf.busy() && !this.holdMoves()) {
        const prof = this.profile(), cs = this.coolScale * prof.cool * (this.persona.cool || 1);
        const thr = this.phraseMoves ? this.thr : 1;
        // (a group's cooldown never drops below 2 bars, however low the pace threshold goes: no one trick every bar)
        if (m.fast > m.slow * (1 + (this.ratioOf(m) - 1) * thr) + m.min * thr && now - m.lastFire > Math.max(8 * beat, m.cool * beat * cs * Math.min(1, thr))
            && now - this.lastAny > (this.phraseMoves ? 2 : 4) * beat * cs) {
          const sec = this.section();
          let key = prof.remap?.[m.key] ?? m.key;
          if (sec.energy < 0.4 || this.sense.space.on) key = BREAKDOWN[key] ?? key;   // breakdown: space, not chops
          const ss = this.sectionFit ? this.whereIs(this.mixer.onAir()) : null;
          if (ss && ss.conf > 0.55) key = SECTION_FIT[ss.section]?.[key] ?? key;
          if (m.key === 'scratch' && !this.sense.peak.on && !(ss && (ss.section === 'chorus' || ss.section === 'verse'))) return;   // flourishes in full sections
          if (sec.afterDrop && key !== 'echo' && key !== 'reject') return;      // let the drop breathe
          m.lastFire = now; this.lastAny = now; m.fired = performance.now();
          // the cell type that leads the burst (the biggest surge over its own baseline)
          let lead = null;
          if (m.tFast) { let best = -1; m.tFast.forEach((f, j) => { const r = m.tN[j] ? f / (m.tSlow[j] + 1) : -1; if (r > best) { best = r; lead = j; } }); }
          const named = this.neuronsDecide && lead != null && m.types.length > 1;
          const mv = { key, group: m.key, label: named ? `${m.label} (${m.types[lead]} led)` : m.label, intensity: m.fast / (m.slow + 1), count: counts[k], lead, t: now };
          if (this.phraseMoves && key !== 'reject') {
            // one waiting move per group (the stronger burst wins), at most 3
            const same = this.queue.findIndex((q) => q.group === mv.group);
            if (same >= 0) { if (mv.intensity > this.queue[same].intensity) this.queue[same] = mv; }
            else this.queue.push(mv);
            this.queue.sort((p, q) => q.intensity - p.intensity); this.queue.length = Math.min(this.queue.length, 3);
          }
          else this.fire(mv.key, mv.label, mv.intensity, mv.count, mv.lead);
        }
      }
    });

    // queued moves play on the bar grid: one per slot, released on the last beat before the line so they land on it
    // (the Performer plays moves from the next beat). Choruses / main sections have a slot every bar, calmer sections
    // every 2 bars; stale moves (over 8 bars old) are dropped
    // pace: nudge the burst threshold toward the target rate (homeostasis, over ~half a minute)
    this.moveTimes = this.moveTimes.filter((t) => now - t < 60);
    const onA = this.mixer.onAir(), blocked = !this.auto || this.perf.busy() || this.holdMoves() || now < this.mixer.lockUntil || !onA.playing;
    if (this.t > 30 && !blocked) {                    // adapt only while the fly is free to play (no catch-up bursts)
      const target = this.moveTarget / ((this.persona.cool || 1) * this.profile().cool);
      const rate = this.moveTimes.length * 60 / Math.min(60, this.t - 15);
      this.thr = Math.max(0.25, Math.min(2, this.thr * Math.exp(0.01 * (rate - target) * dt)));
    }
    this.queue = this.queue.filter((q) => now - q.t < 32 * beat);
    if (this.queue.length && !blocked) {
      const on = onA, ss = this.whereIs(on);
      const full = ss ? ss.conf > 0.5 && (ss.section === 'chorus' || ss.section === 'main' || ss.section === 'verse') : this.sense.peak.on;
      const grid = full ? 4 : 8, b = on.beatAt(), line = Math.floor(b / grid);   // a slot every bar / every 2 bars
      if (((b % grid) + grid) % grid >= grid - 1 && line !== this.slotLine) {
        this.slotLine = line;
        // fairness: the strongest burst, discounted by how often its group has played lately
        const recent = (g) => (this.groupFires[g] || []).filter((t) => now - t < 120).length;
        let qi = 0, best = -1;
        this.queue.forEach((q, i) => { const sc = q.intensity / (1 + recent(q.group)); if (sc > best) { best = sc; qi = i; } });
        const q = this.queue.splice(qi, 1)[0];
        (this.groupFires[q.group] ||= []).push(now);
        this.moveTimes.push(now);
        const big = BIG[q.group], strong = q.intensity >= 1.8, phrase = (((b % 16) + 16) % 16) >= 15;
        if (big && strong && phrase && ss?.section === 'chorus' && !this.persona.moves && now - this.lastBig > 128 * beat * this.coolScale) {
          this.lastBig = now;
          this.doMove(big === 'tease' && on.hasStems ? 'drumsout' : big, `<b>${q.label}</b> (big burst ×${q.intensity.toFixed(1)})`);
        } else this.fire(q.key, q.label, q.intensity, q.count, q.lead);
      }
    }

    this.updateSense(dt);

    // arousal: the whole descending population surging relative to its recent past
    const ar = this.byKey.arousal;
    this.arFast += (ar.fast - this.arFast) * Math.min(1, dt / 1.5);
    this.arSlow += (ar.fast - this.arSlow) * Math.min(1, dt / 40);
    ar.level = Math.min(1, Math.max(0, (this.arFast / (this.arSlow + 1e-3) - 1) * 2));
    // tempo ride: an aroused fly pushes the tempo up, a calm one lets it sag (±6% at full epicness, slow)
    const want = (Math.min(1, (this.arFast / (this.arSlow + 1e-3) - 1) * 4) ) * 0.06 * (0.4 + 0.6 * this.epic);
    const E = this.arcEnergy();
    const plan = E == null ? 0 : (E - 0.5) * 0.05;                   // the set plan leans the tempo up to ±2.5%
    this.tempoOffset += (Math.max(-0.06, Math.min(0.06, want + plan)) - this.tempoOffset) * dt / 12;
    if (this.auto && this.t > 30 && !this.holdMoves() && !this.commit && !this.perf.busy()
        && this.arFast > this.arSlow * (1.5 - 0.3 * this.epic) && this.arFast - this.arSlow > 0.15
        && now - this.lastBuild > 64 * beat * this.coolScale / (this.profile().build * (this.persona.build?.often ?? 1)) && this.onAirSince > 20
        && !this.section().afterDrop) {
      this.lastBuild = now; ar.fired = performance.now();
      const pb = this.persona.build || {}, bars = this.buildBars((pb.bars || 4) * (this.epic > 0.75 ? 2 : 1)), on = this.mixer.onAir(), b = on.beatAt();
      const opts = { kind: pb.kind || 'roll', horn: pb.horn ?? true };
      // if the track has its own drop coming, time the build so it lands exactly there (and still before the exit)
      const drop = (on.track.cues || []).filter((c) => c.name.startsWith('drop')).map((c) => c.beat - b).filter((d) => d > bars * 4 + 2 && d < 96 && d + 4 <= this.exitRoom()).sort((x, y) => x - y)[0];
      const who = `<b>arousal surge</b> across ${ar.slots.length} descending neurons`;
      const Td = !bars ? null : drop != null ? this.perf.buildDrop({ ...opts, bars, startBeat: Math.round(b + drop) - bars * 4, who: who + ' (timed to the track\'s own drop)' })
                              : this.perf.buildDrop({ ...opts, bars, who });
      if (Td) this.lastAny = Td;
    }

    // sugar -> motor neurons -> the fly sings and hits the air horn
    const sing = this.byKey.sing;
    if (sing.fast > 8 && !this.singing) {
      this.singing = true;
      this.log('<b>motor neurons</b> (proboscis / pharynx) firing → the fly sings');
      this.shout('hype');
      const hype = this.persona.hype ?? ['horn'];
      if (this.auto && hype.length && now - this.lastHorn > 16 * beat) {
        this.lastHorn = now; this.perf.sample(hype[Math.floor(this.t) % hype.length], '<b>motor neurons</b>');
      }
    } else if (sing.fast < 2) this.singing = false;

    // steering preference
    this.L += (L / dt - this.L) * Math.min(1, dt / 2);
    this.R += (R / dt - this.R) * Math.min(1, dt / 2);
    const raw = (this.R - this.L) / (this.R + this.L + 40);
    this.t += dt;
    // cancel the fixed left/right asymmetry of the wiring (fast during the first 20 s of listening)
    this.bias += (raw - this.bias) * dt / (this.t < 20 ? 2 : Math.min(240, this.t));
    this.pref = Math.max(-1, Math.min(1, (raw - this.bias) * 2));
  }

  fire(key, label, intensity, count, lead = null) {
    const P = this.perf, who = `<b>${label}</b>`;
    // which variant of the family: the cell type that led the burst (neurons decide), else the spike count
    const pick = this.neuronsDecide && lead != null ? lead : count;
    if (!this.mixer.onAir().playing) return;
    // a DJ style maps each neuron group to its own moves, mild → wild; the burst's intensity picks one
    const list = this.persona.moves?.[key];
    if (list?.length) {
      const lvl = Math.min(0.999, Math.max(0, (intensity - 1.2) / 2.5));
      return this.doMove(list[Math.floor(lvl * list.length)], who);
    }
    switch (key) {
      case 'escape':
        if (intensity > 3) P.brake(who); else P.roll(intensity > 2 ? 0.125 : 0.25, 1, who);
        this.synth.zap(P.nextBeat());
        break;
      case 'echo': {          // each family rotates through its variants, never the same one twice in a row
        const v = this.variant(['echo', 'reverb', 'dub'], pick);
        if (v === 'dub') P.dub(who); else P.beatFx(v, intensity > 2 ? 2 : 1, who);
        break;
      }
      case 'scratch': P.scratch(intensity < 2 ? 'baby' : intensity < 2.6 ? 'chirp' : intensity < 3.2 ? 'flare' : 'transformer', 2, who); break;
      case 'trans': {
        const v = this.variant(['trans', 'crush', 'stutter'], intensity > 2.5 ? 1 : pick);
        if (v === 'stutter') P.stutter(who); else P.beatFx(v, v === 'crush' ? 2 : 1, who);
        break;
      }
      case 'flange': {
        const v = this.variant(['flanger', 'lpf', 'resfilter'], pick);
        if (v === 'resfilter') P.resFilter(who); else P.beatFx(v, 4, who);
        break;
      }
      case 'wind':
        P.beatFx(this.variant(['reverb', 'sweep'], pick), 2, who);
        if (intensity > 2.2) P.sample('siren', who);
        break;
      case 'reject': {
        // aversion shows as a low-pass dip now; the fly then wants off this track, which the mixing gate grants at the
        // next fitting place (a late breakdown, the outro) with a spinback, not mid-song
        P.beatFx('lpf', 4, `${who} (aversion${this.onAirSince < this.minOnAir ? ', but staying on this track' : ''})`);
        if (this.onAirSince >= this.minOnAir) this.averse = this.mixer.ctx.currentTime;
        break;
      }
    }
  }

  // pick a variant from a move family, starting from index i, but not the one played last
  variant(list, i) {
    let v = list[((i % list.length) + list.length) % list.length];
    if (v === this.lastVariant) v = list[(list.indexOf(v) + 1) % list.length];
    this.lastVariant = this.played = v;
    return v;
  }

  // beats left before the planned exit's decision line (4 bars ahead of mixBar) on an analysed track. A move must be
  // over by then: one that is still running (busy, crossfader lock) holds the exit, and the fly ends up past it
  exitRoom() {
    const on = this.mixer.onAir(), t = on.track;
    if (!t?.sections || t.mixBar == null || this.useSections === false || !this.mixer.offAir().playing) return Infinity;
    return (t.mixBar - 4) * 4 - on.beatAt();
  }
  // the bars a build may take so it (from the next bar line, plus its tail) is over before the exit; 0: no room
  buildBars(bars) {
    const room = this.exitRoom();
    while (bars > 2 && bars * 4 + 10 > room) bars = Math.max(2, Math.floor(bars / 2));
    return bars * 4 + 10 <= room ? bars : 0;
  }

  doMove(name, who) {
    const P = this.perf, fx = ['echo', 'reverb', 'flanger', 'trans', 'crush', 'lpf', 'sweep'];
    // phrase-long moves (beats, from the next bar line) that don't fit before the planned exit: a short throw instead
    const long = { mashup: 68, layer: 36, melodyout: 36, drumsout: 20, singalong: 20, acid: 20, chop: 12 }[name];
    if (long && long > this.exitRoom()) name = 'echo';
    this.moveName = name;                                 // what plays (for the benchmark's log)
    if (fx.includes(name)) return P.beatFx(name, name === 'flanger' || name === 'lpf' || name === 'sweep' ? 4 : name === 'reverb' ? 2 : 1, who);
    if (name.startsWith('roll')) return P.roll(1 / +name.slice(4), 1, who);
    if (['baby', 'chirp', 'flare', 'transformer', 'orbit', 'crab'].includes(name)) return P.scratch(name, 2, who);
    if (['horn', 'siren', 'laser', 'boom', 'riser', 'dhol', 'co2'].includes(name)) return P.sample(name, who);
    switch (name) {
      case 'brake': return P.brake(who);
      case 'backspin': return P.backspin(who);
      case 'chop': return P.chop({ bars: 2, pattern: this.spikePattern(), who });
      case 'stutter': return P.stutter(who);
      case 'reverse': return P.reverse(who);
      case 'tease': return P.bassTease(who);
      case 'layer': return P.layer({ bars: 8, who });
      case 'mashup': return P.mashup({ bars: 16, who });
      case 'drumsout': return P.drumsOut({ bars: 4, who });
      case 'melodyout': return P.melodyOut({ bars: 8, who }) || ((this.moveName = 'lpf'), P.beatFx('lpf', 4, who));
      case 'dub': return P.dub(who);
      case 'resfilter': return P.resFilter(who);
      case 'pump': return P.pump(who);
      case 'singalong': return P.singalong({ bars: 4, who });
      case 'fill': return P.fill(who);
      case 'acid': return P.acid({ bars: 4, pattern: this.spikePattern()?.map((d, k) => (d < 0 ? -1 : (d * 2 + k) % 8)), who });
    }
  }

  // the styles a transition may use (null: any). Beat-matched blends and double drops need a steady 4/4 grid on both
  // decks; at the planned exit of a track with a short outro there is no room to overlap either. Then the DJ cuts,
  // echoes or spins out. Late for the exit (the fly was busy), only the styles that still finish before the end
  // `exitBar`: the planned exit (mixBar) by default, or an earlier section boundary the neurons chose. That one must be
  // reached exactly (a style whose lead no longer fits is out; none left: no exit there)
  exitStyles(atExit, now = this.mixer.ctx.currentTime, exitBar = this.mixer.onAir().track?.mixBar) {
    const [on, off] = [this.mixer.onAir(), this.mixer.offAir()], t = on.track, planned = exitBar === t?.mixBar;
    const steady = t?.steady !== false && off.track?.steady !== false;
    let ok = steady && !(atExit && planned && t?.exit === 'echo') ? Object.keys(LEAD) : ['echo', 'spin', 'cut', 'kill', 'drop'];
    if (atExit && exitBar != null) {
      const b = on.beatAt(now + 0.2), toEnd = (on.duration - t.firstBeat) * t.bpm / 60 - b;
      ok = ok.filter((st) => (exitBar * 4 - b >= LEAD[st] || (planned && LEAD[st] + 4 + (st === 'blend' ? 32 : 8) <= toEnd))
        // a double drop plays both decks for 8+ bars after it lands: the outgoing track must still be there
        && (st !== 'double' || toEnd - Math.max(exitBar * 4 - b, LEAD[st] + 4) >= 36));
      if (!ok.length && planned) ok = ['cut'];
    }
    return ok;
  }
  // a section boundary in the second half of an analysed track, before its planned exit, whose decision line (4 bars
  // ahead) has come: where the neurons may choose to leave
  neuronExit(on, sec) {
    const S = on.track.sections, mixBar = on.track.mixBar ?? S.length;
    for (let b = sec.bar + 1; b <= sec.bar + 4; b++) if (b < mixBar && b >= S.length * 0.5 && S[b] !== S[b - 1]) return b;
    return null;
  }

  // the last 8 bars before an analysed track's planned exit belong to the transition: no new moves, so the performer
  // is free when the exit comes due
  holdMoves() {
    if (this.pending) return true;
    const on = this.mixer.onAir(), w = this.whereIs(on);
    return !!(w?.known && this.mixer.offAir().playing && w.bar >= (on.track.mixBar ?? Infinity) - 8);
  }

  // pick the transition style from whichever group is most excited right now (among `allowed`)
  chooseStyle(allowed = Object.keys(LEAD)) {
    const r = (k) => { const m = this.byKey[k]; return m.fast / (m.slow + 1); };
    const [on, off] = [this.mixer.onAir(), this.mixer.offAir()];
    const tp = (d) => this.mixer.tempoOf?.(d.track) ?? d.track.bpm;   // after the half / double-time fold
    const gap = on.track && off.track ? Math.abs(tp(off) / tp(on) - 1) : 0;
    const halfDouble = Math.abs(off.track?.bpm * 2 / on.track?.bpm - 1) < 0.06 || Math.abs(off.track?.bpm / 2 / on.track?.bpm - 1) < 0.06;
    const w = { blend: 1, echo: 1, drop: 1, spin: 1, cut: 0, double: 0, ...(this.persona.transitions || {}) };
    for (const k of Object.keys(LEAD)) if (!allowed.includes(k)) w[k] = 0;
    if (gap > (this.mixer.keylock ? 0.16 : 0.08) && !halfDouble) {                         // tempos too far apart to blend
      const st = w.cut > w.echo && w.cut > w.spin ? 'cut' : r('reject') * w.spin > r('echo') * w.echo ? 'spin' : 'echo';
      return allowed.includes(st) ? st : allowed[0];
    }
    const cands = [['drop', r('escape') * (0.6 + 0.6 * this.epic) * w.drop], ['echo', r('echo') * w.echo], ['spin', r('reject') * 0.8 * w.spin],
                   ['cut', r('trans') * w.cut], ['double', (1 + this.byKey.arousal.level) * w.double],
                   ['kill', r('flange') * (w.kill || 0)], ['blend', 1.25 * w.blend]];
    cands.sort((a, b) => b[1] - a[1]);
    return cands[0][1] > 0 ? cands[0][0] : allowed.includes('blend') ? 'blend' : allowed[0];
  }

  // when a transition in `style` starts (`at`) and lands (`landT`: the phrase line where the incoming deck's bar 0
  // comes in): on the analysed mix point (beat `mixPoint`) if it is still ahead by the style's lead, else on the next
  // 16-beat phrase line, or the next bar line when that would leave the transition no room before the end
  plan(onAir, style, now, mixPoint = null) {
    const lead = LEAD[style] ?? 4, b0 = onAir.beatAt(now + 0.2) + lead, t = onAir.track;
    const endBeat = (onAir.duration - t.firstBeat) * t.bpm / 60, need = style === 'blend' ? 32 : style === 'double' ? 36 : 8;
    let land = Math.ceil(b0 / 16) * 16;
    if (mixPoint != null && mixPoint >= b0 && mixPoint - b0 <= 16) land = mixPoint;
    else if (land + need > endBeat) land = Math.ceil(b0 / 4) * 4;
    const at = onAir.timeOfBeat(land - lead), beatLen = 60 / (onAir.bpm || 120);
    // blend length: the style's, but never longer than the outro / what's left of the track
    const left = (onAir.duration - onAir.position(at)) / onAir.rate;
    const blendBeats = Math.max(8, Math.min((this.persona.blendBars || 8) * 4, Math.floor(left / beatLen * 0.85)));
    return { at, landT: onAir.timeOfBeat(land), blendBeats };
  }

  // a cut to the other deck lands at ctx time `at` (the new track snaps the master tempo to its own)
  afterCut(at) {
    const [A, B] = this.mixer.decks;
    if (!A._manualEQ && !B._manualEQ) { A.setEQ('low', 0); B.setEQ('low', 0); }
    this.commit = 0;
    const incoming = this.mixer.offAir();
    if (at) this.onArrive?.(incoming, { snap: true, at });
  }

  // ~40 Hz control tick
  tick(dt) {
    const mx = this.mixer, [A, B] = mx.decks, now = mx.ctx.currentTime;
    // voice swell from motor neurons
    this.synth.setLevel(this.voiceLevel * (1 + Math.min(1.5, this.byKey.sing.fast / 20)));
    const onAir = mx.onAir();
    // time this track has been fully on air; a cut swaps decks instantly, so a new deck or track restarts it
    const fresh = onAir !== this._onAirDeck || onAir.track !== this._onAirTrack;
    // the deck that just left the air has had its turn with that track (if it played a while: a quick nudge of the
    // fader doesn't count): it gets a new one before it can be cued again. Tracked with the autopilot off too
    const left = this._onAirDeck;
    if (onAir !== left && left?.track && left.track === this._onAirTrack && this.onAirSince > 10) {
      left.spent = this._onAirTrack; left.reloadAt = null; this.offAirSince[mx.decks.indexOf(left)] = 0;
    }
    this._onAirDeck = onAir; this._onAirTrack = onAir.track;
    // a mashup or a double drop moves the fader off the end stop without changing the track on air: keep counting.
    // Only a blend in progress pauses the clock (the new track isn't fully in yet)
    this.onAirSince = fresh ? 0 : this.onAirSince + (mx.airness(onAir) > 0.99 || !this.commit ? dt : 0);
    // the DJ fly's wish to leave: its steering toward the other deck, held for a while (~8 s)
    this.leaveDrive = fresh ? 0 : this.leaveDrive + (Math.max(0, this.pref * (onAir === A ? 1 : -1)) - this.leaveDrive) * Math.min(1, dt / 8);
    if (!this.auto) { this.pending = null; return; }     // a transition lined up before you took over is forgotten

    // continuous filters from the low-frequency auditory pathway (relative to its own baseline)
    for (const [deck, k] of [[A, 'filtL'], [B, 'filtR']]) {
      const m = this.byKey[k];
      const target = Math.min(0.45, Math.max(0, (m.fast - m.slow * 1.3) / (m.slow * 3 + 15)));
      deck._autoFilt = (deck._autoFilt || 0) + (target - (deck._autoFilt || 0)) * Math.min(1, dt / 0.8);
      if (!deck._manualFilter) deck.setFilter(deck._autoFilt);
    }

    this.tickArc(now);
    if (this.userHold > 0) { this.userHold -= dt; return; }
    if (now < mx.lockUntil) return;
    const bothPlaying = A.playing && B.playing;
    const x = mx.x;
    const atEdge = x <= 0.001 || x >= 0.999;
    const beatLen = 60 / (onAir.bpm || 120);

    // 1. a phrase-aligned transition is waiting for its moment
    if (this.pending) {
      if (!bothPlaying) { this.pending = null; return; }
      if (this.pending.src && this.pending.src !== mx.onAir()) { this.pending = null; return; }   // decks changed under it
      if (now - this.pending.at > 0.25) {                  // overdue (held by a lock): the next line, not off the beat
        // (a missed early exit, at a boundary the neurons chose, goes on the next phrase line instead)
        const pd = this.pending, planned = pd.atExit && pd.exitBar === onAir.track?.mixBar, allowed = this.exitStyles(planned, now);
        if (!allowed.includes(pd.style)) pd.style = allowed.includes('cut') ? 'cut' : allowed[0];   // no room left for it
        const p = this.plan(onAir, pd.style, now, planned ? onAir.track.mixBar * 4 : null);
        pd.at = p.at; pd.landT = p.landT; pd.blendBeats = p.blendBeats; this.holdTempoUntil = p.landT + 0.02;
        this.cueIncoming(mx.offAir(), p.at, pd.style, p.landT);
        return;
      }
      if (now >= this.pending.at) {
        let { style, dir, landT } = this.pending, P = this.perf, who = '<b>the fly</b>';
        // a double drop runs both decks for up to 16 bars after landing: no longer than the outgoing track has left
        const fit = Math.min(16, Math.floor((onAir.duration - onAir.position(landT ?? now)) / onAir.rate / beatLen / 4) - 1);
        const bars = fit >= 4 ? Math.floor(fit / 4) * 4 : fit;          // whole phrases: the last cut lands on one
        if (style === 'double' && bars < 4) style = 'drop';
        this.blendBeats = this.pending.blendBeats;
        this.queue = [];                                  // moves queued for the old track don't spill into the new one
        this.pending = null;
        let at;
        if (style === 'echo' && (at = P.echoOut(who))) this.afterCut(at);
        else if (style === 'drop' && (at = P.dropSwap(who))) this.afterCut(at);
        else if (style === 'spin' && (at = P.spinCut(who))) this.afterCut(at);
        else if (style === 'cut' && (at = P.hardCut(who))) this.afterCut(at);
        else if (style === 'double' && (at = P.doubleDrop({ bars, who }))) this.afterCut(at);
        else if (style === 'kill' && (at = P.killDrop(who))) this.afterCut(at);
        else { this.commit = dir; mx.setCrossfader(x + dir * 0.13); this.log(`${who} starts a long EQ blend into deck ${dir > 0 ? 'B' : 'A'}`); }
      }
      return;
    }

    // 2. decide whether to leave the on-air deck
    const endingSoon = onAir.playing && onAir.duration - onAir.position() < 40 * beatLen;
    if (this.aud) this.tickAudition(now);
    const offPlayed = mx.offAir().track && mx.offAir().spent === mx.offAir().track;   // reloaded below first
    if (atEdge && bothPlaying && this.t > 20 && !this.perf.busy() && !this.aud && !offPlayed) {
      const onIdx = onAir === A ? 0 : 1, dir = onAir === A ? 1 : -1;
      const minOn = Math.max(this.persona.onAir?.[0] ?? 0, this.minOnAir);
      const maxOn = Math.max(this.persona.onAir?.[1] ?? Infinity, minOn);
      // trained brain: its MIX neurons (DNb06 · DNge113 · DNge145) learned to fire in intros and outros
      const mixReady = this.trained && now < this.mixWindow;
      const averse = now - (this.averse ?? -1e9) < 32 * beatLen && this.onAirSince >= minOn;   // the aversion neurons fired
      let wants = (this.pref * dir > 0.12 && this.ears.habit[onIdx] >= 0.3 && this.onAirSince >= minOn) || this.onAirSince > maxOn
        || (mixReady && this.onAirSince > minOn && this.ears.habit[onIdx] >= 0.1) || averse;
      let reason = endingSoon ? 'track ending' : averse ? 'aversion' : wants ? 'the fly wants the other deck' : '';
      let ending = endingSoon, atExit = false, exitBar = null;
      const sec = this.whereIs(onAir), mixBar = sec?.known ? onAir.track.mixBar ?? Infinity : null;
      const early = this.neuronsDecide && sec?.known && this.onAirSince >= minOn ? this.neuronExit(onAir, sec) : null;
      if (sec?.known) {
        // the analysed structure: mix out at the planned exit (track.mixBar: where the outro starts, or ~12 bars from
        // the end), deciding 4 bars ahead so even a 3-bar drop build lands on it. A fly that wants to leave earlier may
        // go from a breakdown in the last 40% of the track. Never mid-song otherwise (4-minute cap). No last-minute
        // "track ending" blend: the exit is planned so the mix finishes before the track does
        if (sec.bar >= mixBar - 4 && (this.onAirSince >= minOn || endingSoon)) {
          wants = true; atExit = true; exitBar = mixBar; reason = sec.bar < mixBar ? `the outro (bar ${mixBar}, analysed)` : 'past its planned exit';
        } else if (early != null && this.leaveDrive + (averse ? 0.5 : 0) > 0.12 && this.exitStyles(true, now, early).length) {
          // the neurons choose the exit: the DJ fly has kept turning toward the other deck, and a section starts here
          wants = true; atExit = true; exitBar = early;
          reason = `${averse ? 'aversion neurons fired, and ' : ''}the steering neurons turned toward the other deck (drive ${this.leaveDrive.toFixed(2)}): out at the ${onAir.track.sections[early]} (bar ${early}, analysed)`;
        } else if (!this.neuronsDecide && wants && sec.section === 'break' && sec.frac >= 0.6) reason = 'the fly wants to leave, in a late breakdown';
        else if (this.onAirSince > Math.max(240, minOn)) { wants = true; reason = '4 minutes on air'; }
        else wants = false;
        ending = false;
      } else if (sec) {
        // section sense: mix out of a sensed outro. A fly that wants to leave earlier waits for a confident, settled
        // breakdown in the second half of the track. Never mid-song otherwise, unless it has been on for 4 minutes
        // (about the length a DJ plays a track for)
        const outro = sec.section === 'outro' && sec.conf > 0.6;
        const brk = sec.section === 'break' && sec.conf >= 0.85 && sec.held >= 2 && sec.frac >= 0.7;
        if (outro && this.onAirSince >= minOn) { wants = true; reason = `sensed outro (${Math.round(100 * sec.conf)}%)`; }
        else if (wants && brk) reason = `the fly wants to leave and senses a breakdown (${Math.round(100 * sec.conf)}%)`;
        else if (this.onAirSince > Math.max(240, minOn)) { wants = true; reason = '4 minutes on air'; }
        else wants = false;
        if (endingSoon && !wants) reason = 'track ending';
      }

      if (wants || ending) {
        const allowed = this.exitStyles(atExit, now, exitBar ?? undefined);
        const style = ending && !wants ? (allowed.includes('blend') ? 'blend' : 'echo')
          : averse && allowed.includes('spin') ? 'spin' : this.chooseStyle(allowed);
        this.averse = null;
        const { at, landT, blendBeats } = this.plan(onAir, style, now, atExit ? exitBar * 4 : null);
        this.pending = { at, landT, style, dir, reason, src: onAir, blendBeats, atExit, exitBar };
        // the incoming deck's cue is a jump at a fixed time worked out from the on-air deck's tempo: hold the tempo
        // (ride, glide) still until it lands, or the two land out of phase
        this.holdTempoUntil = landT + 0.02;
        this.cueIncoming(mx.offAir(), at, style, landT);   // the incoming lands on the phrase line
        const why = { drop: 'giant fiber most excited', echo: 'echo neurons most excited', spin: 'aversion neurons most excited', cut: 'rhythm neurons most excited', double: 'whole brain aroused', kill: 'flanger neurons most excited', blend: 'calm' }[style];
        const names = { drop: 'drop-swap', echo: 'echo out', spin: 'spinback cut', cut: 'hard cut', double: 'double drop', kill: '1-bar kill', blend: 'blend' };
        this.log(`fly turns ${dir > 0 ? 'right' : 'left'} → will <b>${names[style]}</b> into deck ${dir > 0 ? 'B' : 'A'} on the next phrase: ${reason || 'its preference'} (${why}${this.persona.key !== 'fly' ? ', ' + this.persona.name + ' style' : ''})`);
        return;
      }
    }

    // 3. a blend in progress: move the fader, finish unless the fly strongly changes its mind
    if (this.commit && !bothPlaying) {                    // a deck stopped mid-blend: finish it now, on the one still playing
      mx.setCrossfader(A.playing !== B.playing ? (B.playing ? 1 : 0) : this.commit > 0 ? 1 : 0);
      this.commit = 0; this.afterCut(); this.onArrive?.(mx.onAir(), { snap: false });
      return;
    }
    if (this.commit && bothPlaying) {
      const speed = 1 / ((this.blendBeats || (this.persona.blendBars || 8) * 4) * beatLen);   // full fader travel
      let v = this.commit * speed;
      // it may change its mind only early in the blend; past that the new track comes in, no back-and-forth
      const done = this.commit > 0 ? x : 1 - x;
      if (this.pref * this.commit < -0.35 && done < 0.3) v = -this.commit * speed;
      const nx = Math.min(1, Math.max(0, x + v * dt));
      mx.setCrossfader(nx);
      this.bassSwap(nx, x);
      if (nx <= 0.001 || nx >= 0.999) { this.commit = 0; this.afterCut(); this.onArrive?.(mx.onAir(), { snap: false }); }
    }

    // keep the off-air deck stocked with a fresh, beat-matched track
    mx.decks.forEach((d, i) => {
      const off = mx.airness(d) < 0.01;
      if (!off) { this.offAirSince[i] = 0; return; }
      this.offAirSince[i] += dt;
      // a track that has been on air is replaced whatever is left of it: cued again, it would play from its intro twice
      const played = d.track && d.spent === d.track;
      const spent = !d.track || !d.playing || played || d.position() > d.duration - 45;
      const onLeft = (onAir.duration - onAir.position()) / (onAir.rate || 1);
      if (this.offAirSince[i] > 3 && spent && !this.pending && !this.aud && (onLeft > 90 || !d.track || !d.playing || played)) {
        this.offAirSince[i] = -1e9; d.reloadAt = now;
        if (this.picker && (onLeft > 30 || !played)) this.startAudition(i); else this.onLoadNext?.(i);   // no time to audition
      }
      // still the played track 10 s after asking for another (a load decodes first, so it can take a moment): nothing
      // new in the crate, it may come back
      if (played && !this.aud && now - (d.reloadAt ?? Infinity) > 10 && !this.loadPending?.(i)) d.spent = null;
    });
  }

  // Like a DJ cueing the next record: if the incoming deck would arrive too close to its end to stay on air for
  // minOnAir, jump it back (while it's still off air) by whole 16-beat phrases, which keeps it in phase with the mix.
  cueIncoming(off, at, style, land = at) {
    if (!off.track || !off.playing) return;
    const now = this.mixer.ctx.currentTime, beatLen = 60 / (off.bpm || 120);
    const trans = style === 'blend' ? (this.persona.blendBars || 8) * 4 * beatLen : 8 * beatLen;
    const need = (at - now) + trans + this.minOnAir + 48 * beatLen;              // wall seconds still to come
    const left = (off.duration - off.position()) / off.rate;
    // with section sense, blends and cuts bring the new track in from its intro, like a DJ cueing the first beat
    const toIntro = (this.sectionsOn() || off.track.sections) && style !== 'drop' && style !== 'double';
    if (toIntro) {                                        // its bar 0 lands exactly on the transition's phrase line
      off.jumpTo(land, off.track.firstBeat);
      this.log(`🎧 the fly cues deck ${off.name} to its first bar, to come in on the phrase`);
      return;
    }
    if (left >= need) return;
    const t = off.nextBarTime(), pos = off.position(t), phrase = 16 * 60 / off.track.bpm;
    const most = Math.floor((pos - off.track.firstBeat) / phrase);
    const k = toIntro ? most : Math.min(Math.ceil((need - left) * off.rate / phrase), most);
    if (k <= 0) return;
    off.jumpTo(t, pos - k * phrase);
    this.log(toIntro ? `🎧 the fly cues deck ${off.name} to its intro (back ${k * 4} bars)` : `🎧 the fly cues deck ${off.name} back ${k * 4} bars so the next track has room to play`);
  }

  // ---------------- track selection: preview candidates in the cue ear, keep the one the brain responds to most
  startAudition(i) {
    const cands = this.picker.candidates(i, 3);
    if (cands.length <= 1) { if (cands.length) this.picker.choose(i, cands[0]); else this.onLoadNext?.(i); return; }
    this.aud = { deck: i, cands, k: -1, scores: [] };
    this.log(`🎧 the fly cues up ${cands.length} tracks in its ${i === 0 ? 'left' : 'right'} ear to pick the next one`);
    this.nextCandidate();
  }
  nextCandidate() {
    const a = this.aud;
    a.k++;
    if (a.k >= a.cands.length) return this.finishAudition();
    a.t0 = this.mixer.ctx.currentTime; a.acc = 0; a.n = 0;
    this.picker.preview(a.deck, a.cands[a.k]);
  }
  tickAudition(now) {
    const a = this.aud, deck = this.mixer.decks[a.deck];
    if (this.mixer.airness(deck) > 0.01) { this.aud = null; return; }   // someone brought this deck on air: stop auditioning
    if (now - a.t0 < 5) return;
    const t = a.cands[a.k];
    t.score = a.acc / Math.max(0.1, a.n);          // spikes/s from that side's descending neurons
    a.scores.push(t.score);
    // and the pattern: this candidate's rate per descending type, against its listener's baseline
    const P = this.lp;
    (a.devs ||= []).push(P && a.sum && a.frames ? a.sum.map((v, k) => v / a.frames - P.base[a.deck][k]) : null);
    a.sum = null; a.frames = 0;
    window.renderCrate?.();
    this.nextCandidate();
  }
  finishAudition() {
    const a = this.aud;
    this.aud = null;
    // brain response, discounted for tracks it has already played, with a nudge for tracks that mix well
    // with what's on air: Camelot neighbours (harmonic mixing) and tempos within 6%
    const on = this.mixer.decks[1 - a.deck].track;
    // taste from the neurons: compare each candidate's pattern with the on-air track's. An aroused DJ fly (its
    // descending population above its slow baseline) keeps the sound going; a calm one changes it up
    const ref = this.neuronsDecide ? this.airPrint() : null;
    const lean = Math.max(-1, Math.min(1, (this.arFast / (this.arSlow + 1e-3) - 1) * 8));
    const sims = a.cands.map((t, k) => (ref && a.devs?.[k] ? cosine(ref, a.devs[k]) : null));
    const val = a.cands.map((t, k) => {
      const harm = on && camelotDistance(t.camelot, on.camelot) <= 1 ? 1.15 : 1;
      const tempo = on && Math.abs(t.bpm / on.bpm - 1) < 0.06 ? 1.1 : 1;
      // with a set plan, favour tracks whose intensity matches where the arc is heading (about a minute ahead)
      const E = this.arcEnergy(this.mixer.ctx.currentTime + 60);
      const fit = E == null ? 1 : 1.5 - Math.abs(trackIntensity(t) - E);
      const taste = sims[k] == null ? 1 : 1 + 0.5 * lean * sims[k];
      return a.scores[k] / (1 + 0.35 * (t.plays || 0)) * harm * tempo * fit * taste;
    });
    const best = val.indexOf(Math.max(...val)), pick = a.cands[best];
    const summary = a.cands.map((t, k) => `${t.name} ${a.scores[k].toFixed(0)}${sims[k] == null ? '' : ` (like on air ${sims[k] >= 0 ? '+' : ''}${sims[k].toFixed(2)})`}`).join(' · ');
    let why = on && camelotDistance(pick.camelot, on.camelot) <= 1 ? `, ${camelotName(pick.camelot)} mixes with ${camelotName(on.camelot)}` : '';
    if (sims.some((v) => v != null) && Math.abs(lean) > 0.2) why += lean > 0 ? ', the DJ fly is aroused: it keeps the sound going' : ', the DJ fly is calm: it changes it up';
    const Ep = this.arcEnergy(this.mixer.ctx.currentTime + 60);
    if (Ep != null) why += `, intensity ${trackIntensity(pick).toFixed(2)} for plan energy ${Ep.toFixed(2)}`;
    this.picker.choose(a.deck, pick, ` — <b>the fly's pick</b> (🎧 ${summary} spikes/s${why})`);
  }

  // classic bass swap: incoming deck's lows stay killed until the fader passes the middle
  bassSwap(x, prev) {
    const [A, B] = this.mixer.decks;
    if (A._manualEQ || B._manualEQ) return;
    if (x > 0.02 && x < 0.98) {
      const incomingIsB = this.commit >= 0;
      const inc = incomingIsB ? B : A, out = incomingIsB ? A : B;
      const passed = incomingIsB ? x >= 0.5 : x <= 0.5;
      if (passed) { inc.setEQ('low', 0); out.setEQ('low', -24); } else { inc.setEQ('low', -24); out.setEQ('low', 0); }
      if ((prev < 0.5) !== (x < 0.5)) this.log(`bass swap → deck ${passed ? inc.name : out.name} carries the low end`);
    }
  }
}
