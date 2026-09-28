// Two-deck DJ mixer: per-deck EQ, filter, loop roll, echo throw, backspin; equal-power crossfader.

const dbToGain = (db) => Math.pow(10, db / 20);

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

    // echo bus (dotted-eighth delay, tempo-synced by setTempo)
    this.echoIn = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.fb = ctx.createGain(); this.fb.gain.value = 0.45;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
    this.echoIn.connect(this.delay); this.delay.connect(hp); hp.connect(this.fb); this.fb.connect(this.delay);
    hp.connect(this.master);
    this.setTempo(124);

    this.decks = [new Deck(ctx, 'A', this), new Deck(ctx, 'B', this)];
    this.x = 0; // 0 = full A, 1 = full B
    this.setCrossfader(0);
  }
  setTempo(bpm) {
    this.bpm = bpm;
    this.delay.delayTime.setTargetAtTime(0.75 * 60 / bpm, this.ctx.currentTime, 0.05);
  }
  setCrossfader(x) {
    this.x = Math.min(1, Math.max(0, x));
    const t = this.ctx.currentTime;
    this.decks[0].xf.gain.setTargetAtTime(Math.cos(this.x * Math.PI / 2), t, 0.02);
    this.decks[1].xf.gain.setTargetAtTime(Math.sin(this.x * Math.PI / 2), t, 0.02);
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
    this.fxIn = ctx.createGain();        // loop rolls / backspins go here
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.7;
    this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4000;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 0.9;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.9;
    this.tap = ctx.createGain();         // pre-fader cue (what the fly hears in split mode)
    this.xf = ctx.createGain();
    this.echoSend = ctx.createGain(); this.echoSend.gain.value = 0;

    this.input.connect(this.low); this.fxIn.connect(this.low);
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
    this.anchorPos = track.cue ?? track.firstBeat;
    this.rate = 1;
  }

  play(at = this.ctx.currentTime, pos = this.anchorPos) {
    if (!this.track) return;
    this._stopSrc();
    const src = this.ctx.createBufferSource();
    src.buffer = this.track.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.input);
    const startPos = Math.max(0, pos);
    src.start(Math.max(at, this.ctx.currentTime), startPos);
    src.onended = () => { if (this.src === src) { this.playing = false; this.anchorPos = this.duration; this.onEnded?.(this); } };
    this.src = src;
    this.anchorCtx = Math.max(at, this.ctx.currentTime);
    this.anchorPos = startPos;
    this.playing = true;
  }

  stop() {
    if (this.playing) this.anchorPos = this.position();
    this._stopSrc();
    this.playing = false;
  }
  _stopSrc() {
    if (this.src) { this.src.onended = null; try { this.src.stop(); } catch (e) {} this.src.disconnect(); this.src = null; }
  }

  setRate(r) {
    const now = this.ctx.currentTime;
    this.anchorPos = this.position(now); this.anchorCtx = now; this.rate = r;
    if (this.src) this.src.playbackRate.setValueAtTime(r, now);
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
    this.input.gain.setValueAtTime(1, at);
    this.input.gain.linearRampToValueAtTime(0, at + 0.004);
    this.input.gain.setValueAtTime(0, at + dur - 0.004);
    this.input.gain.linearRampToValueAtTime(1, at + dur);
  }

  // repeat a `slice`-beat chunk for `beats` beats starting at ctx time `at`
  loopRoll(at, slice = 0.25, beats = 1) {
    if (!this.track || !this.playing) return;
    const spb = 60 / this.track.bpm;
    const pos = this.position(at);
    const src = this.ctx.createBufferSource();
    src.buffer = this.track.buffer;
    src.loop = true; src.loopStart = pos; src.loopEnd = pos + slice * spb;
    src.playbackRate.value = this.rate;
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
