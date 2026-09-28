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
    this.onBuild = null;          // (T0, Td) => void, e.g. the MC hyping the drop
    this.buildKind = null;        // () => 'roll' | 'snare' | 'stutter' | 'filter'
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
    else if (kind === 'co2') s.co2(at);
    this._lit(kind);
    if (who) this.log(`${who} → ${kind === 'horn' ? '📯 air horn' : kind}`);
  }

  // ---------------- the big one: cue build & drop ----------------
  // bars of build; at the drop: optional swap to the other deck's drop, or jump this deck to its own drop cue
  // startBeat: begin the build at this beat of the on-air track (so it can end exactly on the track's own drop)
  //
  // kind:  'roll'    Carl Cox cue build: roll the same cue point 1/2 → 1/4 → 1/8 → 1/16, last bar pitching up
  //        'snare'   big-room (Guetta / Garrix / Tiësto): track keeps playing under an accelerating snare roll,
  //                  high-pass sweep and riser, one beat of silence, then the drop
  //        'stutter' bass / dubstep (Skrillex): hard 1/8 → 1/32 rolls with bit-crush and a steep pitch rise
  //        'filter'  house / techno: a long filter + reverb build, no roll, no horn — the groove never stops
  buildDrop({ bars = 4, swap = false, who = '', startBeat = null, kind = null, horn = true, gap = true } = {}) {
    kind ||= this.buildKind?.() || 'roll';          // default: the build-style selector / the DJ style's favourite
    const on = this.on;
    if (!on.playing || this.busy()) return false;
    const spb = 60 / on.track.bpm / on.rate, beats = bars * 4;
    const T0 = startBeat != null && on.timeOfBeat(startBeat) > this.ctx.currentTime + 0.1 ? on.timeOfBeat(startBeat) : on.nextBarTime();
    const Td = T0 + beats * spb;
    const pos0 = on.position(T0);
    const tail = gap ? 1 : 0;                                                  // final beat is the silent gap
    if (kind === 'roll' || kind === 'stutter') {
      const plan = kind === 'stutter' ? [0.125, 0.0625, 0.03125] : bars >= 4 ? [0.5, 0.25, 0.125, 0.0625] : [0.25, 0.0625];
      const per = beats / plan.length;
      plan.forEach((slice, k) => {
        const last = k === plan.length - 1, len = last ? per - tail : per;
        on.loopRoll(T0 + k * per * spb, slice, len, pos0, last ? (kind === 'stutter' ? 1.5 : 1.12) : 1);
      });
      if (kind === 'stutter') this.fx.crush(T0 + beats * spb * 0.66, beats * 0.34 - tail);
    }
    if (kind === 'snare') this.sampler.snareRoll(T0, beats - tail, spb);
    this.fx.sweep(T0, beats - tail, kind === 'filter' ? 900 : 1400);
    this.fx.reverbWash(T0, beats - tail, kind === 'filter' ? 0.5 : 0.75);
    if (kind !== 'filter') this.sampler.riser(T0, (beats - tail) * spb);
    if (this.desi) this.sampler.dholRoll(T0 + (beats - 8) * spb, 8 - tail, spb);
    if (gap) this.fx.gap(Td - spb, spb);
    // the drop
    const target = swap && this.off.playing ? this.off : on;
    const cues = target.track.cues || [];
    const dropCue = cues.find((c) => c.name.startsWith('drop') && target.posOfBeat(c.beat) > target.position(Td) + 1) || cues.find((c) => c.name === 'drop');
    // jump to the drop if swapping decks, or if this deck's next drop is coming up soon anyway (≤16 bars away);
    // otherwise the track just slips back in where it would have been
    const ahead = dropCue ? target.posOfBeat(dropCue.beat) - target.position(Td) : Infinity;
    if (dropCue && (target !== on || (ahead > 0 && ahead < 64 * 60 / target.track.bpm))) target.jumpTo(Td, target.posOfBeat(dropCue.beat));
    if (target !== on) this.mixer.cutTo(target === this.mixer.decks[0] ? 0 : 1, Td);
    if (kind !== 'filter') { this.sampler.boom(Td); this.sampler.downlifter(Td + 0.05, 4 * spb); }
    if (horn) this.sampler.airhorn(Td + 0.01);
    this.synth.zap?.(Td);
    this.busyUntil = Td + 2 * spb;
    this.onBuild?.(T0, Td);
    this._lit('build');
    const name = { roll: 'cue build', snare: 'snare-roll build', stutter: 'stutter build', filter: 'filter build' }[kind];
    this.log(`${who || 'you'} → <b>${bars}-bar ${name}</b> on deck ${on.name}${target !== on ? `, dropping into deck ${target.name}` : ''}`);
    return Td;
  }

  // ---------------- signature moves of the big names ----------------
  // live chops (Fred again..): grab 4 one-beat slices of the on-air track's mids (where vocals live) and
  // re-trigger them on 16ths. `pattern` is 16 slice indices (or -1 = rest) per bar; the fly builds it from spikes.
  chop({ bars = 2, pattern = null, who = '' } = {}) {
    const on = this.on;
    if (!on.playing) return false;
    const spbT = 60 / on.track.bpm, spb = spbT / on.rate, T0 = on.nextBarTime(), p0 = on.position(T0);
    // slice the music stem when there is one (vocals / melody without drums); otherwise band-pass the mix
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = on.hasStems ? 0.2 : 0.6;
    const g = this.ctx.createGain(); g.gain.value = 1.4; bp.connect(g); g.connect(on.fxIn);
    const buf = on.hasStems ? on.track.stems.music : null;
    const slices = [0, 1, 2, 3].map((k) => p0 - (4 - k) * spbT);             // the last bar, beat by beat
    const pitches = [1, 1, Math.pow(2, 3 / 12), Math.pow(2, -5 / 12)];
    const pat = pattern || Array.from({ length: 16 }, (_, k) => (k % 4 === 3 ? -1 : Math.floor(Math.random() * 4)));
    for (let n = 0; n < bars * 16; n++) {
      const idx = pat[n % pat.length];
      if (idx < 0) continue;
      on.slice(T0 + n * spb / 4, Math.max(0, slices[idx]), spbT / 4, { rate: on.rate * pitches[idx], gain: 0.9, dest: bp, buffer: buf });
    }
    // duck the track a little so the chops sit on top
    on.input.gain.setValueAtTime(1, T0); on.input.gain.linearRampToValueAtTime(0.45, T0 + 0.02);
    on.input.gain.setValueAtTime(0.45, T0 + bars * 4 * spb - 0.02); on.input.gain.linearRampToValueAtTime(1, T0 + bars * 4 * spb);
    this._lit('chop');
    this.log(`${who || 'you'} → <b>live chops</b> of "${on.track.name}" for ${bars} bars`);
    return T0;
  }

  // double drop: both decks hit their drop together (one bassline kept), then settle on the other deck
  doubleDrop({ bars = 16, who = '' } = {}) {
    const on = this.on, off = this.off;
    if (!off.playing || this.busy()) return false;
    const Td = this.buildDrop({ bars: 2, kind: 'snare', who });
    if (!Td) return false;
    const dropOf = (d) => (d.track.cues || []).find((c) => c.name === 'drop');
    const dOff = dropOf(off);
    if (dOff) off.jumpTo(Td, off.posOfBeat(dOff.beat));
    this.mixer.cutTo(0.5, Td);
    const spb = 60 / on.track.bpm / on.rate, end = Td + bars * 4 * spb;
    setTimeout(() => off.setEQ('low', -24), Math.max(0, (Td - this.ctx.currentTime) * 1000));
    this.mixer.cutTo(off === this.mixer.decks[0] ? 0 : 1, end);
    setTimeout(() => off.setEQ('low', 0), Math.max(0, (end - this.ctx.currentTime) * 1000));
    this.mixer.lockUntil = end + 0.05;
    this.busyUntil = end;
    this.log(`${who || 'you'} → <b>double drop</b>: decks ${on.name} + ${off.name} together for ${bars} bars`);
    return end;
  }

  // mashup (Guetta / Diplo): layer the other deck's vocal range over this one for a phrase
  mashup({ bars = 16, who = '' } = {}) {
    const on = this.on, off = this.off;
    if (!off.playing || this.busy()) return false;
    const T0 = on.nextBarTime(), spb = 60 / on.track.bpm / on.rate, end = T0 + bars * 4 * spb;
    const x = this.mixer.x, mid = off === this.mixer.decks[1] ? 0.42 : 0.58;
    this.mixer.cutTo(mid, T0); this.mixer.cutTo(x, end);
    if (off.hasStems) {
      // a real acapella-style layer: the other deck's music stem, its drums muted, bass trimmed
      off.setStem('drums', false, T0); off.setStem('drums', true, end);
      setTimeout(() => off.setEQ('low', -12), Math.max(0, (T0 - this.ctx.currentTime) * 1000));
      setTimeout(() => off.setEQ('low', 0), Math.max(0, (end - this.ctx.currentTime) * 1000));
    } else {
      const kill = () => { off.setEQ('low', -24); off.setEQ('high', -8); }, back = () => { off.setEQ('low', 0); off.setEQ('high', 0); };
      setTimeout(kill, Math.max(0, (T0 - this.ctx.currentTime) * 1000));
      setTimeout(back, Math.max(0, (end - this.ctx.currentTime) * 1000));
    }
    this.mixer.lockUntil = end + 0.05;
    this._lit('mashup');
    this.log(`${who || 'you'} → <b>mashup</b>: "${off.track.name}" vocals over "${on.track.name}" for ${bars} bars`);
    return end;
  }

  // loop layering (Hawtin / Carl Cox): a bar of the other deck's tops looped under the mix
  layer({ bars = 8, who = '' } = {}) {
    const on = this.on, off = this.off;
    if (!off.playing) return false;
    const T0 = on.nextBarTime(), spb = 60 / on.track.bpm / on.rate, spbOff = 60 / off.track.bpm;
    // with stems: loop the other deck's drums (percussion layering); without: its tops above 450 Hz
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = off.hasStems ? 180 : 450;
    const g = this.ctx.createGain(); g.gain.value = 0.7; hp.connect(g); g.connect(this.mixer.master);
    const bar = Math.floor(off.beatAt(T0) / 4) * 4;
    off.slice(T0, off.posOfBeat(bar), 4 * spbOff, { rate: off.rate, gain: 1, dest: hp, loopFor: bars * 4 * spb, buffer: off.hasStems ? off.track.stems.drums : null });
    this._lit('layer');
    this.log(`${who || 'you'} → <b>loop layer</b>: a bar of "${off.track.name}" looped under the mix for ${bars} bars`);
    return T0;
  }

  // drums out (Nucleya's dhol drop-out, Calvin Harris / Fred again.. sing-alongs): the drum stem drops for `bars`,
  // then slams back in with a boom. Without stems it falls back to a bass tease.
  drumsOut({ bars = 4, who = '' } = {}) {
    const on = this.on;
    if (!on.hasStems) return this.bassTease(who);
    const T0 = on.nextBarTime(), spb = 60 / on.track.bpm / on.rate, end = T0 + bars * 4 * spb;
    on.setStem('drums', false, T0); on.setStem('drums', true, end);
    this.sampler.riser(end - 4 * spb, 4 * spb); this.sampler.boom(end);
    this._lit('drumsout');
    this.log(`${who || 'you'} → <b>drums out</b> for ${bars} bars, then back in`);
    return end;
  }
  // strip to drums (Hawtin / Carl Cox tools): only the drum stem for `bars`
  melodyOut({ bars = 8, who = '' } = {}) {
    const on = this.on;
    if (!on.hasStems) return false;
    const T0 = on.nextBarTime(), spb = 60 / on.track.bpm / on.rate, end = T0 + bars * 4 * spb;
    on.setStem('music', false, T0); on.setStem('music', true, end);
    this._lit('melodyout');
    this.log(`${who || 'you'} → <b>stripped to drums</b> for ${bars} bars`);
    return end;
  }

  // Skrillex / DJ Snake: short brutal edit — 1/32 roll with pitch rise + gate
  stutter(who = '') {
    const at = this.nextBeat();
    this.on.loopRoll(at, 0.03125, 1, null, 1.6); this.fx.trans(at, 1, 8);
    this._lit('stutter'); if (who) this.log(`${who} → stutter edit`);
  }
  reverse(who = '') { this.on.reverse(this.nextBeat(), 1); this._lit('reverse'); if (who) this.log(`${who} → reverse`); }
  // tease the drop: kill the bass for a bar, slam it back on the downbeat
  bassTease(who = '') {
    const on = this.on, at = on.nextBarTime(), spb = 60 / on.track.bpm / on.rate;
    setTimeout(() => on.setEQ('low', -24), Math.max(0, (at - this.ctx.currentTime) * 1000));
    setTimeout(() => on.setEQ('low', 0), Math.max(0, (at + 4 * spb - this.ctx.currentTime) * 1000));
    this._lit('tease'); if (who) this.log(`${who} → bass out for a bar, slammed back in`);
  }

  // Hawtin's foot-pedal delay: throw a single hit into a long feedback echo
  dub(who = '') {
    const on = this.on, at = this.nextBeat(), spb = 60 / on.track.bpm / on.rate, fb = this.mixer.fb.gain;
    on.echoThrow(at, 0.25);
    fb.setValueAtTime(0.72, at); fb.setValueAtTime(0.72, at + 3 * spb); fb.linearRampToValueAtTime(0.45, at + 4 * spb);
    this._lit('echo'); if (who) this.log(`${who} → dub delay throw`);
  }
  resFilter(who = '') { this.fx.resSweep(this.nextBar(), 4); this._lit('lpf'); if (who) this.log(`${who} → resonant filter sweep`); }
  pump(who = '') { this.fx.pump(this.nextBar(), 8); this._lit('pump'); if (who) this.log(`${who} → sidechain pump`); }
  singalong({ bars = 4, who = '' } = {}) {
    const at = this.nextBar(), spb = 60 / this.on.bpm, end = at + bars * 4 * spb;
    this.fx.singalong(at, bars * 4);
    this.sampler.boom(end); this.sampler.riser(end - 4 * spb, 4 * spb);
    this.busyUntil = Math.max(this.busyUntil, end);
    this._lit('singalong');
    this.log(`${who || 'you'} → <b>sing-along drop-out</b> for ${bars} bars, then slam back in`);
    return end;
  }
  // Pryda snare: a sustained snare roll on the last beat before the next bar
  fill(who = '') {
    const at = this.nextBar() - this.spb;
    if (at < this.ctx.currentTime) return;
    this.sampler.snareRoll(at, 1, this.spb); this._lit('fill'); if (who) this.log(`${who} → snare fill`);
  }
  // live 303 in the on-air key; the fly writes the pattern from its spikes
  acid({ bars = 4, pattern = null, who = '' } = {}) {
    const at = this.nextBar(), root = this.synth.root % 12 + 36, sc = this.synth.scale;
    const pat = pattern || Array.from({ length: 16 }, () => (Math.random() < 0.7 ? Math.floor(Math.random() * 8) : -1));
    const notes = pat.map((d) => (d < 0 ? null : root + sc[d % sc.length] + 12 * Math.floor(d / sc.length)));
    const accent = pat.map((d, k) => d >= 0 && (k % 4 === 0 || d > 5));
    this.sampler.acid(at, bars, this.spb, notes, accent);
    this._lit('acid');
    this.log(`${who || 'you'} → <b>live 303 acid line</b> for ${bars} bars`);
    return at;
  }
  // Fisher: the whole mix drops out for the last bar of the phrase, then the new track hits its intro hard
  killDrop(who = '') {
    const on = this.on, off = this.off;
    if (!off.playing) return false;
    const land = on.nextBarTime() + 4 * this.spb;
    this.fx.gap(land - 4 * this.spb, 4 * this.spb);
    this.mixer.cutTo(off === this.mixer.decks[0] ? 0 : 1, land);
    this.sampler.boom(land);
    this.log(`${who || 'you'} → <b>1-bar kill</b>, then deck ${off.name} hits`);
    return land;
  }

  // hard cut on the next bar (DJ Snake / Diplo / Skrillex: no blend at all)
  hardCut(who = '') {
    const on = this.on, off = this.off;
    if (!off.playing) return false;
    const at = on.nextBarTime();
    this.mixer.cutTo(off === this.mixer.decks[0] ? 0 : 1, at);
    this.log(`${who || 'you'} → <b>hard cut</b> to deck ${off.name}`);
    return at;
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
