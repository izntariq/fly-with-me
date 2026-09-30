// The fly's ears. Audio -> per-band energy -> firing drive (0..1) for each Johnston's-organ subtype.
//
// Split mode (default): left ear = deck A cue, right ear = deck B cue, like a DJ with one headphone cup on each deck.
// Room mode: left/right channels of the master mix.
// Each deck also has a habituation state: the ear listening to the on-air deck slowly tunes it out,
// and a freshly loaded track is novel again. That adaptation is what makes the fly eventually want the other deck.

export class Ears {
  constructor(ctx, mixer, bands) {
    this.ctx = ctx; this.mixer = mixer;
    this.bands = bands;                    // [{name, ear:'L'|'R', lo, hi}]
    this.an = { L: ctx.createAnalyser(), R: ctx.createAnalyser() };
    for (const a of Object.values(this.an)) { a.fftSize = 2048; a.smoothingTimeConstant = 0.5; }
    this.spec = new Float32Array(1024);
    this.state = {};                       // per band: {peak, fast, slow}
    for (const b of bands) this.state[b.name] = { peak: -50, avg: -80 };
    this.habit = [0, 0];                   // per deck 0..1
    this.levels = {};
    this.gain = 1;
    this.splitter = ctx.createChannelSplitter(2);
    mixer.out.connect(this.splitter);
    this.setMode('split');
  }

  setMode(mode) {
    this.mode = mode;
    const [A, B] = this.mixer.decks;
    for (const n of [A.tap, B.tap, this.splitter]) { try { n.disconnect(this.an.L); } catch (e) {} try { n.disconnect(this.an.R); } catch (e) {} }
    if (mode === 'split') { A.tap.connect(this.an.L); B.tap.connect(this.an.R); }
    else { this.splitter.connect(this.an.L, 0); this.splitter.connect(this.an.R, 1); }
  }

  resetHabit(deckIdx) { this.habit[deckIdx] = 0; }

  // listener flies hear the raw track (before the DJ's EQ, filters and FX): otherwise the fly's own filter sweeps and
  // bass kills would rewrite what it hears, a feedback loop that never exists in training
  listenRaw() {
    if (this.rawAn) return;
    this.rawAn = this.mixer.decks.map((d) => { const a = this.ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0.5; d.rawTap.connect(a); return a; });
  }

  // one listener fly per deck: each fly hears its own deck in BOTH ears (the condition it was trained in), with no
  // habituation on the drive. Returns [levels for fly A, levels for fly B].
  updatePerDeck(dt) {
    const sr = this.ctx.sampleRate, binHz = sr / 2048, out = [{}, {}];
    this.mixer.decks.forEach((d, i) => {                  // habituation still tracked (for the crossfader), not applied
      const air = this.mixer.airness(d) * (d.playing ? 1 : 0);
      this.habit[i] = Math.min(1, Math.max(0, this.habit[i] + dt * (air / 75 - (1 - air) * this.habit[i] / 30)));
    });
    this.deckState ||= {};
    ['L', 'R'].forEach((ear, deck) => {                   // deck A / deck B: raw taps if listening raw, else the cue taps
      (this.rawAn ? this.rawAn[deck] : this.an[ear]).getFloatFrequencyData(this.spec);
      for (const b of this.bands) {
        if (b.ear !== 'L') continue;                      // one pass over the 12 band types
        const type = b.name.split(':')[1];
        const i0 = Math.max(1, Math.floor(b.lo / binHz)), i1 = Math.max(i0 + 1, Math.ceil(b.hi / binHz));
        let p = 0;
        for (let i = i0; i < i1 && i < this.spec.length; i++) p += Math.pow(10, this.spec[i] / 10);
        const db = 10 * Math.log10(p / (i1 - i0) + 1e-12);
        const s = (this.deckState[deck + type] ||= { peak: -50, avg: -80 });
        s.peak = Math.max(db, s.peak - dt * 1.5);
        const onset = Math.max(0, db - s.avg) / 12;
        s.avg += (db - s.avg) * Math.min(1, dt / 0.25);
        let lvl = (db - (s.peak - 36)) / 36;
        lvl = Math.min(1, Math.max(0, lvl)) ** 1.5 * 0.7 + Math.min(0.5, onset * 0.5);
        if (db < -95) lvl = 0;
        out[deck]['earL:' + type] = out[deck]['earR:' + type] = Math.min(1, lvl * this.gain);
      }
    });
    return out;
  }

  // call every ~25 ms; returns {bandName: level}
  update(dt) {
    const sr = this.ctx.sampleRate, binHz = sr / 2048;
    // habituation: on-air deck adapts (~75 s to mostly tuned out), off-air deck recovers (~30 s)
    this.mixer.decks.forEach((d, i) => {
      const air = this.mixer.airness(d) * (d.playing ? 1 : 0);
      this.habit[i] += dt * (air / 75 - (1 - air) * this.habit[i] / 30);
      this.habit[i] = Math.min(1, Math.max(0, this.habit[i]));
    });
    for (const ear of ['L', 'R']) {
      this.an[ear].getFloatFrequencyData(this.spec);
      const deckIdx = ear === 'L' ? 0 : 1;
      const adapt = this.mode === 'split' ? 1 - 0.75 * this.habit[deckIdx] : 1;
      for (const b of this.bands) {
        if (b.ear !== ear) continue;
        const i0 = Math.max(1, Math.floor(b.lo / binHz)), i1 = Math.max(i0 + 1, Math.ceil(b.hi / binHz));
        let p = 0;
        for (let i = i0; i < i1 && i < this.spec.length; i++) p += Math.pow(10, this.spec[i] / 10);
        const db = 10 * Math.log10(p / (i1 - i0) + 1e-12);
        const s = this.state[b.name];
        // adaptive range: slowly decaying peak, slow average for onset detection
        s.peak = Math.max(db, s.peak - dt * 1.5);
        const onset = Math.max(0, db - s.avg) / 12;
        s.avg += (db - s.avg) * Math.min(1, dt / 0.25);
        let lvl = (db - (s.peak - 36)) / 36;           // 36 dB window under the recent peak
        lvl = Math.min(1, Math.max(0, lvl)) ** 1.5 * 0.7 + Math.min(0.5, onset * 0.5);
        if (db < -95) lvl = 0;                          // silence
        this.levels[b.name] = Math.min(1, lvl * adapt * this.gain);
      }
    }
    return this.levels;
  }
}
