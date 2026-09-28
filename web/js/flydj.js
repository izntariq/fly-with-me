// The fly on the decks: named descending/motor neurons -> DJ moves.
//
// Every control here is read from real spikes of real, named cell types:
//   steering    all left vs right descending neurons (+ DNa01/DNa02 steering neurons x8)
//               -> which deck the fly "turns toward" -> crossfader
//   escape      DNp01 giant fiber (the escape-jump command neuron; driven by loud high-frequency sound)
//               -> loop roll stutter + zap
//   echo        DNp02 / DNp06 / DNp11 / DNp55 (giant-fiber-adjacent, auditory-driven)
//               -> echo throw
//   reject      DNp42 / DNpe007 / DNge067 (bitter-responsive) + MDN (moonwalker: walk backwards)
//               -> backspin and cut to the other deck
//   filters     DNp12 / DNb05 / DNg56 per side (low-frequency JO-B pathway)
//               -> high-pass sweep on that side's deck
//   sing        brain motor neurons (proboscis / pharynx / antenna, driven by sugar)
//               -> fly synth voice swells

export const MOVES = [
  { key: 'escape', label: 'Giant fiber', types: ['DNp01'], action: 'beat-roll stutter', ratio: 2.2, min: 6, cool: 8 },
  { key: 'echo', label: 'DNp02 · DNp06 · DNp11 · DNp55', types: ['DNp02', 'DNp06', 'DNp11', 'DNp55'], action: 'echo throw', ratio: 2.0, min: 8, cool: 8 },
  { key: 'reject', label: 'Aversion: DNp42 · DNpe007 · DNge067 · MDN', types: ['DNp42', 'DNpe007', 'DNge067', 'MDN'], action: 'backspin → switch deck', ratio: 3, min: 10, cool: 32 },
  { key: 'filtL', label: 'Left DNp12 · DNb05 · DNg56', types: ['DNp12', 'DNb05', 'DNg56'], side: 'left', action: 'deck A high-pass', continuous: true },
  { key: 'filtR', label: 'Right DNp12 · DNb05 · DNg56', types: ['DNp12', 'DNb05', 'DNg56'], side: 'right', action: 'deck B high-pass', continuous: true },
  { key: 'sing', label: 'Brain motor neurons', cls: 'motor', action: 'fly voice swell', continuous: true },
  { key: 'steer', label: 'Steering DNa01 · DNa02', types: ['DNa01', 'DNa02'], action: 'crossfader weight', continuous: true },
];

export class FlyDJ {
  constructor(mixer, ears, synth, outputs, log) {
    this.mixer = mixer; this.ears = ears; this.synth = synth; this.log = log;
    this.auto = true;
    this.moves = MOVES.map((m) => ({ ...m, slots: [], fast: 0, slow: 0, lastFire: -1e9, level: 0 }));
    const moveOf = outputs.map(() => []);
    outputs.forEach((o, i) => this.moves.forEach((m, k) => {
      const typeOk = m.types ? m.types.includes(o.type) : true;
      const clsOk = m.cls ? o.cls === m.cls : true;
      const sideOk = m.side ? o.side === m.side : true;
      if (typeOk && clsOk && sideOk) { m.slots.push(i); moveOf[i].push(k); }
    }));
    this.moveOf = moveOf;
    this.sideOf = outputs.map((o) => (o.cls === 'descending' ? (o.side === 'left' ? -1 : o.side === 'right' ? 1 : 0) : 0));
    this.steerSlots = new Set(this.moves.find((m) => m.key === 'steer').slots);
    this.L = 0; this.R = 0; this.bias = 0; this.pref = 0; this.t = 0;
    this.commit = 0;          // direction of an in-progress transition (+1 toward B, -1 toward A)
    this.forceSpeed = 0;      // fast cut after rejection
    this.userHold = 0;        // seconds of manual crossfader override remaining
    this.voiceLevel = 0.45;
    this.onLoadNext = null;   // (deckIdx) => void
    this.offAirSince = [0, 0];
  }

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
    const now = this.mixer.ctx.currentTime;
    this.moves.forEach((m, k) => {
      const hz = counts[k] / dt / Math.max(1, m.slots.length);
      m.fast += (hz - m.fast) * Math.min(1, dt / 0.3);
      m.slow += (hz - m.slow) * Math.min(1, dt / 10);
      m.level = Math.min(1, m.fast / 60);
      if (!m.continuous && this.auto && m.slots.length) {
        const beat = 60 / (this.mixer.onAir().bpm || 120);
        if (m.fast > m.slow * m.ratio + m.min && now - m.lastFire > m.cool * beat) {
          m.lastFire = now; m.fired = performance.now();
          this.fire(m);
        }
      }
    });
    // steering preference
    this.L += (L / dt - this.L) * Math.min(1, dt / 2);
    this.R += (R / dt - this.R) * Math.min(1, dt / 2);
    const raw = (this.R - this.L) / (this.R + this.L + 40);
    this.t += dt;
    this.bias += (raw - this.bias) * dt / Math.min(240, 20 + this.t);   // cancel fixed left/right wiring asymmetry
    this.pref = Math.max(-1, Math.min(1, (raw - this.bias) * 2));
  }

  fire(m) {
    const on = this.mixer.onAir(), off = this.mixer.offAir();
    if (!on.playing) return;
    const at = on.nextBeatTime(1);
    if (m.key === 'escape') {
      on.loopRoll(at, 0.25, 1); this.synth.zap(at);
      this.log(`<b>Giant fiber DNp01</b> fired: escape reflex → beat roll on deck ${on.name}`);
    } else if (m.key === 'echo') {
      on.echoThrow(at, 1);
      this.log(`<b>${m.label}</b> burst → echo throw on deck ${on.name}`);
    } else if (m.key === 'reject') {
      if (!off.playing) return;
      on.backspin(at, 2);
      this.forceSpeed = 0.5; this.commit = on === this.mixer.decks[0] ? 1 : -1;
      this.log(`<b>Aversion neurons</b> fired: the fly rejects "${on.track.name}" → backspin, cut to deck ${off.name}`);
    }
  }

  // ~40 Hz control tick
  tick(dt) {
    const mx = this.mixer, [A, B] = mx.decks;
    const move = (k) => this.moves.find((m) => m.key === k);
    // voice swell from motor neurons
    const sing = move('sing');
    this.synth.setLevel(this.voiceLevel * (1 + Math.min(1.5, sing.fast / 20)));
    if (!this.auto) return;

    // continuous filters from the low-frequency auditory pathway (relative to its own baseline)
    for (const [deck, k] of [[A, 'filtL'], [B, 'filtR']]) {
      const m = move(k);
      const target = Math.min(0.45, Math.max(0, (m.fast - m.slow * 1.3) / (m.slow * 3 + 15)));
      deck._autoFilt = (deck._autoFilt || 0) + (target - (deck._autoFilt || 0)) * Math.min(1, dt / 0.8);
      if (!deck._manualFilter) deck.setFilter(deck._autoFilt);
    }

    // crossfader
    if (this.userHold > 0) { this.userHold -= dt; return; }
    const bothPlaying = A.playing && B.playing;
    let x = mx.x, v = 0;
    const onAir = mx.onAir();
    const endingSoon = onAir.playing && onAir.duration - onAir.position() < 32 * 60 / onAir.bpm;
    if (this.forceSpeed > 0 && bothPlaying) {
      v = this.commit * this.forceSpeed;
    } else if (bothPlaying) {
      const p = this.pref, dz = 0.12;
      if (Math.abs(p) > dz) v = (p - Math.sign(p) * dz) * 0.2;
      if (x > 0.12 && x < 0.88) {
        // mid-transition: commit and finish it unless the fly strongly changes its mind
        if (!this.commit) this.commit = Math.sign(v || (x < 0.5 ? 1 : -1));
        if (Math.sign(v) !== this.commit && Math.abs(p) < 0.35) v = this.commit / 16;
        else if (Math.sign(v) === this.commit) v = this.commit * Math.max(Math.abs(v), 1 / 16);
      }
      if (endingSoon) v = onAir === A ? 1 / 12 : -1 / 12;
    }
    const nx = Math.min(1, Math.max(0, x + v * dt));
    if (nx !== x) {
      if ((x < 0.12 || x > 0.88) && nx >= 0.12 && nx <= 0.88) {
        this.log(`fly turns ${nx > x ? 'right' : 'left'} (pref ${this.pref.toFixed(2)}) → mixing into deck ${nx > x ? 'B' : 'A'}`);
      }
      mx.setCrossfader(nx);
      this.bassSwap(nx, x);
    }
    if (nx <= 0.001 || nx >= 0.999) { this.commit = 0; this.forceSpeed = 0; }

    // keep the off-air deck stocked with a fresh, beat-matched track
    mx.decks.forEach((d, i) => {
      const off = mx.airness(d) < 0.01;
      if (!off) { this.offAirSince[i] = 0; return; }
      this.offAirSince[i] += dt;
      const spent = !d.track || !d.playing || d.position() > d.duration * 0.55;
      if (this.offAirSince[i] > 3 && spent && !d._loading) { this.offAirSince[i] = -1e9; this.onLoadNext?.(i); }
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
    } else {
      A.setEQ('low', 0); B.setEQ('low', 0);
    }
  }
}
