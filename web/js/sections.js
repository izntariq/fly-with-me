// Section sense v2 (flybrain/sections.py, brains/sections_*.json): where a listener fly's deck is in its track.
//
// Each bar of the deck's own beat grid, the fly's output neurons are pooled by cell type into rates. Those are
// log-scaled and normalised against this track so far, plus the previous 4 bars' mean, then go through a logistic
// classifier trained on real tracks. An online HMM keeps the sections in order (intro -> main <-> break -> outro),
// weighing in how much of the track is left. The result: section + confidence, updated on every bar line.

export class SectionSense {
  constructor(spec, outputs, deck) {
    this.spec = spec; this.deck = deck; this.K = spec.classes.length;
    const idx = new Map(spec.groups.map((g, i) => [g, i]));
    this.groupOf = outputs.map((o) => idx.get(`${o.cls}:${o.type}`) ?? -1);
    this.G = spec.groups.length;
    this.nIn = new Float32Array(this.G);
    this.groupOf.forEach((g) => { if (g >= 0) this.nIn[g]++; });
    if (spec.T) {                            // v3: arrangement learned from labelled tracks (flybrain/sections.py)
      this.T = spec.T; this.start = spec.start; this.pos = spec.pos;
    } else {                                 // v2: hand-set intro -> main <-> break -> outro
      const st = spec.stay ?? 0.93;
      this.T = [[st, 1 - st, 0, 0], [0, st, (1 - st) * 0.75, (1 - st) * 0.25], [0, (1 - st) * 0.8, st, (1 - st) * 0.2], [0, 0, 0, 1]];
      this.start = [0.9, 0.06, 0.02, 0.02];
    }
    this.useEnergy = !!spec.energy;
    this.reset();
  }
  reset() {
    this.track = this.deck.track; this.bar = null;
    this.cnt = new Float32Array(this.G); this.secs = 0;
    this.s = new Float64Array(this.G); this.s2 = new Float64Array(this.G); this.k = 0; this.hist = [];
    this.e = { s: 0, s2: 0, hist: [] };
    this.a = this.start.slice();
    this.section = this.spec.classes[0]; this.conf = 0; this.p = this.a.slice(); this.held = 0;
  }
  // one brain frame of this listener's output spikes ([slot, t] pairs)
  update(spikes, dtMs) {
    const d = this.deck;
    if (d.track !== this.track) this.reset();
    if (!d.track || !d.playing) return;
    const bar = Math.floor(d.beatAt() / 4);
    if (this.bar !== null && bar < this.bar - 1) this.reset();     // cued back (e.g. to its intro): start the track over
    if (this.bar === null) this.bar = bar;
    if (bar !== this.bar) { if (this.secs > 0.5 * 4 * 60 / d.bpm) this.closeBar(); this.bar = bar; this.cnt.fill(0); this.secs = 0; }
    for (const [s] of spikes) { const g = this.groupOf[s]; if (g >= 0) this.cnt[g]++; }
    this.secs += dtMs / 1000;
  }
  closeBar() {
    const G = this.G, sp = this.spec.feature, x = new Float64Array(G), z = new Float64Array(G);
    for (let g = 0; g < G; g++) x[g] = Math.log1p(this.cnt[g] / Math.max(1, this.nIn[g]) / this.secs);
    this.k++;
    for (let g = 0; g < G; g++) {
      this.s[g] += x[g]; this.s2[g] += x[g] * x[g];
      const mu = this.s[g] / this.k, sd = Math.sqrt(Math.max(this.s2[g] / this.k - mu * mu, 0)) + sp.sd_floor;
      z[g] = this.k >= sp.warmup_bars ? (x[g] - mu) / sd : 0;
    }
    const prev = this.hist.slice(-sp.context_bars), ctx = new Float64Array(G);
    for (const h of prev) for (let g = 0; g < G; g++) ctx[g] += h[g] / prev.length;
    this.hist.push(z); if (this.hist.length > sp.context_bars) this.hist.shift();
    // logits = [z, ctx (, energy z, energy ctx)] @ W + b
    const W = this.spec.W, logit = this.spec.b.slice();
    for (let g = 0; g < G; g++) {
      const wz = W[g], wc = W[G + g];
      if (z[g]) for (let c = 0; c < this.K; c++) logit[c] += z[g] * wz[c];
      if (ctx[g]) for (let c = 0; c < this.K; c++) logit[c] += ctx[g] * wc[c];
    }
    if (this.useEnergy) {
      // the app's own per-bar energy of the bar just played, normalised the same causal way (sections.energy_features)
      const en = this.deck.track.energy, E = this.e, x = Math.log((en?.[Math.max(0, Math.min(en.length - 1, this.bar))] ?? 0) + 1e-3);
      E.s += x; E.s2 += x * x;
      const mu = E.s / this.k, sd = Math.sqrt(Math.max(E.s2 / this.k - mu * mu, 0)) + sp.sd_floor;
      const ze = this.k >= sp.warmup_bars ? (x - mu) / sd : 0;
      const ce = E.hist.length ? E.hist.reduce((p, q) => p + q, 0) / E.hist.length : 0;
      E.hist.push(ze); if (E.hist.length > sp.context_bars) E.hist.shift();
      const we = W[2 * G], wce = W[2 * G + 1];
      for (let c = 0; c < this.K; c++) logit[c] += ze * we[c] + ce * wce[c];
    }
    const m = Math.max(...logit), e = logit.map((v) => Math.exp(v - m)), se = e.reduce((p, q) => p + q, 0);
    const P = e.map((v) => v / se);
    // online HMM: section order + how far into the track we are
    const frac = Math.min(1, Math.max(0, this.deck.position() / Math.max(1, this.deck.duration)));
    const prior = this.pos ? this.pos[Math.min(this.pos.length - 1, Math.floor(frac * this.pos.length))]
      : [Math.exp(-frac / 0.12), 1, 0.5, Math.exp(-(1 - frac) / 0.10)].map((v) => v + 1e-3);
    const a = new Array(this.K).fill(0);
    for (let i = 0; i < this.K; i++) for (let j = 0; j < this.K; j++) a[j] += this.a[i] * this.T[i][j];
    for (let j = 0; j < this.K; j++) a[j] *= P[j] * prior[j];
    const sa = a.reduce((p, q) => p + q, 0) || 1;
    this.a = a.map((v) => v / sa);
    let best = 0; for (let j = 1; j < this.K; j++) if (this.a[j] > this.a[best]) best = j;
    const name = this.spec.classes[best];
    this.held = name === this.section ? this.held + 1 : 1;          // bars in a row with the same verdict
    this.section = name; this.conf = this.a[best]; this.p = P;
  }
  // which DJ senses are on (the old sense's interface), plus the section itself
  get state() {
    const s = this.section, c = this.conf > 0.55;
    return { SPACE: c && s === 'break', MIX: c && (s === 'intro' || s === 'outro'), PEAK: c && (s === 'main' || s === 'chorus'),
             section: s, conf: this.conf, held: this.held,
             frac: this.deck.duration ? this.deck.position() / this.deck.duration : 0 };
  }
}
