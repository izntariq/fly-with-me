// Master FX rack (tempo-synced, like a club mixer's Beat FX) and a one-shot sampler (air horn, siren, boom...).
//
//   decks ─► in ─► HPF ─► LPF ─┬─► trans gate ─► crush ─► flanger ─► out ─► limiter
//                              └─► reverb send ─► convolver ───────────────┘   (pre-gate, so tails ring through drop gaps)

import { dagga, tilli } from './desi.js';

function makeIR(ctx, seconds = 3.2, decay = 2.8) {
  const n = Math.floor(ctx.sampleRate * seconds), ir = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
  }
  return ir;
}

export class FXRack {
  constructor(ctx, dest) {
    this.ctx = ctx; this.bpm = 124;
    const g = () => ctx.createGain();
    this.in = g();
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 1.1;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 1.1;
    this.gate = g();
    // bit crusher: quantising waveshaper blended with the dry signal
    this.crushDry = g(); this.crushWet = g(); this.crushWet.gain.value = 0;
    const shaper = ctx.createWaveShaper(), curve = new Float32Array(4096);
    for (let i = 0; i < curve.length; i++) { const x = i / (curve.length - 1) * 2 - 1; curve[i] = Math.round(x * 6) / 6; }
    shaper.curve = curve;
    this.crushSum = g();
    // flanger: short modulated delay with feedback
    this.flDelay = ctx.createDelay(0.05); this.flDelay.delayTime.value = 0.004;
    this.flLfo = ctx.createOscillator(); this.flLfo.type = 'triangle'; this.flLfo.frequency.value = 0.25;
    this.flDepth = g(); this.flDepth.gain.value = 0.0032;
    this.flFb = g(); this.flFb.gain.value = 0.6;
    this.flWet = g(); this.flWet.gain.value = 0;
    this.out = g();
    // reverb
    this.verb = ctx.createConvolver(); this.verb.buffer = makeIR(ctx);
    this.verbSend = g(); this.verbSend.gain.value = 0;
    this.verbRet = g(); this.verbRet.gain.value = 0.9;

    this.in.connect(this.hp); this.hp.connect(this.lp);
    this.lp.connect(this.gate); this.lp.connect(this.verbSend);
    this.gate.connect(this.crushDry); this.gate.connect(shaper); shaper.connect(this.crushWet);
    this.crushDry.connect(this.crushSum); this.crushWet.connect(this.crushSum);
    this.crushSum.connect(this.out);
    this.crushSum.connect(this.flDelay); this.flDelay.connect(this.flFb); this.flFb.connect(this.flDelay);
    this.flDelay.connect(this.flWet); this.flWet.connect(this.out);
    this.flLfo.connect(this.flDepth); this.flDepth.connect(this.flDelay.delayTime); this.flLfo.start();
    this.verbSend.connect(this.verb); this.verb.connect(this.verbRet); this.verbRet.connect(this.out);
    this.out.connect(dest);
    this.active = {};   // name -> ctx time it ends (for the UI)
  }
  get spb() { return 60 / this.bpm; }
  _mark(name, end) { this.active[name] = Math.max(this.active[name] || 0, end); }
  isActive(name) { return (this.active[name] || 0) > this.ctx.currentTime; }

  // high-pass sweep up over `beats` (build-ups), released at the end
  sweep(at, beats, top = 1800) {
    const f = this.hp.frequency, end = at + beats * this.spb;
    f.cancelScheduledValues(at); f.setValueAtTime(10, at); f.exponentialRampToValueAtTime(top, end - 0.01); f.setValueAtTime(10, end);
    this._mark('sweep', end);
  }
  lowpassDip(at, beats) {
    const f = this.lp.frequency, end = at + beats * this.spb;
    f.cancelScheduledValues(at); f.setValueAtTime(22000, at); f.exponentialRampToValueAtTime(350, at + beats * this.spb * 0.5);
    f.exponentialRampToValueAtTime(22000, end); this._mark('lpf', end);
  }
  // rhythmic volume chop ("trans"), div = notes per beat
  trans(at, beats, div = 4) {
    const gg = this.gate.gain, step = this.spb / div, n = Math.round(beats * div);
    gg.cancelScheduledValues(at);
    for (let k = 0; k < n; k++) { gg.setValueAtTime(1, at + k * step); gg.setValueAtTime(0.04, at + k * step + step * 0.5); }
    gg.setValueAtTime(1, at + n * step);
    this._mark('trans', at + n * step);
  }
  // silence the dry signal (reverb tail keeps ringing) — the gap before a drop
  gap(at, dur) {
    const gg = this.gate.gain;
    gg.setValueAtTime(1, at); gg.linearRampToValueAtTime(0, at + 0.01); gg.setValueAtTime(0, at + dur - 0.005); gg.linearRampToValueAtTime(1, at + dur);
  }
  crush(at, beats) {
    const end = at + beats * this.spb;
    this.crushWet.gain.setValueAtTime(0.9, at); this.crushDry.gain.setValueAtTime(0.25, at);
    this.crushWet.gain.setValueAtTime(0, end); this.crushDry.gain.setValueAtTime(1, end);
    this._mark('crush', end);
  }
  flange(at, beats) {
    const end = at + beats * this.spb;
    this.flLfo.frequency.setValueAtTime(1 / Math.max(this.spb * 2, beats * this.spb / 2), at);
    const w = this.flWet.gain;
    w.setValueAtTime(0, at); w.linearRampToValueAtTime(0.85, at + 0.05); w.setValueAtTime(0.85, end - 0.1); w.linearRampToValueAtTime(0, end);
    this._mark('flanger', end);
  }
  reverbThrow(at, beats) {
    const s = this.verbSend.gain, end = at + beats * this.spb;
    s.setValueAtTime(0, at); s.linearRampToValueAtTime(0.9, at + 0.02); s.setValueAtTime(0.9, end); s.linearRampToValueAtTime(0, end + 0.05);
    this._mark('reverb', end);
  }
  reverbWash(at, beats, peak = 0.7) {
    const s = this.verbSend.gain, end = at + beats * this.spb;
    s.cancelScheduledValues(at); s.setValueAtTime(0, at); s.linearRampToValueAtTime(peak, end); s.setValueAtTime(0, end + 0.02);
    this._mark('reverb', end);
  }
}

export class Sampler {
  constructor(ctx, dest, echoIn) {
    this.ctx = ctx; this.out = ctx.createGain(); this.out.gain.value = 0.7; this.out.connect(dest);
    this.echoIn = echoIn;
    const n = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.bufs = {};
  }
  _buf(name, make) {
    if (!this.bufs[name]) { const x = make(), b = this.ctx.createBuffer(1, x.length, 44100); b.copyToChannel(x, 0); this.bufs[name] = b; }
    return this.bufs[name];
  }
  // the classic reggae / desi air horn: "ba-ba-baaaa"
  airhorn(at) {
    const ctx = this.ctx, bus = ctx.createGain(), bp = ctx.createBiquadFilter(), sh = ctx.createWaveShaper();
    bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
    const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(x * 3); } sh.curve = c;
    bus.connect(sh); sh.connect(bp); bp.connect(this.out); bp.connect(this.echoIn);
    const blasts = [[0, 0.11], [0.16, 0.11], [0.32, 0.75]];
    for (const [off, dur] of blasts) {
      const t = at + off;
      for (const det of [-12, 0, 9, 21]) {
        const o = ctx.createOscillator(), gg = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.setValueAtTime(466 * (1 + det / 1200), t); o.frequency.linearRampToValueAtTime(446 * (1 + det / 1200), t + dur);
        gg.gain.setValueAtTime(0, t); gg.gain.linearRampToValueAtTime(0.09, t + 0.015); gg.gain.setValueAtTime(0.09, t + dur - 0.03); gg.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(gg); gg.connect(bus); o.start(t); o.stop(t + dur + 0.02);
      }
    }
  }
  // dub siren: square wave wobbling and rising, fed into the echo
  siren(at, dur = 2) {
    const ctx = this.ctx, o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), gg = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = 'square'; o.frequency.setValueAtTime(520, at); o.frequency.exponentialRampToValueAtTime(900, at + dur);
    lfo.type = 'triangle'; lfo.frequency.setValueAtTime(3, at); lfo.frequency.linearRampToValueAtTime(9, at + dur); lg.gain.value = 180;
    lfo.connect(lg); lg.connect(o.frequency);
    f.type = 'lowpass'; f.frequency.value = 2500;
    gg.gain.setValueAtTime(0, at); gg.gain.linearRampToValueAtTime(0.12, at + 0.05); gg.gain.setValueAtTime(0.12, at + dur - 0.1); gg.gain.linearRampToValueAtTime(0, at + dur);
    o.connect(f); f.connect(gg); gg.connect(this.out); gg.connect(this.echoIn);
    o.start(at); lfo.start(at); o.stop(at + dur + 0.05); lfo.stop(at + dur + 0.05);
  }
  laser(at) {
    const ctx = this.ctx, o = ctx.createOscillator(), gg = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(3200, at); o.frequency.exponentialRampToValueAtTime(90, at + 0.3);
    gg.gain.setValueAtTime(0.14, at); gg.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
    o.connect(gg); gg.connect(this.out); gg.connect(this.echoIn); o.start(at); o.stop(at + 0.35);
  }
  // sub drop + noise impact on the downbeat of a drop
  boom(at) {
    const ctx = this.ctx, o = ctx.createOscillator(), gg = ctx.createGain();
    o.frequency.setValueAtTime(90, at); o.frequency.exponentialRampToValueAtTime(28, at + 1.6);
    gg.gain.setValueAtTime(0.9, at); gg.gain.exponentialRampToValueAtTime(0.0001, at + 1.8);
    o.connect(gg); gg.connect(this.out); o.start(at); o.stop(at + 1.9);
    const s = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), ng = ctx.createGain();
    s.buffer = this.noise; lp.type = 'lowpass'; lp.frequency.setValueAtTime(6000, at); lp.frequency.exponentialRampToValueAtTime(200, at + 0.8);
    ng.gain.setValueAtTime(0.5, at); ng.gain.exponentialRampToValueAtTime(0.0001, at + 1);
    s.connect(lp); lp.connect(ng); ng.connect(this.out); s.start(at); s.stop(at + 1.05);
  }
  // white-noise riser that peaks exactly at at+dur
  riser(at, dur) {
    const ctx = this.ctx, s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), gg = ctx.createGain();
    s.buffer = this.noise; s.loop = true;
    bp.type = 'bandpass'; bp.Q.value = 2; bp.frequency.setValueAtTime(300, at); bp.frequency.exponentialRampToValueAtTime(9000, at + dur);
    gg.gain.setValueAtTime(0.001, at); gg.gain.exponentialRampToValueAtTime(0.35, at + dur); gg.gain.linearRampToValueAtTime(0, at + dur + 0.03);
    s.connect(bp); bp.connect(gg); gg.connect(this.out); s.start(at); s.stop(at + dur + 0.05);
  }
  // accelerating dhol roll (desi build-up), `beats` long, crescendo
  dholRoll(at, beats, spb) {
    const lo = this._buf('dagga', () => dagga(1)), hi = this._buf('tilli', () => tilli(1.1));
    let t = at; const end = at + beats * spb;
    while (t < end) {
      const p = (t - at) / (end - at), step = spb / (p < 0.5 ? 4 : p < 0.8 ? 6 : 8);
      const s = this.ctx.createBufferSource(), gg = this.ctx.createGain();
      const low = Math.round((t - at) / step) % 4 === 0;
      s.buffer = low ? lo : hi; gg.gain.value = (0.25 + 0.6 * p) * (low ? 1 : 0.7);
      s.connect(gg); gg.connect(this.out); s.start(t);
      t += step;
    }
  }
}
