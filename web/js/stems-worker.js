// Drums / music stem separation for tracks you drop in, off the main thread.
// Harmonic–percussive source separation (Fitzgerald 2010): in a spectrogram, sustained notes are horizontal lines and
// hits are vertical lines, so a median filter along time keeps the harmonic part and one along frequency keeps the
// percussive part. Soft (Wiener) masks from those split every STFT frame; overlap-add rebuilds each stem.
//   in:  { id, L, R, sr }          out: { id, drums: [L, R], music: [L, R] }  (+ {id, progress} messages)

const N = 2048, HOP = 512, B = N / 2 + 1, KT = 17, KF = 17;
const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < h; j++) {
        const k = i + j + h, vr = re[k] * cr - im[k] * ci, vi = re[k] * ci + im[k] * cr;
        re[k] = re[i + j] - vr; im[k] = im[i + j] - vi; re[i + j] += vr; im[i + j] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// median of `k` values read by get(j) — insertion sort on a small scratch array
const scratch = new Float32Array(32);
function median(get, lo, hi) {
  let m = 0;
  for (let j = lo; j < hi; j++) {
    const v = get(j); let p = m++;
    while (p > 0 && scratch[p - 1] > v) { scratch[p] = scratch[p - 1]; p--; }
    scratch[p] = v;
  }
  return scratch[m >> 1];
}

self.onmessage = (e) => {
  const { id, L, R, sr } = e.data, len = L.length, F = Math.ceil(len / HOP) + 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const frame = (x, f) => { const o = f * HOP - N / 2; for (let i = 0; i < N; i++) { const s = o + i; re[i] = s >= 0 && s < len ? x[s] * win[i] : 0; im[i] = 0; } };

  // 1. magnitude spectrogram of the mono mix
  const mag = new Float32Array(F * B), reR = new Float64Array(N), imR = new Float64Array(N);
  for (let f = 0; f < F; f++) {
    frame(R, f); reR.set(re); imR.set(im); fft(reR, imR);
    frame(L, f); fft(re, im);
    for (let k = 0; k < B; k++) mag[f * B + k] = Math.hypot(re[k] + reR[k], im[k] + imR[k]) / 2;
    if (f % 500 === 0) self.postMessage({ id, progress: 0.3 * f / F });
  }
  // 2. harmonic (median over time) and percussive (median over frequency) enhanced spectrograms → percussive mask
  const mask = new Float32Array(F * B);
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < B; k++) {
      const h = median((j) => mag[j * B + k], Math.max(0, f - (KT >> 1)), Math.min(F, f + (KT >> 1) + 1));
      const p = median((j) => mag[f * B + j], Math.max(0, k - (KF >> 1)), Math.min(B, k + (KF >> 1) + 1));
      mask[f * B + k] = (p * p) / (h * h + p * p + 1e-12);
    }
    if (f % 300 === 0) self.postMessage({ id, progress: 0.3 + 0.4 * f / F });
  }
  // 3. split each channel frame by frame; music = original − drums (saves an inverse FFT)
  const out = [];
  const norm = new Float32Array(len);
  for (let f = 0; f < F; f++) { const o = f * HOP - N / 2; for (let i = 0; i < N; i++) { const s = o + i; if (s >= 0 && s < len) norm[s] += win[i] * win[i]; } }
  for (const x of [L, R]) {
    const d = new Float32Array(len), m = new Float32Array(len);
    for (let f = 0; f < F; f++) {
      frame(x, f); fft(re, im);
      for (let k = 0; k < B; k++) {
        const g = mask[f * B + k]; re[k] *= g; im[k] *= g;
        if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      }
      fft(re, im, true);
      const o = f * HOP - N / 2;
      for (let i = 0; i < N; i++) { const s = o + i; if (s >= 0 && s < len) d[s] += re[i] * win[i]; }
    }
    for (let s = 0; s < len; s++) { d[s] /= Math.max(norm[s], 1e-3); m[s] = x[s] - d[s]; }
    out.push([d, m]);
    self.postMessage({ id, progress: out.length === 1 ? 0.85 : 1 });
  }
  const drums = [out[0][0], out[1][0]], music = [out[0][1], out[1][1]];
  self.postMessage({ id, drums, music }, [drums[0].buffer, drums[1].buffer, music[0].buffer, music[1].buffer]);
};
