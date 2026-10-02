"""Record what a listener fly's output neurons do through every real track, many tracks at once on the GPU.

For each track in data/realtracks (prepared by tools/analyze_tracks.mjs + afconvert): the fly hears the track in both
ears, like a listener fly hearing its deck's cue. Every output neuron's spikes are pooled into the app's bars
(beat grid from the app's own analysis) and saved as rates in Hz.

    caffeinate -i .venv/bin/python tools/record_real.py [--brain trained|naive] [--batch 16] [--limit-s 0]
    -> data/realtracks/rec_<brain>/<slug>.npz   (rates [bars, 1409], bar_s, first_beat)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import numpy as np

DATA = ROOT / "data" / "realtracks"


def drive_for(slug: str, limit_s: float = 0) -> str:
    """Both ears hear the track (mono), through the Python port of the app's ears. Cached."""
    from flybrain.ears import ear_drive, load_wav
    out = DATA / "drive" / f"{slug}.npy"
    if not out.exists():
        x, sr = load_wav(DATA / "wav" / f"{slug}.wav")
        if limit_s:
            x = x[:, :int(limit_s * sr)]
        m = x.mean(0, keepdims=True)
        d, _ = ear_drive(np.concatenate([m, m]), sr)
        out.parent.mkdir(exist_ok=True)
        np.save(out, d.astype(np.float16))
    return slug


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", choices=["trained", "naive"], default="trained")
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--limit-s", type=float, default=0, help="only the first N seconds (for a quick test)")
    ap.add_argument("--only", nargs="*", help="slugs to record")
    args = ap.parse_args()

    analysis = json.load(open(DATA / "analysis.json"))
    slugs = [s for s in (args.only or analysis) if (DATA / "wav" / f"{s}.wav").exists()]
    outdir = DATA / f"rec_{args.brain}"
    outdir.mkdir(exist_ok=True)
    slugs = [s for s in slugs if not (outdir / f"{s}.npz").exists()]
    print(f"{len(slugs)} tracks to record ({args.brain} brain)", flush=True)

    t0 = time.time()
    with ProcessPoolExecutor(6) as ex:
        list(ex.map(drive_for, slugs, [args.limit_s] * len(slugs)))
    print(f"ear drive ready ({time.time() - t0:.0f} s)", flush=True)

    from flybrain.brain import Brain
    from flybrain.gpu import GPUBrains
    from flybrain.mapping import build_inputs, build_outputs, load_annotations
    b = Brain()
    if args.brain == "trained":
        b.load_trained(ROOT / "brains" / "trained_brain.npz")
    ann = load_annotations()
    ear = [c for c in build_inputs(ann, b.id2idx) if c.name.startswith("ear")]
    stim = np.concatenate([c.idx for c in ear])
    seg = np.cumsum([0] + [len(c.idx) for c in ear])
    max_hz = np.concatenate([np.full(len(c.idx), c.max_hz) for c in ear])
    out_idx, _ = build_outputs(ann, b.ids)
    slot = np.full(b.n, -1, np.int64)
    slot[out_idx] = np.arange(len(out_idx))
    n_out = len(out_idx)

    drives = {s: np.load(DATA / "drive" / f"{s}.npy").astype(np.float32) for s in slugs}
    slugs.sort(key=lambda s: len(drives[s]))
    g = GPUBrains(args.batch, weights=b.weights)
    sr = 44100
    for i0 in range(0, len(slugs), args.batch):
        batch = slugs[i0:i0 + args.batch]
        g.reset()
        for k in range(len(batch), args.batch):            # spare flies in the last batch stay silent
            g.set_stim(k, np.zeros(0, np.int64), np.zeros(0))
        bars = []
        for s in batch:
            a = analysis[s]
            bar_s = 4 * 60 / a["bpm"]
            nb = len(a["energy"])
            bars.append((bar_s, a["firstBeat"], nb, np.zeros((nb, n_out)), np.zeros(nb)))
        nf = max(len(drives[s]) for s in batch)
        t1 = time.time()
        for f in range(nf):
            for k, s in enumerate(batch):
                d = drives[s]
                lv = d[f] if f < len(d) else np.zeros(d.shape[1], np.float32)
                g.set_stim(k, stim, np.repeat(lv, np.diff(seg)) * max_hz)
            res = g.run(20.0)
            tc = f * 0.02 + 1024 / sr
            for k, (si, _) in enumerate(res[:len(batch)]):
                bar_s, fb, nb, acc, dur = bars[k]
                bi = int((tc - fb) // bar_s)
                if 0 <= bi < nb and f < len(drives[batch[k]]):
                    sl = slot[si]
                    sl = sl[sl >= 0]
                    if len(sl):
                        acc[bi] += np.bincount(sl, minlength=n_out)
                    dur[bi] += 0.02
        for k, s in enumerate(batch):
            bar_s, fb, nb, acc, dur = bars[k]
            np.savez_compressed(outdir / f"{s}.npz", rates=(acc / np.maximum(dur, 1e-3)[:, None]).astype(np.float32),
                                covered=dur, bar_s=bar_s, first_beat=fb)
        print(f"batch {i0 // args.batch + 1}: {len(batch)} tracks, {nf * 0.02:.0f} s of music in {time.time() - t1:.0f} s",
              flush=True)


if __name__ == "__main__":
    main()
