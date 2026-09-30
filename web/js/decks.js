// Two-deck DJ mixer: per-deck EQ, filter, loop roll, echo throw, backspin, scratching, brake, hot cues;
// equal-power crossfader; master bus runs through the FX rack.

import { FXRack, Sampler } from './fx.js';

export class Mixer {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 12;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    this.master.connect(limiter);
    limiter.connect(ctx.destination);
    this.out = limiter; // tap for recording / room ears
    // master bus goes through the FX rack before the limiter
    this.master.disconnect();
    this.fx = new FXRack(ctx, limiter);
    this.master.connect(this.fx.in);

    // echo bus (dotted-eighth delay, tempo-synced by setTempo)
    this.echoIn = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.fb = ctx.createGain(); this.fb.gain.value = 0.45;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
    this.echoIn.connect(this.delay); this.delay.connect(hp); hp.connect(this.fb); this.fb.connect(this.delay);
    hp.connect(this.master);
    this.setTempo(124);

    this.sampler = new Sampler(ctx, limiter, this.echoIn);
    this.decks = [new Deck(ctx, 'A', this), new Deck(ctx, 'B', this)];
    this.lockUntil = 0;   // a scheduled cut owns the crossfader until then
    this.x = 0; // 0 = full A, 1 = full B
    this.setCrossfader(0);
  }
  // key lock (CDJ "master tempo"): load the pitch-shifter worklet, then switch every deck to it
  async initKeylock() {
    try {
      await this.ctx.audioWorklet.addModule('js/keylock-worklet.js');
      for (const d of this.decks) d.keyNode = new AudioWorkletNode(this.ctx, 'keylock', { outputChannelCount: [2] });
      this.keylockLatency = Math.round(1056 * this.ctx.sampleRate / 44100) / this.ctx.sampleRate;   // matches the worklet's L
      this.keylockReady = true;
    } catch (e) { this.keylockReady = false; }
    return this.keylockReady;
  }
  setKeylock(on) {
    this.keylock = on && this.keylockReady;
    for (const d of this.decks) d.setKeylock(this.keylock);
  }

  // playback rate that puts `track` at `bpm` (folding half/double time)
  rateFor(track, bpm) { let r = bpm / track.bpm; if (r > 1.4) r /= 2; else if (r < 0.7) r *= 2; return r; }
  // master tempo: every playing deck follows it, phase stays locked because they all change at the same instant
  applyTempo(bpm) {
    this.masterBpm = bpm;
    for (const d of this.decks) if (d.track && d.playing) d.setRate(this.rateFor(d.track, bpm));
    this.setTempo(bpm);
  }
  setTempo(bpm) {
    this.bpm = bpm;
    if (this.fx) this.fx.bpm = bpm;
    this.delay.delayTime.setTargetAtTime(0.75 * 60 / bpm, this.ctx.currentTime, 0.05);
  }
  setCrossfader(x) {
    this.x = Math.min(1, Math.max(0, x));
    const t = this.ctx.currentTime;
    this.decks[0].xf.gain.setTargetAtTime(Math.cos(this.x * Math.PI / 2), t, 0.02);
    this.decks[1].xf.gain.setTargetAtTime(Math.sin(this.x * Math.PI / 2), t, 0.02);
  }
  // hard cut of the crossfader at an exact (beat-aligned) time
  cutTo(x, at) {
    const [A, B] = this.decks;
    A.xf.gain.cancelScheduledValues(at); B.xf.gain.cancelScheduledValues(at);
    A.xf.gain.setValueAtTime(Math.cos(x * Math.PI / 2), at);
    B.xf.gain.setValueAtTime(Math.sin(x * Math.PI / 2), at);
    this.lockUntil = at + 0.05;
    setTimeout(() => { this.x = x; }, Math.max(0, (at - this.ctx.currentTime) * 1000));
  }
  onAir() { return this.x < 0.5 ? this.decks[0] : this.decks[1]; }
  offAir() { return this.x < 0.5 ? this.decks[1] : this.decks[0]; }
  // how audible each deck is (0..1)
  airness(deck) { return deck === this.decks[0] ? Math.cos(this.x * Math.PI / 2) ** 2 : Math.sin(this.x * Math.PI / 2) ** 2; }
}

export class Deck {
  constructor(ctx, name, mixer) {
    this.ctx = ctx; this.name = name; this.mixer = mixer;
    this.track = null; this.src = null; this.playing = false;
    this.rate = 1; this.anchorCtx = 0; this.anchorPos = 0;
    this.eqVals = { low: 0, mid: 0, high: 0 }; this.filterVal = 0;

    this.input = ctx.createGain();       // main source goes here (slip-muted during FX)
    // stems: drums and music play as two synced sources, each with its own mute
    this.stemGain = { drums: ctx.createGain(), music: ctx.createGain() };
    this.stemGain.drums.connect(this.input); this.stemGain.music.connect(this.input);
    this.stemOn = { drums: true, music: true };
    this.fxIn = ctx.createGain();        // loop rolls / backspins go here
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.7;
    this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4000;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 0.9;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.9;
    this.tap = ctx.createGain();         // pre-fader cue (what the fly hears in split mode)
    this.rawTap = ctx.createGain();      // the track itself, before EQ / filter / FX: what listener flies hear
    this.xf = ctx.createGain();
    this.echoSend = ctx.createGain(); this.echoSend.gain.value = 0;

    this.input.connect(this.low); this.fxIn.connect(this.low);
    this.input.connect(this.rawTap);
    this.low.connect(this.mid); this.mid.connect(this.high); this.high.connect(this.lp); this.lp.connect(this.hp);
    this.hp.connect(this.tap); this.tap.connect(this.xf); this.xf.connect(mixer.master);
    this.tap.connect(this.echoSend); this.echoSend.connect(mixer.echoIn);
  }

  get bpm() { return this.track ? this.track.bpm * this.rate : 0; }
  get duration() { return this.track ? this.track.buffer.duration : 0; }
  position(at = this.ctx.currentTime) {
    if (!this.playing) return this.anchorPos;
    return this.anchorPos + (at - this.anchorCtx) * this.rate;
  }
  // beat index (float) at ctx time `at`
  beatAt(at = this.ctx.currentTime) {
    if (!this.track) return 0;
    return (this.position(at) - this.track.firstBeat) * this.track.bpm / 60;
  }
  // ctx time at which beat index `b` will play (assumes constant rate)
  timeOfBeat(b) {
    const pos = this.track.firstBeat + b * 60 / this.track.bpm;
    return this.anchorCtx + (pos - this.anchorPos) / this.rate;
  }
  nextBeatTime(div = 1, at = this.ctx.currentTime) {
    const b = this.beatAt(at);
    return this.timeOfBeat(Math.ceil((b + 1e-4) * div) / div);
  }

  load(track) {
    this.stop();
    this.track = track;
    this.setStem('drums', true); this.setStem('music', true);
    this.anchorPos = track.cue ?? track.firstBeat;
    this.rate = 1;
  }

  get hasStems() { return !!this.track?.stems; }
  // key lock delays what you hear by a fixed amount; everything before the shifter is scheduled that much earlier,
  // so the audible deck lines up with rolls, scratches, the fly's synth and the sampler (which bypass it)
  get lat() { return this.keylock ? (this.mixer.keylockLatency || 0) : 0; }
  pre(t) { return Math.max(this.ctx.currentTime, t - this.lat); }

  play(at = this.ctx.currentTime, pos = this.anchorPos) {
    if (!this.track) return;
    this._stopSrc();
    // `when` is when it will be heard; the source starts `lat` earlier (or now, and is heard `lat` later)
    const startPos = Math.max(0, pos), when = Math.max(at, this.ctx.currentTime + this.lat), srcAt = this.pre(when);
    const mk = (buffer, dest) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buffer; s.playbackRate.value = this.rate; s.connect(dest); s.start(srcAt, startPos);
      return s;
    };
    this._syncPitch(when);
    const st = this.track.stems;
    this.srcs = st ? [mk(st.drums, this.stemGain.drums), mk(st.music, this.stemGain.music)] : [mk(this.track.buffer, this.input)];
    const src = this.srcs[0];
    src.onended = () => { if (this.src === src) { this.playing = false; this.anchorPos = this.duration; this.onEnded?.(this); } };
    this.src = src;
    this.anchorCtx = srcAt + this.lat;
    this.anchorPos = startPos;
    this.playing = true;
  }

  stop() {
    if (this.playing) this.anchorPos = this.position();
    this._stopSrc();
    this.playing = false;
  }
  _stopSrc() {
    if (this.src) this.src.onended = null;
    for (const s of this.srcs || []) { try { s.stop(); } catch (e) {} s.disconnect(); }
    this.srcs = []; this.src = null;
  }

  // route the deck through its key-lock pitch shifter (pitch = 1/rate cancels the vinyl-style pitch change)
  setKeylock(on) {
    if (!this.keyNode) return;
    const wasPlaying = this.playing, resumeAt = this.ctx.currentTime + 0.06, resumePos = this.position(resumeAt);
    this.input.disconnect();
    this.input.connect(this.rawTap);
    if (on) { this.input.connect(this.keyNode); if (!this._keyWired) { this.keyNode.connect(this.low); this._keyWired = true; } }
    else this.input.connect(this.low);
    this.keylock = on;
    this._syncPitch();
    if (wasPlaying && this.track) this.play(resumeAt, resumePos);
  }
  _syncPitch(at = this.ctx.currentTime) {
    if (this.keyNode) this.keyNode.parameters.get('pitch').setValueAtTime(this.keylock ? 1 / this.rate : 1, at);
  }

  // mute / unmute a stem ('drums' | 'music') at ctx time `at` (short ramp, no click)
  setStem(name, on, at = this.ctx.currentTime) {
    const g = this.stemGain[name].gain;
    at = this.pre(at);
    g.cancelScheduledValues(at); g.setValueAtTime(on ? 0 : 1, at); g.linearRampToValueAtTime(on ? 1 : 0, at + 0.012);
    const flip = () => { this.stemOn[name] = on; };
    if (at <= this.ctx.currentTime + 0.01) flip(); else setTimeout(flip, (at - this.ctx.currentTime) * 1000);
  }

  setRate(r) {
    const now = this.ctx.currentTime;
    this.anchorPos = this.position(now); this.anchorCtx = now; this.rate = r;
    for (const s of this.srcs || []) s.playbackRate.setValueAtTime(r, now);
    this._syncPitch(now);
  }

  setEQ(band, db) {
    this.eqVals[band] = db;
    this[band].gain.setTargetAtTime(db <= -23.5 ? -40 : db, this.ctx.currentTime, 0.03);
  }
  // -1 = full lowpass, 0 = open, +1 = full highpass
  setFilter(v) {
    this.filterVal = v;
    const t = this.ctx.currentTime;
    const lp = v < 0 ? 22000 * Math.pow(180 / 22000, -v) : 22000;
    const hp = v > 0 ? 10 * Math.pow(3500 / 10, v) : 10;
    this.lp.frequency.setTargetAtTime(lp, t, 0.04);
    this.hp.frequency.setTargetAtTime(hp, t, 0.04);
  }

  // --- FX (slip mode: the main track keeps running muted underneath) ---
  _duck(at, dur) {
    const t = this.pre(at), g = this.input.gain;
    g.setValueAtTime(1, t); g.linearRampToValueAtTime(0, t + 0.004);
    g.setValueAtTime(0, t + dur - 0.004); g.linearRampToValueAtTime(1, t + dur);
  }

  // repeat a `slice`-beat chunk for `beats` beats starting at ctx time `at`
  // (pos: where to grab the loop, default = wherever the track is at `at`; rise: pitch multiplier reached at the end)
  loopRoll(at, slice = 0.25, beats = 1, pos = null, rise = 1) {
    if (!this.track || !this.playing) return;
    const spb = 60 / this.track.bpm;
    pos = pos ?? this.position(at);
    const src = this.ctx.createBufferSource();
    src.buffer = this.track.buffer;
    src.loop = true; src.loopStart = pos; src.loopEnd = pos + slice * spb;
    src.playbackRate.setValueAtTime(this.rate, at);
    if (rise !== 1) src.playbackRate.linearRampToValueAtTime(this.rate * rise, at + beats * spb / this.rate);
    const env = this.ctx.createGain();
    src.connect(env); env.connect(this.fxIn);
    const dur = beats * spb / this.rate;
    src.start(at, pos); src.stop(at + dur);
    env.gain.setValueAtTime(1, at); env.gain.setValueAtTime(1, at + dur - 0.005); env.gain.linearRampToValueAtTime(0, at + dur);
    this._duck(at, dur);
  }

  echoThrow(at, beats = 1) {
    const spb = 60 / (this.track?.bpm || 120) / this.rate;
    const g = this.echoSend.gain;
    g.setValueAtTime(0, at); g.linearRampToValueAtTime(0.9, at + 0.01);
    g.setValueAtTime(0.9, at + beats * spb); g.linearRampToValueAtTime(0, at + beats * spb + 0.02);
  }

  get reversed() {
    const t = this.track;
    if (!t.rev) {
      const b = t.buffer, r = this.ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
      for (let c = 0; c < b.numberOfChannels; c++) { const s = b.getChannelData(c), d = r.getChannelData(c); for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i]; }
      t.rev = r;
    }
    return t.rev;
  }

  // position (seconds) of beat index b of the track
  posOfBeat(b) { return this.track.firstBeat + b * 60 / this.track.bpm; }

  // turntablism: strokes back and forth over the beat under the needle, with crossfader patterns
  //   baby: plain back-and-forth   chirp: fader closes on each stroke end   transformer: fader chops 1/16s   flare: one click per stroke
  //   orbit (2-click flare, DJ Disk / Qbert's crew): two clicks per stroke   crab (Qbert): four rapid finger taps per stroke
  scratch(at, kind = 'baby', beats = 2) {
    if (!this.track || !this.playing) return;
    const spb = 60 / this.track.bpm / this.rate, dur = beats * spb;
    const p = this.posOfBeat(Math.floor(this.beatAt(at)));         // the hit on the current beat
    const len = 0.11;                                                 // seconds of record under the hand per stroke
    const strokeDur = kind === 'chirp' ? spb / 4 : spb / 2;
    const rev = this.reversed, D = this.track.buffer.duration;
    const out = this.ctx.createGain(); out.connect(this.fxIn);
    for (let t = at, k = 0; t < at + dur - 1e-3; t += strokeDur, k++) {
      const fwd = k % 2 === 0, src = this.ctx.createBufferSource(), g = this.ctx.createGain();
      src.buffer = fwd ? this.track.buffer : rev;
      const peak = 2 * len / strokeDur;                              // triangle hand motion covers `len` seconds
      src.playbackRate.setValueAtTime(0.05, t);
      src.playbackRate.linearRampToValueAtTime(peak, t + strokeDur / 2);
      src.playbackRate.linearRampToValueAtTime(0.05, t + strokeDur);
      const gg = g.gain;
      gg.setValueAtTime(0, t); gg.linearRampToValueAtTime(1, t + 0.004);
      if (kind === 'chirp') { if (fwd) gg.linearRampToValueAtTime(0, t + strokeDur * 0.9); else { gg.setValueAtTime(0, t); gg.linearRampToValueAtTime(1, t + strokeDur * 0.5); } }
      if (kind === 'transformer') { const q = spb / 8; for (let c = t + q; c < t + strokeDur; c += q) gg.setValueAtTime(((c - t) / q) % 2 < 1 ? 1 : 0, c); }
      if (kind === 'flare') { gg.setValueAtTime(0, t + strokeDur * 0.45); gg.setValueAtTime(1, t + strokeDur * 0.55); }
      if (kind === 'orbit') for (const c of [0.3, 0.62]) { gg.setValueAtTime(0, t + strokeDur * c); gg.setValueAtTime(1, t + strokeDur * (c + 0.08)); }
      if (kind === 'crab') for (let c = 0; c < 4; c++) { const u = t + strokeDur * (0.15 + c * 0.18); gg.setValueAtTime(0, u); gg.setValueAtTime(1, u + strokeDur * 0.07); }
      gg.linearRampToValueAtTime(0, t + strokeDur);
      src.connect(g); g.connect(out);
      src.start(t, fwd ? p : Math.max(0, D - p - len)); src.stop(t + strokeDur + 0.01);
    }
    this._duck(at, dur);
  }

  // tape stop / turntable brake over `beats`; the track slips underneath and drops back in afterwards
  brake(at, beats = 1) {
    if (!this.track || !this.playing) return;
    const dur = beats * 60 / this.track.bpm / this.rate;
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = this.track.buffer;
    src.playbackRate.setValueAtTime(this.rate, at); src.playbackRate.exponentialRampToValueAtTime(0.04, at + dur);
    g.gain.setValueAtTime(1, at); g.gain.setValueAtTime(1, at + dur * 0.8); g.gain.linearRampToValueAtTime(0, at + dur);
    src.connect(g); g.connect(this.fxIn); src.start(at, this.position(at)); src.stop(at + dur + 0.02);
    this._duck(at, dur);
  }

  // jump playback to track position `pos` exactly at ctx time `at` (use bar-aligned positions to stay in phase)
  jumpTo(at, pos) {
    if (!this.track) return;
    this.play(at, Math.max(0, Math.min(this.duration - 1, pos)));
  }
  // ctx time of the next bar line
  nextBarTime(at = this.ctx.currentTime + 0.05) { return this.timeOfBeat(Math.ceil(this.beatAt(at) / 4 - 1e-4) * 4); }

  // play the next `beats` of the track backwards (Pioneer-style reverse), slipping back in afterwards
  reverse(at, beats = 1) {
    if (!this.track || !this.playing) return;
    const spbT = 60 / this.track.bpm, dur = beats * spbT / this.rate, p = this.position(at), D = this.track.buffer.duration;
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = this.reversed; src.playbackRate.value = this.rate;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(1, at + 0.01); g.gain.setValueAtTime(1, at + dur - 0.01); g.gain.linearRampToValueAtTime(0, at + dur);
    src.connect(g); g.connect(this.fxIn);
    src.start(at, Math.max(0, D - p - beats * spbT)); src.stop(at + dur + 0.02);
    this._duck(at, dur);
  }

  // a one-shot slice of this track, played into `dest` (used for live chops and loop layering)
  slice(at, pos, len, { rate = this.rate, gain = 1, dest = this.fxIn, loopFor = 0, buffer = null } = {}) {
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = buffer || this.track.buffer; src.playbackRate.value = rate;
    const dur = loopFor || len / rate;
    if (loopFor) { src.loop = true; src.loopStart = pos; src.loopEnd = pos + len; }
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + 0.004);
    g.gain.setValueAtTime(gain, at + dur - 0.01); g.gain.linearRampToValueAtTime(0, at + dur);
    src.connect(g); g.connect(dest);
    src.start(at, pos); src.stop(at + dur + 0.02);
    return g;
  }

  // reverse spin-back of the last ~beats, then drop back in (slip) at the end
  backspin(at, beats = 2) {
    if (!this.track || !this.playing) return;
    const spb = 60 / this.track.bpm / this.rate;
    const dur = beats * spb;
    const buf = this.track.buffer;
    const pos = this.position(at);
    const len = Math.min(Math.floor(buf.sampleRate * 2.5), Math.floor(pos * buf.sampleRate));
    if (len < 1000) return;
    const rev = this.ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
    const start = Math.floor(pos * buf.sampleRate) - len;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c), d = rev.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = s[start + len - 1 - i];
    }
    const src = this.ctx.createBufferSource();
    src.buffer = rev;
    src.playbackRate.setValueAtTime(2.8, at);
    src.playbackRate.exponentialRampToValueAtTime(0.25, at + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(1, at); env.gain.setValueAtTime(1, at + dur * 0.7); env.gain.linearRampToValueAtTime(0, at + dur);
    src.connect(env); env.connect(this.fxIn);
    src.start(at); src.stop(at + dur);
    this._duck(at, dur);
  }
}
