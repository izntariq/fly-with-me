// DJ performance moves, shared by the fly (autopilot) and the human (pads / keyboard).
// Everything is quantized to the on-air deck's beat grid.
//
// Moves modelled on what headline DJs actually do:
//   cue build & drop  (Carl Cox)     roll the same cue point with halving loop lengths, HPF + riser + reverb wash,
//                                     one silent beat, then slam into the drop
//   FX as an instrument (Hawtin)     echo / reverb throws, flanger, trans gate, crush, filter dips
//   turntablism (Qbert, Jazzy Jeff)  baby scratch, chirp, transformer, flare
//   transitions                      phrase-aligned EQ blend with bass swap, echo-out cut, drop swap, spinback cut
//   desi                             air horn, dhol roll build, siren

export class Performer {
  constructor(mixer, synth, log) {
    this.mixer = mixer; this.fx = mixer.fx; this.sampler = mixer.sampler; this.synth = synth; this.log = log;
    this.busyUntil = 0;           // a build-up in progress blocks other big moves
    this.onActivity = null;       // (name) => void, for lighting pads
  }
  get ctx() { return this.mixer.ctx; }
  get on() { return this.mixer.onAir(); }
  get off() { return this.mixer.offAir(); }
  get spb() { return 60 / (this.on.bpm || 120); }
  get desi() { return this.on.track?.style === 'desi'; }
  nextBeat() { const d = this.on; return d.playing ? d.nextBeatTime(1) : this.ctx.currentTime + 0.05; }
  nextBar() { const d = this.on; return d.playing ? d.nextBarTime() : this.ctx.currentTime + 0.05; }
  busy() { return this.ctx.currentTime < this.busyUntil; }
  _lit(name) { this.onActivity?.(name); }

  // ---------------- beat FX ----------------
  beatFx(kind, beats = 1, who = '') {
    const at = this.nextBeat(), on = this.on, fx = this.fx;
    if (kind === 'echo') on.echoThrow(at, beats);
    else if (kind === 'reverb') fx.reverbThrow(at, beats);
    else if (kind === 'flanger') fx.flange(at, Math.max(2, beats));
    else if (kind === 'trans') fx.trans(at, beats, beats >= 2 ? 4 : 8);
    else if (kind === 'crush') fx.crush(at, beats);
    else if (kind === 'lpf') fx.lowpassDip(at, Math.max(2, beats));
    else if (kind === 'sweep') fx.sweep(at, Math.max(2, beats), 1500);
    this._lit(kind);
    if (who) this.log(`${who} → ${kind} (${beats} beat${beats > 1 ? 's' : ''})`);
  }

  roll(slice = 0.25, beats = 1, who = '') {
    const at = this.nextBeat();
    this.on.loopRoll(at, slice, beats);
    this._lit('roll');
    if (who) this.log(`${who} → 1/${Math.round(1 / slice)} loop roll`);
  }

  scratch(kind = 'baby', beats = 2, who = '') {
    const at = this.nextBeat();
    this.on.scratch(at, kind, beats);
    this._lit('scratch');
    if (who) this.log(`${who} → ${kind} scratch`);
  }

  brake(who = '') { const at = this.nextBeat(); this.on.brake(at, 1); this._lit('brake'); if (who) this.log(`${who} → tape stop`); }
  backspin(who = '') { const at = this.nextBeat(); this.on.backspin(at, 2); this._lit('backspin'); if (who) this.log(`${who} → spinback`); }

  beatJump(beats = 4) {
    const d = this.on, at = d.nextBarTime();
    d.jumpTo(at, d.position(at) + beats * 60 / d.track.bpm);
    this.log(`beat jump ${beats > 0 ? '+' : ''}${beats} on deck ${d.name}`);
  }

  hotCue(deck, idx) {
    const cue = deck.track?.cues?.[idx];
    if (!cue) return;
    const other = this.mixer.decks.find((d) => d !== deck);
    // quantize to the bar grid of whichever deck is on air (keeps both decks in phase)
    const ref = this.mixer.airness(deck) > 0.5 || !other.playing ? deck : other;
    const at = ref.playing ? ref.nextBarTime() : this.ctx.currentTime + 0.05;
    deck.jumpTo(at, deck.posOfBeat(cue.beat));
    this.log(`deck ${deck.name} → hot cue "${cue.name}"`);
  }

  sample(kind, who = '') {
    const at = this.ctx.currentTime + 0.01, s = this.sampler;
    if (kind === 'horn') s.airhorn(at);
    else if (kind === 'siren') s.siren(at, 2 * this.spb * 2);
    else if (kind === 'laser') s.laser(at);
    else if (kind === 'boom') s.boom(at);
    else if (kind === 'riser') s.riser(this.nextBar(), 4 * this.spb * 2);
    else if (kind === 'dhol') s.dholRoll(this.nextBeat(), 4, this.spb);
    this._lit(kind);
    if (who) this.log(`${who} → ${kind === 'horn' ? '📯 air horn' : kind}`);
  }

  // ---------------- the big one: cue build & drop ----------------
  // bars of build; at the drop: optional swap to the other deck's drop, or jump this deck to its own drop cue
  buildDrop({ bars = 4, swap = false, who = '' } = {}) {
    const on = this.on;
    if (!on.playing || this.busy()) return false;
    const spb = 60 / on.track.bpm / on.rate, T0 = on.nextBarTime(), beats = bars * 4, Td = T0 + beats * spb;
    const pos0 = on.position(T0);
    // roll the same cue point with halving lengths: 1/2 → 1/4 → 1/8 → 1/16 (last bar rises in pitch)
    const plan = bars >= 4 ? [0.5, 0.25, 0.125, 0.0625] : [0.25, 0.0625];
    const per = beats / plan.length;
    plan.forEach((slice, k) => {
      const last = k === plan.length - 1, len = last ? per - 1 : per;       // final beat is the silent gap
      on.loopRoll(T0 + k * per * spb, slice, len, pos0, last ? 1.12 : 1);
    });
    this.fx.sweep(T0, beats - 1, 1400);
    this.fx.reverbWash(T0, beats - 1, 0.75);
    this.sampler.riser(T0, (beats - 1) * spb);
    if (this.desi) this.sampler.dholRoll(T0 + (beats - 8) * spb, 7, spb);
    this.fx.gap(Td - spb, spb);                                               // one beat of reverb-tail silence
    // the drop
    const target = swap && this.off.playing ? this.off : on;
    const cues = target.track.cues || [];
    const dropCue = cues.find((c) => c.name.startsWith('drop') && target.posOfBeat(c.beat) > target.position(Td) + 1) || cues.find((c) => c.name === 'drop');
    // jump to the drop if swapping decks, or if this deck's next drop is coming up soon anyway (≤16 bars away);
    // otherwise the track just slips back in where it would have been
    const ahead = dropCue ? target.posOfBeat(dropCue.beat) - target.position(Td) : Infinity;
    if (dropCue && (target !== on || (ahead > 0 && ahead < 64 * 60 / target.track.bpm))) target.jumpTo(Td, target.posOfBeat(dropCue.beat));
    if (target !== on) this.mixer.cutTo(target === this.mixer.decks[0] ? 0 : 1, Td);
    this.sampler.boom(Td);
    this.sampler.airhorn(Td + 0.01);
    this.synth.zap?.(Td);
    this.busyUntil = Td + 2 * spb;
    this._lit('build');
    this.log(`${who || 'you'} → <b>${bars}-bar cue build</b> on deck ${on.name}${target !== on ? `, dropping into deck ${target.name}` : ''}`);
    return Td;
  }

  // ---------------- transitions ----------------
  // echo out the on-air deck and cut to the other on the next bar
  echoOut(who = '') {
    const on = this.on, off = this.off;
    if (!off.playing) return false;
    const at = on.nextBarTime(), spb = 60 / on.track.bpm / on.rate;
    on.echoThrow(at - spb, 1);
    const fb = this.mixer.fb.gain;
    fb.setValueAtTime(0.72, at - spb); fb.setValueAtTime(0.72, at + 4 * spb); fb.linearRampToValueAtTime(0.45, at + 6 * spb);
    this.mixer.cutTo(off === this.mixer.decks[0] ? 0 : 1, at);
    this._lit('echo');
    this.log(`${who || 'you'} → <b>echo out</b> deck ${on.name}, cut to deck ${off.name}`);
    return at;
  }

  dropSwap(who = '') {
    if (!this.off.playing) return false;
    return this.buildDrop({ bars: 2, swap: true, who });
  }

  spinCut(who = '') {
    const on = this.on, off = this.off;
    if (!off.playing) return false;
    const at = on.nextBeatTime(1), spb = 60 / on.track.bpm / on.rate;
    on.backspin(at, 2);
    const land = on.timeOfBeat(Math.ceil(on.beatAt(at + 2 * spb) / 4 - 1e-4) * 4);
    this.mixer.cutTo(off === this.mixer.decks[0] ? 0 : 1, land);
    this.log(`${who || 'you'} → <b>spinback</b> deck ${on.name}, drop into deck ${off.name}`);
    return land;
  }
}
