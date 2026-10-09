// The fly on the mic. Uses the browser's speech synthesis, so it plays straight to the speakers: it is heard
// live but can't be captured by "Record set" (the Web Speech API has no audio output node).

const GENERIC = ["Let's go!", 'Hands up!', 'Make some noise!', 'Here we go!', 'One more time!'];
const DESI = ['Balle balle!', 'Oye hoye!', 'Chak de phatte!', "Let's go!"];

export class MC {
  constructor(log) {
    this.log = log;
    this.enabled = false;                  // off unless the #mc box is ticked (it's off by default)
    this.last = -1e9;
    this.ok = typeof speechSynthesis !== 'undefined';
    this.voice = null;
    if (this.ok) {
      const pick = () => {
        const v = speechSynthesis.getVoices();
        this.voice = v.find((x) => /en[-_](US|GB)/i.test(x.lang) && /Daniel|Alex|Fred|Samantha|Google/i.test(x.name)) || v.find((x) => /^en/i.test(x.lang)) || v[0] || null;
      };
      pick(); speechSynthesis.onvoiceschanged = pick;
    }
  }
  phrases(persona, desi) {
    if (persona?.mc) return persona.mc;
    return desi ? DESI : GENERIC;
  }
  // say something now or at a delay; `pickN` (e.g. a spike count) chooses the phrase; rate-limited to one per 20 s
  shout({ persona, desi, kind = 'hype', delay = 0, pickN = 0 } = {}) {
    if (!this.ok || !this.enabled) return;
    const now = performance.now() + delay * 1000;
    if (now - this.last < 20000) return;
    let list = this.phrases(persona, desi);
    if (!list.length) return;                                   // this style doesn't talk on the mic
    if (kind === 'ready') list = ['Are you ready?', 'Here it comes!', 'Get ready!'];
    if (kind === 'sing') list = desi ? ['Sing it!', 'Balle balle!'] : ['Sing it!', 'Everybody!'];
    const text = list[Math.abs(pickN) % list.length];
    this.last = now;
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 1.05; u.pitch = 0.8; u.volume = 0.6;   // speech plays outside the mixer's ceiling and volume
      speechSynthesis.cancel(); speechSynthesis.speak(u);
      this.log(`🎤 the fly on the mic: "${text}"`);
    }, Math.max(0, delay * 1000));
  }
}
