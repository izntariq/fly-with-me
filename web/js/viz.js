// Visuals: whole-brain spike map, output raster, ear spectra, deck waveforms, move meters.

export class BrainView {
  constructor(canvas, xy, inputIdx, outputIdx) {
    this.c = canvas; this.g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, n = xy.length / 2;
    // fit the frontal projection into the canvas, preserving aspect
    let x0 = 65535, x1 = 0, y0 = 65535, y1 = 0;
    for (let i = 0; i < n; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1];
      if (!x && !y) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const pad = 10, s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
    const ox = (W - (x1 - x0) * s) / 2 - x0 * s, oy = (H - (y1 - y0) * s) / 2 - y0 * s;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1];
      if (!x && !y) continue;
      this.ok[i] = 1; this.px[i] = ox + x * s; this.py[i] = oy + y * s;
    }
    this.kind = new Uint8Array(n);                // 0 mid, 1 input, 2 output
    for (const i of inputIdx) this.kind[i] = 1;
    for (const i of outputIdx) this.kind[i] = 2;
    // static base layer
    this.base = document.createElement('canvas'); this.base.width = W; this.base.height = H;
    const b = this.base.getContext('2d');
    b.fillStyle = '#030406'; b.fillRect(0, 0, W, H);
    b.fillStyle = 'rgba(120,140,190,0.07)';
    for (let i = 0; i < n; i++) if (this.ok[i]) b.fillRect(this.px[i], this.py[i], 1, 1);
    this.colors = ['rgba(255,179,71,0.9)', 'rgba(76,195,255,0.95)', 'rgba(255,79,216,1)'];
    this.pending = [];
    this.g.drawImage(this.base, 0, 0);
  }
  addSpikes(idx) { if (this.pending.length < 20000) for (const i of idx) this.pending.push(i); }
  // cheap trails: blend a little of the static base back over the canvas each frame, then draw the new spikes
  draw() {
    const g = this.g;
    g.globalAlpha = 0.14;
    g.drawImage(this.base, 0, 0);
    g.globalAlpha = 1;
    for (const i of this.pending) {
      if (!this.ok[i]) continue;
      const k = this.kind[i], r = k === 2 ? 3 : 2;
      g.fillStyle = this.colors[k];
      g.fillRect(this.px[i] - r / 2, this.py[i] - r / 2, r, r);
    }
    this.pending.length = 0;
  }
}

export class Raster {
  constructor(canvas, outputs) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.n = outputs.length;
    this.motorStart = outputs.findIndex((o) => o.cls !== 'descending');      // motor (and male-CNS leg / wing motor)
    this.g.fillStyle = '#030406'; this.g.fillRect(0, 0, canvas.width, canvas.height);
    this.pending = [];
    this.pxPerSec = canvas.width / 4;
    this.acc = 0;
  }
  add(spikes) { if (this.pending.length < 20000) for (const [s] of spikes) this.pending.push(s); }
  draw(dt) {
    const g = this.g, W = this.c.width, H = this.c.height;
    this.acc += dt * this.pxPerSec;
    const shift = Math.floor(this.acc);
    if (shift > 0) {
      this.acc -= shift;
      g.drawImage(this.c, -shift, 0);
      g.fillStyle = '#030406'; g.fillRect(W - shift, 0, shift, H);
    }
    for (const s of this.pending) {
      g.fillStyle = s >= this.motorStart && this.motorStart >= 0 ? '#ffb347' : '#ff4fd8';
      g.fillRect(W - 2, (s / this.n) * H, 2, 1.5);
    }
    this.pending.length = 0;
  }
}

export function drawEar(canvas, bands, levels, color) {
  const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H);
  const w = W / bands.length;
  bands.forEach((b, i) => {
    const v = levels[b.name] || 0;
    g.fillStyle = color; g.globalAlpha = 0.35 + 0.65 * v;
    g.fillRect(i * w + 1, H - v * H, w - 2, v * H);
  });
  g.globalAlpha = 1;
}

// waveform images are rendered once per track (played + unplayed colour), then just composited per frame
const waveCache = new WeakMap();
function waveImages(track, W, H, color) {
  let c = waveCache.get(track);
  if (c && c.color === color && c.W === W) return c;
  const mk = (fill) => {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), p = track.peaks, n = p.length;
    g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H);
    g.fillStyle = fill;
    for (let i = 0; i < n; i++) { const h = p[i] * H * 0.95; g.fillRect((i / n) * W, (H - h) / 2, Math.max(1, W / n), h); }
    g.fillStyle = 'rgba(255,255,255,0.08)';
    const dur = track.buffer.duration, spb = 60 / track.bpm;
    for (let bt = track.firstBeat; bt < dur; bt += spb * 16) g.fillRect((bt / dur) * W, 0, 1, H);
    return cv;
  };
  c = { color, W, played: mk(color), rest: mk('#39414f') };
  waveCache.set(track, c);
  return c;
}

export function drawWave(canvas, deck, color) {
  const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const t = deck.track;
  if (!t) { g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H); return; }
  const img = waveImages(t, W, H, color);
  const x = Math.max(0, Math.min(W, (deck.position() / deck.duration) * W));
  g.drawImage(img.rest, 0, 0);
  if (x >= 1) g.drawImage(img.played, 0, 0, x, H, 0, 0, x, H);
  g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, H);
}
