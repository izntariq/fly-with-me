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
  { key: 'escape', label: 'Giant fiber DNp01', types: ['DNp01'], action: 'loop roll · tape stop', ratio: 1.5, min: 4, cool: 16 },
  { key: 'echo', label: 'DNp02 · DNp06 · DNp11 · DNp55', types: ['DNp02', 'DNp06', 'DNp11', 'DNp55'], action: 'echo · reverb throw', ratio: 1.4, min: 3, cool: 16 },
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

export class FlyDJ {
  constructor(mixer, ears, synth, perf, outputs, log) {
    this.mixer = mixer; this.ears = ears; this.synth = synth; this.perf = perf; this.log = log;
    this.auto = true;
    this.epic = 0.6;          // 0 = chill selector, 1 = festival headliner
    this.moves = MOVES.map((m) => ({ ...m, slots: [], fast: 0, slow: 0, lastFire: -1e9, level: 0 }));
    const moveOf = outputs.map(() => []);
    outputs.forEach((o, i) => this.moves.forEach((m, k) => {
      const typeOk = m.types ? m.types.includes(o.type) : true;
      const clsOk = m.cls ? o.cls === m.cls : true;
      const sideOk = m.side ? o.side === m.side : true;
      if (typeOk && clsOk && sideOk) { m.slots.push(i); moveOf[i].push(k); }
    }));
    this.moveOf = moveOf;
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
    this.lastAny = -1e9; this.lastBuild = -1e9; this.lastHorn = -1e9;
    this.onArrive = null;     // (deck, {snap, at}) => void — a new track is now the one on air
    this.persona = STYLES.fly; // "play like" DJ style: flavours which moves, transitions and builds the fly uses
    this.frameCounts = [];    // recent per-frame descending-neuron spike counts (for spike-driven chop patterns)
    this.mc = null;           // MC voice (mc.js)
  }

  setPersona(key) { this.persona = STYLES[key] || STYLES.fly; }
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
    if (a.want && !this.perf.busy() && !this.pending) {
      if (a.want === 'peak') {
        const pb = this.persona.build || {};
        if (this.perf.buildDrop({ kind: pb.kind || 'snare', bars: 8, horn: pb.horn ?? true, who: '📋 <b>set plan: peak</b>' })) this.lastBuild = now;
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
    let L = 0, R = 0;
    for (const [s] of spikes) {
      for (const k of this.moveOf[s]) counts[k]++;
      const w = this.steerSlots.has(s) ? 8 : 1;
      if (this.sideOf[s] < 0) L += w; else if (this.sideOf[s] > 0) R += w;
    }
    this.frameCounts.push(L + R); if (this.frameCounts.length > 64) this.frameCounts.shift();
    const now = this.mixer.ctx.currentTime, beat = this.beat();
    const a = this.aud;
    if (a && now - a.t0 > 1.2) { a.acc += a.deck === 0 ? L : R; a.n += dt; }
    this.moves.forEach((m, k) => {
      const hz = counts[k] / dt / Math.max(1, m.slots.length);
      m.fast += (hz - m.fast) * Math.min(1, dt / 0.3);
      m.slow += (hz - m.slow) * Math.min(1, dt / 10);
      m.level = Math.min(1, m.fast / 60);
      if (!m.continuous && this.auto && this.t > 15 && m.slots.length && !this.perf.busy() && !this.pending) {
        const prof = this.profile(), cs = this.coolScale * prof.cool * (this.persona.cool || 1);
        if (m.fast > m.slow * this.ratioOf(m) + m.min && now - m.lastFire > m.cool * beat * cs
            && now - this.lastAny > 4 * beat * cs) {
          const sec = this.section();
          let key = prof.remap?.[m.key] ?? m.key;
          if (sec.energy < 0.4) key = BREAKDOWN[key] ?? key;                   // breakdown: space, not chops
          if (sec.afterDrop && key !== 'echo' && key !== 'reject') return;      // let the drop breathe
          m.lastFire = now; this.lastAny = now; m.fired = performance.now();
          this.fire(key, m.label, m.fast / (m.slow + 1), counts[k]);
        }
      }
    });

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
    if (this.auto && this.t > 30 && !this.pending && !this.commit && !this.perf.busy()
        && this.arFast > this.arSlow * (1.5 - 0.3 * this.epic) && this.arFast - this.arSlow > 0.15
        && now - this.lastBuild > 64 * beat * this.coolScale / (this.profile().build * (this.persona.build?.often ?? 1)) && this.onAirSince > 20
        && !this.section().afterDrop) {
      this.lastBuild = now; ar.fired = performance.now();
      const pb = this.persona.build || {}, bars = (pb.bars || 4) * (this.epic > 0.75 ? 2 : 1), on = this.mixer.onAir(), b = on.beatAt();
      const opts = { kind: pb.kind || 'roll', horn: pb.horn ?? true };
      // if the track has its own drop coming, time the build so it lands exactly there
      const drop = (on.track.cues || []).filter((c) => c.name.startsWith('drop')).map((c) => c.beat - b).filter((d) => d > bars * 4 + 2 && d < 96).sort((x, y) => x - y)[0];
      const who = `<b>arousal surge</b> across ${ar.slots.length} descending neurons`;
      const Td = drop != null ? this.perf.buildDrop({ ...opts, bars, startBeat: Math.round(b + drop) - bars * 4, who: who + ' (timed to the track\'s own drop)' })
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

  fire(key, label, intensity, count) {
    const P = this.perf, who = `<b>${label}</b>`;
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
      case 'echo': P.beatFx(count % 2 ? 'reverb' : 'echo', intensity > 2 ? 2 : 1, who); break;
      case 'scratch': P.scratch(intensity < 2 ? 'baby' : intensity < 2.6 ? 'chirp' : intensity < 3.2 ? 'flare' : 'transformer', 2, who); break;
      case 'trans': P.beatFx(intensity > 2.5 ? 'crush' : 'trans', intensity > 2.5 ? 2 : 1, who); break;
      case 'flange': P.beatFx(count % 2 ? 'lpf' : 'flanger', 4, who); break;
      case 'wind':
        P.beatFx('reverb', 2, who);
        if (intensity > 2.2) P.sample('siren', who);
        break;
      case 'reject': {
        const at = P.spinCut(`${who} (aversion)`);
        if (at) this.afterCut(at);
        break;
      }
    }
  }

  doMove(name, who) {
    const P = this.perf, fx = ['echo', 'reverb', 'flanger', 'trans', 'crush', 'lpf', 'sweep'];
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
      case 'melodyout': return P.melodyOut({ bars: 8, who }) || P.beatFx('lpf', 4, who);
      case 'dub': return P.dub(who);
      case 'resfilter': return P.resFilter(who);
      case 'pump': return P.pump(who);
      case 'singalong': return P.singalong({ bars: 4, who });
      case 'fill': return P.fill(who);
      case 'acid': return P.acid({ bars: 4, pattern: this.spikePattern()?.map((d, k) => (d < 0 ? -1 : (d * 2 + k) % 8)), who });
    }
  }

  // pick the transition style from whichever group is most excited right now
  chooseStyle() {
    const r = (k) => { const m = this.byKey[k]; return m.fast / (m.slow + 1); };
    const [on, off] = [this.mixer.onAir(), this.mixer.offAir()];
    const gap = on.track && off.track ? Math.abs(off.track.bpm / on.track.bpm - 1) : 0;
    const halfDouble = Math.abs(off.track?.bpm * 2 / on.track?.bpm - 1) < 0.06 || Math.abs(off.track?.bpm / 2 / on.track?.bpm - 1) < 0.06;
    const w = { blend: 1, echo: 1, drop: 1, spin: 1, cut: 0, double: 0, ...(this.persona.transitions || {}) };
    if (gap > 0.08 && !halfDouble) {                                                       // tempos too far apart to blend
      if (w.cut > w.echo && w.cut > w.spin) return 'cut';
      return r('reject') * w.spin > r('echo') * w.echo ? 'spin' : 'echo';
    }
    const cands = [['drop', r('escape') * (0.6 + 0.6 * this.epic) * w.drop], ['echo', r('echo') * w.echo], ['spin', r('reject') * 0.8 * w.spin],
                   ['cut', r('trans') * w.cut], ['double', (1 + this.byKey.arousal.level) * w.double],
                   ['kill', r('flange') * (w.kill || 0)], ['blend', 1.25 * w.blend]];
    cands.sort((a, b) => b[1] - a[1]);
    return cands[0][0];
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
    if (!this.auto) return;

    // continuous filters from the low-frequency auditory pathway (relative to its own baseline)
    for (const [deck, k] of [[A, 'filtL'], [B, 'filtR']]) {
      const m = this.byKey[k];
      const target = Math.min(0.45, Math.max(0, (m.fast - m.slow * 1.3) / (m.slow * 3 + 15)));
      deck._autoFilt = (deck._autoFilt || 0) + (target - (deck._autoFilt || 0)) * Math.min(1, dt / 0.8);
      if (!deck._manualFilter) deck.setFilter(deck._autoFilt);
    }

    this.tickArc(now);
    const onAir = mx.onAir();
    this.onAirSince = mx.airness(onAir) > 0.99 ? this.onAirSince + dt : 0;
    if (this.userHold > 0) { this.userHold -= dt; return; }
    if (now < mx.lockUntil) return;
    const bothPlaying = A.playing && B.playing;
    const x = mx.x;
    const atEdge = x <= 0.001 || x >= 0.999;
    const beatLen = 60 / (onAir.bpm || 120);

    // 1. a phrase-aligned transition is waiting for its moment
    if (this.pending) {
      if (!bothPlaying) { this.pending = null; return; }
      if (now >= this.pending.at) {
        const { style, dir } = this.pending, P = this.perf, who = '<b>the fly</b>';
        this.pending = null;
        let at;
        if (style === 'echo' && (at = P.echoOut(who))) this.afterCut(at);
        else if (style === 'drop' && (at = P.dropSwap(who))) this.afterCut(at);
        else if (style === 'spin' && (at = P.spinCut(who))) this.afterCut(at);
        else if (style === 'cut' && (at = P.hardCut(who))) this.afterCut(at);
        else if (style === 'double' && (at = P.doubleDrop({ who }))) this.afterCut(at);
        else if (style === 'kill' && (at = P.killDrop(who))) this.afterCut(at);
        else { this.commit = dir; mx.setCrossfader(x + dir * 0.13); this.log(`${who} starts a long EQ blend into deck ${dir > 0 ? 'B' : 'A'}`); }
      }
      return;
    }

    // 2. decide whether to leave the on-air deck
    const endingSoon = onAir.playing && onAir.duration - onAir.position() < 40 * beatLen;
    if (this.aud) this.tickAudition(now);
    if (atEdge && bothPlaying && this.t > 20 && !this.perf.busy() && !this.aud) {
      const onIdx = onAir === A ? 0 : 1, dir = onAir === A ? 1 : -1;
      const [minOn, maxOn] = this.persona.onAir || [0, Infinity];
      const wants = (this.pref * dir > 0.12 && this.ears.habit[onIdx] >= 0.3 && this.onAirSince >= minOn) || this.onAirSince > maxOn;
      if (wants || endingSoon) {
        const style = endingSoon && !wants ? 'blend' : this.chooseStyle();
        // start on the next 16-beat phrase line (a bar early for cuts, so the cut itself lands on the phrase)
        const phraseBeat = Math.ceil(onAir.beatAt(now + 0.2) / 16) * 16;
        const lead = style === 'blend' ? 0 : style === 'drop' || style === 'double' || style === 'kill' ? 8 : 4;
        let at = onAir.timeOfBeat(phraseBeat - lead);
        if (at < now + 0.1) at = onAir.timeOfBeat(phraseBeat + 16 - lead);
        this.pending = { at, style, dir };
        const why = { drop: 'giant fiber most excited', echo: 'echo neurons most excited', spin: 'aversion neurons most excited', cut: 'rhythm neurons most excited', double: 'whole brain aroused', kill: 'flanger neurons most excited', blend: 'calm' }[style];
        const names = { drop: 'drop-swap', echo: 'echo out', spin: 'spinback cut', cut: 'hard cut', double: 'double drop', kill: '1-bar kill', blend: 'blend' };
        this.log(`fly turns ${dir > 0 ? 'right' : 'left'} (pref ${this.pref.toFixed(2)}) → will <b>${names[style]}</b> into deck ${dir > 0 ? 'B' : 'A'} on the next phrase (${why}${this.persona.key !== 'fly' ? ', ' + this.persona.name + ' style' : ''})`);
        return;
      }
    }

    // 3. a blend in progress: move the fader, finish unless the fly strongly changes its mind
    if (this.commit && bothPlaying) {
      const speed = 1 / ((this.persona.blendBars || 8) * 4 * beatLen);       // full fader travel over blendBars
      let v = this.commit * speed;
      if (this.pref * this.commit < -0.35) v = -this.commit * speed;
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
      const spent = !d.track || !d.playing || d.position() > d.duration * 0.55;
      if (this.offAirSince[i] > 3 && spent && !this.pending && !this.aud) {
        this.offAirSince[i] = -1e9;
        if (this.picker) this.startAudition(i); else this.onLoadNext?.(i);
      }
    });
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
    window.renderCrate?.();
    this.nextCandidate();
  }
  finishAudition() {
    const a = this.aud;
    this.aud = null;
    // brain response, discounted for tracks it has already played, with a nudge for tracks that mix well
    // with what's on air: Camelot neighbours (harmonic mixing) and tempos within 6%
    const on = this.mixer.decks[1 - a.deck].track;
    const val = a.cands.map((t, k) => {
      const harm = on && camelotDistance(t.camelot, on.camelot) <= 1 ? 1.15 : 1;
      const tempo = on && Math.abs(t.bpm / on.bpm - 1) < 0.06 ? 1.1 : 1;
      // with a set plan, favour tracks whose intensity matches where the arc is heading (about a minute ahead)
      const E = this.arcEnergy(this.mixer.ctx.currentTime + 60);
      const fit = E == null ? 1 : 1.5 - Math.abs(trackIntensity(t) - E);
      return a.scores[k] / (1 + 0.35 * (t.plays || 0)) * harm * tempo * fit;
    });
    const best = val.indexOf(Math.max(...val)), pick = a.cands[best];
    const summary = a.cands.map((t, k) => `${t.name} ${a.scores[k].toFixed(0)}`).join(' · ');
    let why = on && camelotDistance(pick.camelot, on.camelot) <= 1 ? `, ${camelotName(pick.camelot)} mixes with ${camelotName(on.camelot)}` : '';
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
