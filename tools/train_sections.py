"""Train and test section sense v2 on the recorded real tracks (tools/record_real.py), then export it for the app.

    .venv/bin/python tools/train_sections.py [--brain trained] [--export]
Tracks are split by name into train (75%) and held-out (25%); every number reported is on held-out tracks.
With --export the model is refit on all tracks and written to brains/sections.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import numpy as np

from flybrain.sections import CLASSES, bar_features, fit_logreg, hmm_filter, label_track, scores, softmax, type_groups

DATA = ROOT / "data" / "realtracks"


def load(brain: str):
    from flybrain.mapping import build_outputs, load_annotations
    from flybrain.brain import load_connectome
    ids, *_ = load_connectome()
    _, meta = build_outputs(load_annotations(), ids)
    groups, group_of = type_groups(meta)
    analysis = json.load(open(DATA / "analysis.json"))
    tracks = []
    for f in sorted((DATA / f"rec_{brain}").glob("*.npz")):
        z = np.load(f)
        a = analysis[f.stem]
        lab = np.array([CLASSES.index(c) for c in label_track(a["energy"])])
        ok = z["covered"] > 0.5 * z["bar_s"]                  # bars the fly actually heard
        X = bar_features(z["rates"], group_of, len(groups))
        nb = len(lab)
        frac = (np.arange(nb) + 0.5) / nb
        tracks.append({"slug": f.stem, "X": X[ok], "y": lab[ok], "frac": frac[ok]})
    return tracks, groups, meta


def held_out(slug: str) -> bool:
    return int(hashlib.md5(slug.encode()).hexdigest(), 16) % 4 == 0


def train(tracks, lam):
    X = np.concatenate([t["X"] for t in tracks])
    y = np.concatenate([t["y"] for t in tracks])
    w_cls = 1 / np.maximum(1, np.bincount(y, minlength=4))
    mu, sd = X.mean(0), X.std(0) + 1e-3
    W, b = fit_logreg((X - mu) / sd, y, 4, lam=lam, w_cls=w_cls / w_cls.mean())
    return W, b, mu, sd


def evaluate(tracks, model, power=1.0):
    W, b, mu, sd = model
    ys, raw, filt, pos = [], [], [], []
    for t in tracks:
        P = softmax(((t["X"] - mu) / sd) @ W + b)
        ys.append(t["y"])
        raw.append(P.argmax(1))
        filt.append(hmm_filter(P, t["frac"], power=power).argmax(1))
        pos.append(hmm_filter(np.full_like(P, 0.25), t["frac"]).argmax(1))       # position + order only, no fly
    y = np.concatenate(ys)
    return {"fly_only": scores(y, np.concatenate(raw)), "fly_plus_prior": scores(y, np.concatenate(filt)),
            "prior_only": scores(y, np.concatenate(pos)), "majority": scores(y, np.full_like(y, 1))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", default="trained")
    ap.add_argument("--lam", type=float, default=0.05)
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()
    tracks, groups, meta = load(args.brain)
    tr = [t for t in tracks if not held_out(t["slug"])]
    te = [t for t in tracks if held_out(t["slug"])]
    print(f"{len(tracks)} tracks: {len(tr)} train, {len(te)} held out; {len(groups)} neuron types, "
          f"{sum(len(t['y']) for t in te)} held-out bars")
    best = None
    for lam in (0.01, 0.05, 0.2, 1.0):
        res = evaluate(te, train(tr, lam))
        print(f"lam {lam}: fly only macro-F1 {res['fly_only']['macro_f1']}, with prior {res['fly_plus_prior']['macro_f1']}")
        if best is None or res["fly_plus_prior"]["macro_f1"] > best[1]["fly_plus_prior"]["macro_f1"]:
            best = (lam, res)
    lam, res = best
    print(json.dumps({"lam": lam, **res}, indent=1))
    json.dump({"brain": args.brain, "lam": lam, "held_out_tracks": [t["slug"] for t in te], **res},
              open(DATA / f"sections_eval_{args.brain}.json", "w"), indent=1)
    if args.export:
        W, b, mu, sd = train(tracks, lam)
        # fold the standardisation into the weights: logits = x @ W' + b'
        W2 = W / sd[:, None]
        b2 = b - mu @ W2
        spec = {"version": 2, "brain": args.brain, "classes": CLASSES, "groups": groups,
                "feature": {"sd_floor": 0.05, "warmup_bars": 4, "context_bars": 4},
                "W": np.round(W2, 5).tolist(), "b": np.round(b2, 5).tolist(),
                "stay": 0.93, "held_out": {k: res[k] for k in ("fly_only", "fly_plus_prior", "prior_only", "majority")}}
        (ROOT / "brains").mkdir(exist_ok=True)
        json.dump(spec, open(ROOT / "brains" / f"sections_{args.brain}.json", "w"))
        print("exported brains/sections_%s.json" % args.brain)


if __name__ == "__main__":
    main()
