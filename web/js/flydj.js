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
    this.commit = 0;          // direction of an in-progress blend (+1 toward B, -1 toward A)
    this.pending = null;      // {at, style, dir} transition scheduled on a phrase line
    this.userHold = 0;        // seconds of manual crossfader override remaining
    this.voiceLevel = 0.6;
    this.onLoadNext = null;   // (deckIdx) => void
    this.offAirSince = [0, 0];
    this.onAirSince = 0;
    this.lastAny = -1e9; this.lastBuild = -1e9; this.lastHorn = -1e9;
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
    const now = this.mixer.ctx.currentTime, beat = this.beat();
    this.moves.forEach((m, k) => {
      const hz = counts[k] / dt / Math.max(1, m.slots.length);
      m.fast += (hz - m.fast) * Math.min(1, dt / 0.3);
      m.slow += (hz - m.slow) * Math.min(1, dt / 10);
      m.level = Math.min(1, m.fast / 60);
      if (!m.continuous && this.auto && m.slots.length && !this.perf.busy() && !this.pending) {
        if (m.fast > m.slow * this.ratioOf(m) + m.min && now - m.lastFire > m.cool * beat * this.coolScale
            && now - this.lastAny > 4 * beat * this.coolScale) {
          m.lastFire = now; this.lastAny = now; m.fired = performance.now();
          this.fire(m, m.fast / (m.slow + 1), counts[k]);
        }
      }
    });

    // arousal: the whole descending population surging relative to its recent past
    const ar = this.byKey.arousal;
    this.arFast += (ar.fast - this.arFast) * Math.min(1, dt / 1.5);
    this.arSlow += (ar.fast - this.arSlow) * Math.min(1, dt / 40);
    ar.level = Math.min(1, Math.max(0, (this.arFast / (this.arSlow + 1e-3) - 1) * 2));
    if (this.auto && this.t > 30 && !this.pending && !this.commit && !this.perf.busy()
        && this.arFast > this.arSlow * (1.5 - 0.3 * this.epic) && this.arFast - this.arSlow > 0.15
        && now - this.lastBuild > 64 * beat * this.coolScale && this.onAirSince > 20) {
      this.lastBuild = now; ar.fired = performance.now();
      const bars = this.epic > 0.75 ? 8 : 4;
      if (this.perf.buildDrop({ bars, who: `<b>arousal surge</b> across ${ar.slots.length} descending neurons` })) this.lastAny = now + bars * 4 * beat;
    }

    // sugar -> motor neurons -> the fly sings and hits the air horn
    const sing = this.byKey.sing;
    if (sing.fast > 8 && !this.singing) {
      this.singing = true;
      this.log('<b>motor neurons</b> (proboscis / pharynx) firing → the fly sings');
      if (this.auto && now - this.lastHorn > 16 * beat) { this.lastHorn = now; this.perf.sample('horn', '<b>motor neurons</b>'); }
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

  fire(m, intensity, count) {
    const P = this.perf, who = `<b>${m.label}</b>`;
    if (!this.mixer.onAir().playing) return;
    switch (m.key) {
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
      case 'reject':
        if (P.spinCut(`${who} (aversion)`)) this.afterCut();
        break;
    }
  }

  // pick the transition style from whichever group is most excited right now
  chooseStyle() {
    const r = (k) => { const m = this.byKey[k]; return m.fast / (m.slow + 1); };
    const cands = [['drop', r('escape') * (0.6 + 0.6 * this.epic)], ['echo', r('echo')], ['spin', r('reject') * 0.8], ['blend', 1.25]];
    cands.sort((a, b) => b[1] - a[1]);
    return cands[0][0];
  }

  afterCut() {
    const [A, B] = this.mixer.decks;
    if (!A._manualEQ && !B._manualEQ) { A.setEQ('low', 0); B.setEQ('low', 0); }
    this.commit = 0;
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
        if (style === 'echo' && P.echoOut(who)) this.afterCut();
        else if (style === 'drop' && P.dropSwap(who)) this.afterCut();
        else if (style === 'spin' && P.spinCut(who)) this.afterCut();
        else { this.commit = dir; mx.setCrossfader(x + dir * 0.13); this.log(`${who} starts a long EQ blend into deck ${dir > 0 ? 'B' : 'A'}`); }
      }
      return;
    }

    // 2. decide whether to leave the on-air deck
    const endingSoon = onAir.playing && onAir.duration - onAir.position() < 40 * beatLen;
    if (atEdge && bothPlaying && this.t > 20 && !this.perf.busy()) {
      const onIdx = onAir === A ? 0 : 1, dir = onAir === A ? 1 : -1;
      const wants = this.pref * dir > 0.12 && this.ears.habit[onIdx] >= 0.3;
      if (wants || endingSoon) {
        const style = endingSoon && !wants ? 'blend' : this.chooseStyle();
        // start on the next 16-beat phrase line (a bar early for cuts, so the cut itself lands on the phrase)
        const phraseBeat = Math.ceil(onAir.beatAt(now + 0.2) / 16) * 16;
        const lead = style === 'blend' ? 0 : style === 'drop' ? 8 : 4;
        let at = onAir.timeOfBeat(phraseBeat - lead);
        if (at < now + 0.1) at = onAir.timeOfBeat(phraseBeat + 16 - lead);
        this.pending = { at, style, dir };
        const why = { drop: 'giant fiber most excited', echo: 'echo neurons most excited', spin: 'aversion neurons most excited', blend: 'calm' }[style];
        this.log(`fly turns ${dir > 0 ? 'right' : 'left'} (pref ${this.pref.toFixed(2)}) → will <b>${{ drop: 'drop-swap', echo: 'echo out', spin: 'spinback cut', blend: 'blend' }[style]}</b> into deck ${dir > 0 ? 'B' : 'A'} on the next phrase (${why})`);
        return;
      }
    }

    // 3. a blend in progress: move the fader, finish unless the fly strongly changes its mind
    if (this.commit && bothPlaying) {
      let v = this.commit / 16;
      if (this.pref * this.commit < -0.35) v = -this.commit / 16;
      const nx = Math.min(1, Math.max(0, x + v * dt));
      mx.setCrossfader(nx);
      this.bassSwap(nx, x);
      if (nx <= 0.001 || nx >= 0.999) { this.commit = 0; this.afterCut(); }
    }

    // keep the off-air deck stocked with a fresh, beat-matched track
    mx.decks.forEach((d, i) => {
      const off = mx.airness(d) < 0.01;
      if (!off) { this.offAirSince[i] = 0; return; }
      this.offAirSince[i] += dt;
      const spent = !d.track || !d.playing || d.position() > d.duration * 0.55;
      if (this.offAirSince[i] > 3 && spent && !this.pending) { this.offAirSince[i] = -1e9; this.onLoadNext?.(i); }
    });
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
