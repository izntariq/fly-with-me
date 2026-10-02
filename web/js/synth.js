// The fly's own voice: every descending/motor neuron is a key on a synth.
// Descending neurons (brain -> body commands) play an FM pluck lead; motor neurons play the bass.
// Pitch is fixed per neuron (hash of its cell type -> scale degree, side -> octave), so the same
// cell type always plays the same note and you can learn to hear specific neurons.

import { SCALES } from './tracks.js';
import { ksPluck, dagga, tilli } from './desi.js';

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class FlySynth {
  constructor(ctx, dest, outputs) {
    this.ctx = ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0.45;
    const verbSend = ctx.createGain(); verbSend.gain.value = 0.3;
    this.out.connect(dest); this.out.connect(verbSend);
    // cheap stereo "room": two tapped delays
    for (const [t, pan] of [[0.137, -0.6], [0.193, 0.6]]) {
      const d = ctx.createDelay(1), g = ctx.createGain(), p = ctx.createStereoPanner();
      d.delayTime.value = t; g.gain.value = 0.35; p.pan.value = pan;
      verbSend.connect(d); d.connect(g); g.connect(p); p.connect(dest); g.connect(d);
    }
    this.outputs = outputs;
    this.pending = new Float32Array(outputs.length);  // spikes accumulated since last grid step
    this.voiceInfo = outputs.map((o) => ({ h: hash(o.type), right: o.side === 'right', motor: o.cls === 'motor' || o.cls === 'leg_wing_motor' }));
    this.root = 45; this.scale = SCALES.minpent;
    this.quantize = true;
    this.midi = null;
    this.lastNote = new Float64Array(outputs.length);
    this.onNote = null;
    this.style = 'club';            // 'desi': motor neurons play dhol, descending neurons play sitar
    this.bufs = new Map();
  }

  _buf(key, make) {
    if (!this.bufs.has(key)) {
      const data = make(), b = this.ctx.createBuffer(1, data.length, 44100);
      b.copyToChannel(data, 0);
      this.bufs.set(key, b);
    }
    return this.bufs.get(key);
  }

  _playBuf(buf, t, gain, pan) {
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain(), p = this.ctx.createStereoPanner();
    src.buffer = buf; g.gain.value = gain; p.pan.value = pan;
    src.connect(g); g.connect(p); p.connect(this.out); src.start(t);
  }

  setLevel(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setKey(root, scaleName) { this.root = root; this.scale = SCALES[scaleName] || SCALES.minpent; }

  pitchOf(slot) {
    const v = this.voiceInfo[slot], sc = this.scale;
    const degree = v.h % (sc.length * 2);
    const oct = v.motor ? 2 : (v.right ? 5 : 4);
    const base = this.root % 12 + 12 * oct;
    return base + sc[degree % sc.length] + 12 * Math.floor(degree / sc.length) - (v.motor ? 12 * Math.floor(degree / sc.length) : 0);
  }

  // spikes: [[slot, tOffsetMs], ...] from a brain frame
  addSpikes(spikes, frameTime) {
    if (this.quantize) { for (const [s] of spikes) this.pending[s] += 1; return; }
    // free-running: play each spike with the fly's own timing (rate-limited per neuron)
    const lat = 0.08;
    for (const [s, dtm] of spikes) {
      const t = frameTime + lat + dtm / 1000;
      if (t - this.lastNote[s] < 0.09) continue;
      this.lastNote[s] = t;
      this.play(s, t, 0.5);
    }
  }

  // called for each 16th-note grid step: play the most active neurons since the last step
  gridStep(t, spb16) {
    const n = this.pending.length, top = [];
    for (let i = 0; i < n; i++) {
      const c = this.pending[i];
      if (c > 0) { top.push([c, i]); this.pending[i] = 0; }
    }
    if (!top.length) return;
    top.sort((a, b) => b[0] - a[0]);
    const maxVoices = 3;
    let bassPlayed = false;
    for (const [c, i] of top.slice(0, maxVoices + 2)) {
      const motor = this.voiceInfo[i].motor;
      if (motor && bassPlayed) continue;
      if (motor) bassPlayed = true;
      this.play(i, t, Math.min(1, 0.35 + Math.log2(1 + c) * 0.2), spb16);
    }
  }

  play(slot, t, vel, spb16 = 0.12) {
    const m = this.pitchOf(slot), motor = this.voiceInfo[slot].motor;
    const ctx = this.ctx;
    if (this.style === 'desi') {
      const v = this.voiceInfo[slot];
      if (motor) {
        // the fly drums: each motor neuron is a dhol stroke (bass dagga or treble tilli)
        const low = v.h % 3 === 0;
        this._playBuf(this._buf(low ? 'dagga' : 'tilli', low ? () => dagga(1) : () => tilli(1.1)), t, (low ? 0.9 : 0.6) * vel, low ? -0.15 : 0.2);
      } else {
        // sitar with meend: some neurons glide into their note
        const glide = v.h % 4 === 0 ? -2 : v.h % 4 === 1 ? -1 : 0;
        this._playBuf(this._buf(`sitar${m}${glide}`, () => ksPluck(440 * Math.pow(2, (m - 69) / 12), 1.4,
          { decay: 0.998, bright: 0.25, buzz: 0.5, glide, glideTime: 0.09 })), t, 0.55 * vel, v.right ? 0.45 : -0.45);
      }
    } else if (motor) {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = mtof(m);
      f.type = 'lowpass'; f.Q.value = 8; f.frequency.setValueAtTime(1800 * vel, t); f.frequency.exponentialRampToValueAtTime(120, t + spb16 * 1.8);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28 * vel, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + spb16 * 2);
      o.connect(f); f.connect(g); g.connect(this.out); o.start(t); o.stop(t + spb16 * 2 + 0.05);
    } else {
      const o = ctx.createOscillator(), mo = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain(), p = ctx.createStereoPanner();
      const fr = mtof(m);
      o.frequency.value = fr; mo.frequency.value = fr * (this.voiceInfo[slot].h % 3 === 0 ? 3.5 : 2);
      mg.gain.setValueAtTime(fr * 4 * vel, t); mg.gain.exponentialRampToValueAtTime(fr * 0.1, t + 0.25);
      mo.connect(mg); mg.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16 * vel, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      p.pan.value = this.voiceInfo[slot].right ? 0.45 : -0.45;
      o.connect(g); g.connect(p); p.connect(this.out);
      o.start(t); mo.start(t); o.stop(t + 0.55); mo.stop(t + 0.55);
    }
    if (this.midi) {
      const delayMs = Math.max(0, (t - ctx.currentTime) * 1000), now = performance.now();
      const ch = motor ? 1 : 0, v = Math.max(1, Math.round(vel * 127));
      this.midi.send([0x90 | ch, m, v], now + delayMs);
      this.midi.send([0x80 | ch, m, 0], now + delayMs + 150);
    }
    this.onNote?.(slot, m, t);
  }

  // giant fiber "zap" (percussive laser for escape events)
  zap(t) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(2400, t); o.frequency.exponentialRampToValueAtTime(80, t + 0.25);
    g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g); g.connect(this.out); o.start(t); o.stop(t + 0.3);
  }
}
