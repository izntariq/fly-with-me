// Track analysis so the fly can adapt to music it has never heard: key (+ Camelot code), style, energy per bar.

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Krumhansl-Kessler key profiles
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function fft(re, im) {                       // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j], k = i + j + len / 2;
        const vr = re[k] * cr - im[k] * ci, vi = re[k] * ci + im[k] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[k] = ur - vr; im[k] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function corr(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / 12, mb = b.reduce((s, x) => s + x, 0) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db + 1e-12);
}

// Camelot wheel code: C major = 8B, A minor = 8A; neighbours (±1, or same number) mix harmonically
export function camelot(pc, mode) {
  const majorPc = mode === 'minor' ? (pc + 3) % 12 : pc;
  const fifths = (majorPc * 7) % 12;                         // C=0, G=1, D=2 ...
  return { n: ((fifths + 7) % 12) + 1, l: mode === 'minor' ? 'A' : 'B' };
}
export function camelotDistance(a, b) {
  if (!a || !b) return 1;
  const d = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  return d + (a.l === b.l ? 0 : (d === 0 ? 1 : 2));
}
export const camelotName = (c) => (c ? `${c.n}${c.l}` : '');

export function analyzeKey(buffer) {
  const sr = buffer.sampleRate, d = buffer.getChannelData(0), N = 8192;
  const chroma = new Float64Array(12), re = new Float64Array(N), im = new Float64Array(N);
  const frames = 48, span = d.length - N;
  for (let f = 0; f < frames; f++) {
    const o = Math.floor((f + 0.5) / frames * span);
    for (let i = 0; i < N; i++) { re[i] = d[o + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im);
    for (let k = Math.ceil(80 * N / sr); k < Math.min(N / 2, 2000 * N / sr); k++) {
      const hz = k * sr / N, midi = 69 + 12 * Math.log2(hz / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
  }
  let best = { r: -2 };
  for (let pc = 0; pc < 12; pc++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + pc) % 12]);
    const rM = corr(rot, MAJ), rm = corr(rot, MIN);
    if (rM > best.r) best = { r: rM, pc, mode: 'major' };
    if (rm > best.r) best = { r: rm, pc, mode: 'minor' };
  }
  return { pc: best.pc, mode: best.mode, confidence: best.r, name: `${NOTE[best.pc]} ${best.mode}` };
}

// energy per bar (0..1, relative to the track's loudest bar), plus how much of it is sub-bass / kick
export function analyzeEnergy(buffer, bpm, firstBeat) {
  const d = buffer.getChannelData(0), sr = buffer.sampleRate, barLen = 4 * 60 / bpm;
  const nBars = Math.max(1, Math.floor((buffer.duration - firstBeat) / barLen));
  const E = new Float32Array(nBars), Low = new Float32Array(nBars);
  const a = Math.exp(-2 * Math.PI * 150 / sr);
  for (let b = 0; b < nBars; b++) {
    let s = 0, sl = 0, n = 0, lp = 0;
    for (let i = Math.floor((firstBeat + b * barLen) * sr), e = i + Math.floor(barLen * sr); i < e && i < d.length; i += 4) {
      lp = a * lp + (1 - a) * d[i]; s += d[i] * d[i]; sl += lp * lp; n++;
    }
    E[b] = Math.sqrt(s / Math.max(1, n)); Low[b] = Math.sqrt(sl / Math.max(1, n));
  }
  const max = Math.max(...E) || 1;
  let low = 0, tot = 0;
  for (let b = 0; b < nBars; b++) { low += Low[b]; tot += E[b]; E[b] /= max; }
  return { energy: E, lowRatio: low / (tot || 1) };
}

// onsets per second (percussive density), from the beat detector's style of flux on the full band
function onsetDensity(buffer) {
  const d = buffer.getChannelData(0), sr = buffer.sampleRate, hop = Math.floor(sr / 100);
  let prev = 0, count = 0, avg = 0;
  const n = Math.min(d.length, sr * 90);
  for (let i = 0; i + hop < n; i += hop) {
    let e = 0; for (let j = i; j < i + hop; j += 2) e += d[j] * d[j];
    e = Math.sqrt(e / (hop / 2));
    const flux = Math.max(0, e - prev); prev = e;
    avg = avg * 0.95 + flux * 0.05;
    if (flux > avg * 3 && flux > 0.01) count++;
  }
  return count / (n / sr);
}

const DESI_WORDS = /bhangra|punjabi|desi|dhol|bollywood|tabla|sitar|qawwali|garba|dandiya|hindi|urdu|raag|raga|diljit|sidhu|karan aujla|ap dhillon|arijit|nucleya|badshah|honey singh/i;

export function guessStyle(name, bpm, lowRatio, density, energy) {
  if (DESI_WORDS.test(name)) return 'desi';
  if (bpm >= 155) return 'dnb';
  const avgE = energy.reduce((s, x) => s + x, 0) / energy.length;
  if (density < 1.2 || (avgE < 0.45 && lowRatio < 0.35)) return 'chill';
  if (bpm < 108) return 'hiphop';
  return 'club';
}

export function analyzeTrack(buffer, name, bpm, firstBeat) {
  const key = analyzeKey(buffer);
  const { energy, lowRatio } = analyzeEnergy(buffer, bpm, firstBeat);
  const density = onsetDensity(buffer);
  const style = guessStyle(name, bpm, lowRatio, density, energy);
  return { key, energy, lowRatio, density, style, camelot: camelot(key.pc, key.mode) };
}
