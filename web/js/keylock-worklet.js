// Key lock ("master tempo"): a real-time pitch shifter that undoes the pitch change caused by playing a deck faster
// or slower. Two read heads sweep through a short delay line at a speed set by `pitch`, crossfading with Hann
// windows that sum to 1 (the classic rotating-tape-head shifter). At pitch = 1 it is a clean ~25 ms delay.

const GRAIN = 0.05;          // seconds per head sweep
const SIZE = 1 << 15;        // delay-line length per channel

class KeyLock extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    this.buf = [new Float32Array(SIZE), new Float32Array(SIZE)];
    this.w = 0; this.phase = 0;
    this.grain = Math.floor(GRAIN * sampleRate);
  }
  read(ch, d) {                                   // fractional delay read with linear interpolation
    const b = this.buf[ch], p = this.w - d, i = Math.floor(p), f = p - i;
    const a = b[i & (SIZE - 1)], c = b[(i + 1) & (SIZE - 1)];
    return a + (c - a) * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0], pitch = params.pitch[0], G = this.grain;
    const n = out[0].length, step = (1 - pitch) / G;          // the delay drifts so the heads read at `pitch` speed
    for (let s = 0; s < n; s++) {
      for (let ch = 0; ch < 2; ch++) this.buf[ch][this.w & (SIZE - 1)] = inp.length ? inp[Math.min(ch, inp.length - 1)][s] : 0;
      let p0 = this.phase, p1 = (this.phase + 0.5) % 1;
      const w0 = Math.sin(Math.PI * p0) ** 2, w1 = Math.sin(Math.PI * p1) ** 2;
      const d0 = 32 + p0 * G, d1 = 32 + p1 * G;
      for (let ch = 0; ch < out.length; ch++) out[ch][s] = this.read(ch % 2, d0) * w0 + this.read(ch % 2, d1) * w1;
      this.w++;
      this.phase += step; this.phase -= Math.floor(this.phase);
    }
    return true;
  }
}
registerProcessor('keylock', KeyLock);
