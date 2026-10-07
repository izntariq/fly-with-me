// Two-deck DJ mixer: per-deck EQ, filter, loop roll, echo throw, backspin, scratching, brake, hot cues;
// equal-power crossfader; master bus runs through the FX rack.

import { FXRack, Sampler, holdAt } from './fx.js';

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
    // beat FX run on the beat you hear (the on-air deck's grid), which is twice or half the master on a folded track
    this.fx.beat = () => { const d = this.onAir(); return d.playing && d.bpm ? 60 / d.bpm : 60 / this.bpm; };
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

  // playback rate that puts `track` at `bpm`, folding half / double time. The fold is picked once per load (and again if
  // the track's tempo is corrected) and then kept: re-folding as the master tempo moves would halve or double the rate
  // in one step when a glide or the ride crosses the fold point
  rateFor(track, bpm) {
    if (track._foldBpm !== track.bpm) { const r = bpm / track.bpm; track._fold = r > 1.4 ? 0.5 : r < 0.7 ? 2 : 1; track._foldBpm = track.bpm; }
    return bpm / track.bpm * track._fold;
  }
  // the master tempo at which `track` plays at its own speed (its BPM in the set's frame, after the fold)
  tempoOf(track) { return track.bpm / (track._foldBpm === track.bpm ? track._fold : 1); }
  // master tempo: every playing deck follows it, phase stays locked because they all change at the same instant
  applyTempo(bpm) {
    this.masterBpm = bpm;
    for (const d of this.decks) if (d.track && d.playing) d.setRate(this.rateFor(d.track, bpm));
    this.setTempo(bpm);
  }
  setTempo(bpm) {
    this.bpm = bpm;
    if (this.fx) this.fx.bpm = bpm;
    // slowly: retuning a delay that is still ringing bends the pitch of its tail (an echo out into a new tempo)
    this.delay.delayTime.setTargetAtTime(0.75 * 60 / bpm, this.ctx.currentTime, 0.5);
  }
  setCrossfader(x) {
    this.x = Math.min(1, Math.max(0, x));
    const t = this.ctx.currentTime;
    this.decks[0].xf.gain.setTargetAtTime(Math.cos(this.x * Math.PI / 2), t, 0.02);
    this.decks[1].xf.gain.setTargetAtTime(Math.sin(this.x * Math.PI / 2), t, 0.02);
  }
  // hard cut of the crossfader at an exact (beat-aligned) time, over ~5 ms so a sustained bass doesn't click
  cutTo(x, at) {
    const [A, B] = this.decks;
    A.xf.gain.cancelScheduledValues(at); B.xf.gain.cancelScheduledValues(at);
    A.xf.gain.setTargetAtTime(Math.cos(x * Math.PI / 2), at, 0.0012);
    B.xf.gain.setTargetAtTime(Math.sin(x * Math.PI / 2), at, 0.0012);
    this.lockUntil = at + 0.05;
    // the fader position takes the cut when the audio clock gets there (read through `x`), not on a main-thread timer:
    // a hidden page's timers can run a second late while the control loop (a worker's timer) keeps ticking, and in
    // that second the fly would see the old deck still on air and line up another transition
    this._cuts = [...(this._cuts || []).filter((c) => c.at < at), { x, at }];
  }
  get x() {
    const now = this.ctx.currentTime;
    while (this._cuts?.length && this._cuts[0].at <= now) this._x = this._cuts.shift().x;
    return this._x;
  }
  set x(v) { this._x = v; }
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

    this.input = ctx.createGain();       // main source goes here
    this.slip = ctx.createGain();        // ...then this, which FX mute while the track keeps running (slip mode)
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

    this.input.connect(this.slip); this.slip.connect(this.low); this.fxIn.connect(this.low);
    // rawTap is fed straight from each playing source (play), before stem mutes and the slip mute: listener flies hear
    // the whole track even under a roll, a scratch or "drums out"
    this.ducks = [];                     // [t0, t1, level] slip-mute intervals; overlapping moves share one schedule
    this.jumps = [];                     // scheduled jumps, in time order: each { ctx, pos } takes over the timeline at ctx
    this.outs = [];                      // sources a scheduled jump has taken over from, playing until their stop time
    this.low.connect(this.mid); this.mid.connect(this.high); this.high.connect(this.lp); this.lp.connect(this.hp);
    this.hp.connect(this.tap); this.tap.connect(this.xf); this.xf.connect(mixer.master);
    this.tap.connect(this.echoSend); this.echoSend.connect(mixer.echoIn);
  }

  get bpm() { return this.track ? this.track.bpm * this.rate : 0; }
  get duration() { return this.track ? this.track.buffer.duration : 0; }
  // the timeline in effect at ctx time `at`: a scheduled jump only takes over once its time comes
  _promote() {
    const now = this.ctx.currentTime;
    while (this.jumps.length && now >= this.jumps[0].ctx) { const j = this.jumps.shift(); this.anchorCtx = j.ctx; this.anchorPos = j.pos; }
  }
  // [[ctx, pos], ...]: the anchor, then each scheduled jump
  _timeline() { this._promote(); return [[this.anchorCtx, this.anchorPos], ...this.jumps.map((j) => [j.ctx, j.pos])]; }
  position(at = this.ctx.currentTime) {
    if (!this.playing) return this.anchorPos;
    const tl = this._timeline();
    let k = 0; while (k + 1 < tl.length && at >= tl[k + 1][0]) k++;
    return tl[k][1] + (at - tl[k][0]) * this.rate;
  }
  // beat index (float) at ctx time `at`
  beatAt(at = this.ctx.currentTime) {
    if (!this.track) return 0;
    return (this.position(at) - this.track.firstBeat) * this.track.bpm / 60;
  }
  // ctx time at which beat index `b` will play (assumes constant rate)
  // (the first time at or after `after`: a jump back plays some beats twice)
  timeOfBeat(b, after = -Infinity) {
    const pos = this.track.firstBeat + b * 60 / this.track.bpm, tl = this._timeline();
    for (let i = 0; i < tl.length; i++) {                // the first timeline piece that reaches `pos` while it is in effect
      const t = tl[i][0] + (pos - tl[i][1]) / this.rate;
      if ((i === 0 || t >= tl[i][0]) && t < (tl[i + 1]?.[0] ?? Infinity) && t >= after) return t;
    }
    return tl[0][0] + (pos - tl[0][1]) / this.rate;
  }
  nextBeatTime(div = 1, at = this.ctx.currentTime) {
    const b = this.beatAt(at);
    return this.timeOfBeat(Math.ceil((b + 1e-4) * div) / div, at - 1e-3);
  }

  load(track) {
    this.stop();
    this.track = track;
    this.setStem('drums', true); this.setStem('music', true);
    this.anchorPos = track.cue ?? track.firstBeat;
    this.rate = 1;
    track._foldBpm = null;                // the half / double-time fold is picked afresh against the tempo it joins
  }

  get hasStems() { return !!this.track?.stems; }
  // key lock delays what you hear by a fixed amount; everything before the shifter is scheduled that much earlier,
  // so the audible deck lines up with rolls, scratches, the fly's synth and the sampler (which bypass it)
  get lat() { return this.keylock ? (this.mixer.keylockLatency || 0) : 0; }
  pre(t) { return Math.max(this.ctx.currentTime, t - this.lat); }

  // start (or jump) playback at track position `pos`, heard at ctx time `at`. Whatever is playing keeps playing until
  // then and crossfades out over a few ms, so a jump scheduled a bar ahead doesn't leave a bar of silence
  play(at = this.ctx.currentTime, pos = this.anchorPos) {
    if (!this.track) return;
    // `when` is when it will be heard; the source starts `lat` earlier (or now, and is heard `lat` later)
    const startPos = Math.max(0, pos), when = Math.max(at, this.ctx.currentTime + this.lat), srcAt = this.pre(when);
    const wasPlaying = this.playing && (this.srcs || []).length;
    this._stopSrc(srcAt);
    const mk = (buffer, dest) => {
      const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
      s.buffer = buffer; s.playbackRate.value = this.rate; s.connect(g); g.connect(dest); g.connect(this.rawTap);
      g.gain.setValueAtTime(0, srcAt); g.gain.linearRampToValueAtTime(1, srcAt + 0.005);
      s.start(srcAt, startPos); s._g = g; s._t0 = srcAt; s._t1 = Infinity;
      return s;
    };
    this._syncPitch(when);
    const st = this.track.stems;
    this.srcs = st ? [mk(st.drums, this.stemGain.drums), mk(st.music, this.stemGain.music)] : [mk(this.track.buffer, this.input)];
    const src = this.srcs[0];
    src.onended = () => { if (this.src === src) { this.playing = false; this.anchorPos = this.duration; this.jumps = []; this.onEnded?.(this); } };
    this.src = src;
    // a later play supersedes the jumps scheduled from its time on
    const heard = srcAt + this.lat;
    this.jumps = this.jumps.filter((j) => j.ctx < heard);
    if (wasPlaying && srcAt > this.ctx.currentTime + 0.002) this.jumps.push({ ctx: heard, pos: startPos });
    else { this.jumps = []; this.anchorCtx = heard; this.anchorPos = startPos; }
    this.playing = true;
  }

  stop() {
    if (this.playing) this.anchorPos = this.position();
    this._stopSrc();
    this.playing = false; this.jumps = [];
  }
  // stop every source still sounding at ctx time `at` (default now) with a short fade, so cuts don't click: the
  // playing ones, and those a scheduled jump has yet to take over from (else they would play on until that jump)
  _stopSrc(at = this.ctx.currentTime) {
    if (this.src) this.src.onended = null;
    const now = this.ctx.currentTime, t = Math.max(at, now);
    this.outs = this.outs.filter((s) => s._t1 > now);
    for (const s of [...(this.srcs || []), ...this.outs]) {
      if (s._t1 <= t) continue;                          // already stopping before then
      const g = s._g?.gain;
      if (g) { g.cancelScheduledValues(t); g.setValueAtTime(t >= s._t0 + 0.005 ? 1 : 0, t); g.linearRampToValueAtTime(0, t + 0.005); }
      try { s.stop(t + 0.006); } catch (e) {}
      s._t1 = t + 0.006;
      clearTimeout(s._gc);
      s._gc = setTimeout(() => { try { s.disconnect(); s._g?.disconnect(); } catch (e) {} }, (t - now + 0.1) * 1000);
    }
    this.outs = [...this.outs, ...(this.srcs || [])].filter((s) => s._t1 > now);
    this.srcs = []; this.src = null;
  }

  // route the deck through its key-lock pitch shifter (pitch = 1/rate cancels the vinyl-style pitch change)
  setKeylock(on) {
    if (!this.keyNode) return;
    const wasPlaying = this.playing, resumeAt = this.ctx.currentTime + 0.06;
    this.slip.disconnect();
    if (on) { this.slip.connect(this.keyNode); if (!this._keyWired) { this.keyNode.connect(this.low); this._keyWired = true; } }
    else this.slip.connect(this.low);
    this.keylock = on;
    this._syncPitch();
    if (wasPlaying && this.track) this.respawn(resumeAt);         // (keeps a cue jump that's still to come)
  }
  _syncPitch(at = this.ctx.currentTime) {
    if (this.keyNode) this.keyNode.parameters.get('pitch').setValueAtTime(this.keylock ? 1 / this.rate : 1, at);
  }

  // mute / unmute a stem ('drums' | 'music') at ctx time `at` (short ramp, no click)
  setStem(name, on, at = this.ctx.currentTime) {
    const g = this.stemGain[name].gain;
    at = this.pre(at);
    g.cancelScheduledValues(at); g.setTargetAtTime(on ? 1 : 0, at, 0.004);      // from wherever it is: no dip if unchanged
    const flip = () => { this.stemOn[name] = on; };
    if (at <= this.ctx.currentTime + 0.01) flip(); else setTimeout(flip, (at - this.ctx.currentTime) * 1000);
  }

  setRate(r) {
    const now = this.ctx.currentTime;
    this.anchorPos = this.position(now); this.anchorCtx = now;
    this.rate = r;
    for (const s of [...(this.srcs || []), ...this.outs]) s.playbackRate.setValueAtTime(r, now);
    this._syncPitch(now);
  }

  // `at`: a ctx time to schedule it for (on the audio clock, so a kill lands with the cut it goes with; the EQ sits after
  // the key-lock shifter, so no latency offset)
  setEQ(band, db, at = null) {
    const now = this.ctx.currentTime, t = at == null ? now : Math.max(now, at);
    this[band].gain.setTargetAtTime(db <= -23.5 ? -40 : db, t, at == null ? 0.03 : 0.008);
    if (t <= now + 0.01) this.eqVals[band] = db; else setTimeout(() => { this.eqVals[band] = db; }, (t - now) * 1000);
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
  // mute (or turn down to `level`) the main track from `at` for `dur`. Overlapping ducks are merged into one schedule
  // (the lowest level wins), so a second roll inside a first one can't unmute the track halfway through
  _duck(at, dur, level = 0) {
    const now = this.ctx.currentTime, t0 = this.pre(at);
    this.ducks = this.ducks.filter((d) => d[1] > now);
    this.ducks.push([t0, t0 + dur, level]);
    const g = this.slip.gain, R = 0.004;
    const lvl = (t) => this.ducks.reduce((m, [a, b, l]) => (t >= a && t < b ? Math.min(m, l) : m), 1);
    const ts = [...new Set(this.ducks.flat().filter((t, i) => i % 3 !== 2 && t > now))].sort((x, y) => x - y);
    let cur = lvl(now);
    g.cancelScheduledValues(now); g.setValueAtTime(cur, now);
    for (const t of ts) {
      const v = lvl(t);
      if (v !== cur) { g.setValueAtTime(cur, t); g.linearRampToValueAtTime(v, t + R); cur = v; }
    }
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
    holdAt(g, at, 0, at + beats * spb + 0.02); g.linearRampToValueAtTime(0.9, at + 0.01);   // a throw inside another one extends it, no gap
    g.setValueAtTime(0.9, at + beats * spb); g.linearRampToValueAtTime(0, at + beats * spb + 0.02);
  }

  // the track between positions `from` and `to` (seconds), reversed: sample i is the track at `to` − i / rate. Only the
  // few seconds a move needs, not a reversed copy of the whole track (~100 MB) kept for the rest of the set
  reversedWindow(from, to) {
    const b = this.track.buffer, sr = b.sampleRate;
    const i0 = Math.max(0, Math.floor(from * sr)), i1 = Math.min(b.length, Math.ceil(to * sr)), n = Math.max(1, i1 - i0);
    const r = this.ctx.createBuffer(b.numberOfChannels, n, sr);
    for (let c = 0; c < b.numberOfChannels; c++) { const s = b.getChannelData(c), d = r.getChannelData(c); for (let i = 0; i < n; i++) d[i] = s[i1 - 1 - i] ?? 0; }
    return { buf: r, to: i1 / sr };
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
    const rev = this.reversedWindow(Math.max(0, p - 0.1), p + len);
    const out = this.ctx.createGain(); out.connect(this.fxIn);
    for (let t = at, k = 0; t < at + dur - 1e-3; t += strokeDur, k++) {
      const fwd = k % 2 === 0, src = this.ctx.createBufferSource(), g = this.ctx.createGain();
      src.buffer = fwd ? this.track.buffer : rev.buf;
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
      src.start(t, fwd ? p : Math.max(0, rev.to - p - len)); src.stop(t + strokeDur + 0.01);   // back from p + len
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
  // new sources from ctx time `at` (stems just arrived), same timeline: the jumps still to come are scheduled again
  respawn(at) {
    if (!this.track || !this.playing) return;
    const later = this.jumps.filter((j) => j.ctx > at);
    this.play(at, this.position(at));
    for (const j of later) this.play(j.ctx, j.pos);
  }
  // ctx time of the next bar line
  nextBarTime(at = this.ctx.currentTime + 0.05) { return this.timeOfBeat(Math.ceil(this.beatAt(at) / 4 - 1e-4) * 4, at - 1e-3); }

  // play the next `beats` of the track backwards (Pioneer-style reverse), slipping back in afterwards
  reverse(at, beats = 1) {
    if (!this.track || !this.playing) return;
    const spbT = 60 / this.track.bpm, dur = beats * spbT / this.rate, p = this.position(at);
    const rev = this.reversedWindow(p, p + beats * spbT);
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = rev.buf; src.playbackRate.value = this.rate;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(1, at + 0.01); g.gain.setValueAtTime(1, at + dur - 0.01); g.gain.linearRampToValueAtTime(0, at + dur);
    src.connect(g); g.connect(this.fxIn);
    src.start(at, Math.max(0, rev.to - p - beats * spbT)); src.stop(at + dur + 0.02);
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
