// Set planner: an energy arc for the whole set, like the arcs the research found
// (Diplo: pop → heavy → pop; Guetta: soft/hard "yo-yo"; a club night: warm-up → peak → close; Kaytranada: beat tape).
// Each arc is a list of [fraction of set, energy 0..1] points; energy in between is interpolated.

export const ARCS = {
  free: { name: 'Free (no plan)', points: null },
  journey: { name: 'Club night: warm-up → peak → close', points: [[0, 0.25], [0.3, 0.5], [0.6, 0.85], [0.8, 1], [0.92, 0.7], [1, 0.35]] },
  warmup: { name: 'Warm-up slot', points: [[0, 0.15], [0.6, 0.4], [1, 0.6]] },
  peak: { name: 'Peak time', points: [[0, 0.75], [0.2, 0.95], [0.5, 0.85], [0.8, 1], [1, 0.95]] },
  yoyo: { name: 'Festival yo-yo (Guetta)', points: [[0, 0.6], [0.12, 1], [0.2, 0.35], [0.35, 1], [0.45, 0.3], [0.6, 1], [0.7, 0.4], [0.85, 1], [1, 0.8]] },
  popheavypop: { name: 'Pop → heavy → pop (Diplo)', points: [[0, 0.55], [0.25, 0.6], [0.5, 1], [0.7, 0.95], [0.85, 0.6], [1, 0.55]] },
  beattape: { name: 'Beat tape (Kaytranada)', points: [[0, 0.4], [0.1, 0.65], [0.2, 0.35], [0.3, 0.7], [0.4, 0.4], [0.5, 0.75], [0.6, 0.45], [0.7, 0.7], [0.8, 0.4], [0.9, 0.65], [1, 0.4]] },
  closing: { name: 'Closing set', points: [[0, 0.8], [0.4, 0.65], [0.8, 0.4], [1, 0.2]] },
};

export function energyAt(points, frac) {
  if (!points) return null;
  const f = Math.max(0, Math.min(1, frac));
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (f <= x1) return y0 + (y1 - y0) * (f - x0) / (x1 - x0 || 1);
  }
  return points[points.length - 1][1];
}

// how intense a track is, 0..1: tempo, how much of it is loud, and its style
const STYLE_HEAT = { chill: 0, hiphop: 0.35, desi: 0.55, club: 0.6, dnb: 0.9 };
export function trackIntensity(t) {
  const bpm = Math.max(0, Math.min(1, (t.bpm - 90) / 60));
  const e = t.energy?.length ? t.energy.reduce((s, x) => s + x, 0) / t.energy.length : 0.6;
  return Math.max(0, Math.min(1, 0.45 * bpm + 0.3 * e + 0.25 * (STYLE_HEAT[t.style] ?? 0.6)));
}
