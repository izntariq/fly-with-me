// Key lock ("master tempo"): a real-time pitch shifter that undoes the pitch change caused by playing a deck faster
// or slower, using WSOLA (waveform-similarity overlap-add, the method behind SoundTouch).
//
// Output is built from Hann-windowed grains (≈23 ms, 50% overlap). Each grain reads the input at `pitch` speed.
// Before a grain starts, the processor searches ±5.8 ms around its ideal read position for the spot whose waveform
// best continues the grain that's already playing (normalized cross-correlation), so drum hits aren't doubled and
// sustained notes don't phase. At pitch 1 the search locks onto a perfect continuation: a clean ~24 ms delay.

const SIZE = 1 << 16;        // ring buffer length (samples)
const MASK = SIZE - 1;

class KeyLock extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    const k = sampleRate / 44100;
    this.G = Math.round(1024 * k);               // grain length
    this.HO = this.G >> 1;                       // output hop (50% overlap)
    this.S = Math.round(256 * k);                // search radius
    this.L = Math.round(1056 * k);               // fixed latency: ideal read position = now − L
    this.inL = new Float32Array(SIZE); this.inR = new Float32Array(SIZE); this.mono = new Float32Array(SIZE);
    this.t = 0;                                  // absolute sample clock (input and output share it)
    this.next = this.L + this.G;                 // when the next grain starts
    this.grains = [];                            // {t0, s0, p}
    this.win = new Float32Array(this.G);
    for (let i = 0; i < this.G; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.G);
  }
  rd(buf, pos) {                                 // linear-interpolated read at absolute fractional position
    const i = Math.floor(pos), f = pos - i;
    const a = buf[i & MASK], b = buf[(i + 1) & MASK];
    return a + (b - a) * f;
  }
  // choose where the new grain reads from: the offset around the ideal position that best continues the last grain
  place(t, p) {
    const ideal = t - this.L, prev = this.grains[this.grains.length - 1];
    if (!prev) return ideal;
    const n = this.HO, step = 4, j0 = t - prev.t0;
    // what the previous grain will play over the overlap (its own continuation)
    const ref = [];
    let refE = 0;
    for (let j = 0; j < n; j += step) { const v = this.rd(this.mono, prev.s0 + prev.p * (j0 + j)); ref.push(v); refE += v * v; }
    if (refE < 1e-9) return ideal;               // silence: nothing to align to
    let best = ideal, bestScore = -Infinity;
    for (let d = -this.S; d <= this.S; d += 2) {
      const c = ideal + d;
      let dot = 0, e = 1e-9;
      for (let j = 0, m = 0; j < n; j += step, m++) { const v = this.rd(this.mono, c + p * j); dot += v * ref[m]; e += v * v; }
      const score = dot / Math.sqrt(e);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0], n = out[0].length;
    const p = Math.max(0.8, Math.min(1.25, params.pitch[0]));
    const G = this.G, win = this.win;
    for (let s = 0; s < n; s++) {
      const t = this.t, i = t & MASK;
      const l = inp.length ? inp[0][s] : 0, r = inp.length > 1 ? inp[1][s] : l;
      this.inL[i] = l; this.inR[i] = r; this.mono[i] = 0.5 * (l + r);
      if (t >= this.next) {
        this.grains.push({ t0: t, s0: this.place(t, p), p });
        this.next += this.HO;
        if (this.grains.length > 3) this.grains.shift();
      }
      let oL = 0, oR = 0;
      for (const g of this.grains) {
        const j = t - g.t0;
        if (j < 0 || j >= G) continue;
        const w = win[j], pos = g.s0 + g.p * j;
        oL += w * this.rd(this.inL, pos); oR += w * this.rd(this.inR, pos);
      }
      out[0][s] = oL;
      if (out.length > 1) out[1][s] = oR;
      this.t++;
    }
    return true;
  }
}
registerProcessor('keylock', KeyLock);
