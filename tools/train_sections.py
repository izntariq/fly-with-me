"""Train and test the section sense on the recorded real tracks (tools/record_real.py), then export it for the app.

    .venv/bin/python tools/train_sections.py [--labels allin1|energy] [--features fly|energy|fused] [--export]

  labels    allin1: human-style sections from the All-In-One analyzer (tools/label_allin1.py), as intro / verse /
            chorus / break / outro; energy: the older 4-class heuristic from each track's energy (label_track)
  features  fly: the listener fly's output neurons by cell type; energy: the app's own per-bar energy only;
            fused: both (energy features get a lighter penalty so 1,036 neuron features don't drown them)
Scores are 5-fold cross-validated by track (mean ± 95% CI over folds). The arrangement (section transitions, start
and position prior) is learned from each fold's training tracks. --export refits on everything ->
brains/sections_<brain>.json.
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

from flybrain.sections import (CLASSES, DJ_CLASSES, bar_features, energy_features, fit_logreg, hmm_filter, label_allin1,
                               label_track, learn_arrangement, scores, softmax, type_groups)

DATA = ROOT / "data" / "realtracks"


def load(brain: str, labels: str, features: str):
    from flybrain.brain import load_connectome
    from flybrain.mapping import build_outputs, load_annotations
    ids, *_ = load_connectome()
    _, meta = build_outputs(load_annotations(), ids)
    groups, group_of = type_groups(meta)
    analysis = json.load(open(DATA / "analysis.json"))
    classes = DJ_CLASSES if labels == "allin1" else CLASSES
    tracks = []
    for f in sorted((DATA / f"rec_{brain}").glob("*.npz")):
        a = analysis[f.stem]
        nb = len(a["energy"])
        if labels == "allin1":
            j = DATA / "allin1" / f"{f.stem}.json"
            if not j.exists():
                continue
            lab = label_allin1(json.load(open(j)), a["firstBeat"], a["bpm"], nb)
        else:
            lab = label_track(a["energy"])
        z = np.load(f)
        ok = z["covered"] > 0.5 * z["bar_s"]
        parts = []
        if features in ("fly", "fused"):
            parts.append(bar_features(z["rates"], group_of, len(groups)))
        if features in ("energy", "fused"):
            parts.append(energy_features(a["energy"])[:len(ok)])
        X = np.concatenate(parts, 1)
        y = np.array([classes.index(c) for c in lab])
        frac = (np.arange(nb) + 0.5) / nb
        tracks.append({"slug": f.stem, "X": X[ok], "y": y[ok], "frac": frac[ok]})
    n_fly = 2 * len(groups) if features in ("fly", "fused") else 0
    return tracks, groups, classes, n_fly


def fold(slug: str, k: int = 5) -> int:
    return int(hashlib.md5(slug.encode()).hexdigest(), 16) % k


def train(tracks, lam, n_fly, k, energy_lam=0.002):
    X = np.concatenate([t["X"] for t in tracks])
    y = np.concatenate([t["y"] for t in tracks])
    w_cls = 1 / np.maximum(1, np.bincount(y, minlength=k))
    mu, sd = X.mean(0), X.std(0) + 1e-3
    lamv = np.full(X.shape[1], lam)
    lamv[n_fly:] = energy_lam                                   # the app's energy features (if any)
    W, b = fit_logreg((X - mu) / sd, y, k, lam=lamv, w_cls=w_cls / w_cls.mean())
    T, start, pos = learn_arrangement([t["y"] for t in tracks], k)
    return {"W": W, "b": b, "mu": mu, "sd": sd, "T": T, "start": start, "pos": pos}


def predict(t, m):
    P = softmax(((t["X"] - m["mu"]) / m["sd"]) @ m["W"] + m["b"])
    return P, hmm_filter(P, t["frac"], T=m["T"], start=m["start"], pos=m["pos"])


def cross_validate(tracks, lam, n_fly, k, classes):
    per = {"fly_only": [], "with_prior": [], "prior_only": []}
    for f in range(5):
        tr = [t for t in tracks if fold(t["slug"]) != f]
        te = [t for t in tracks if fold(t["slug"]) == f]
        m = train(tr, lam, n_fly, k)
        y = np.concatenate([t["y"] for t in te])
        raw, post, pri = [], [], []
        for t in te:
            P, A = predict(t, m)
            raw.append(P.argmax(1)); post.append(A.argmax(1))
            pri.append(hmm_filter(np.full_like(P, 1 / k), t["frac"], T=m["T"], start=m["start"], pos=m["pos"]).argmax(1))
        per["fly_only"].append(scores(y, np.concatenate(raw), k, classes))
        per["with_prior"].append(scores(y, np.concatenate(post), k, classes))
        per["prior_only"].append(scores(y, np.concatenate(pri), k, classes))
    def agg(rs):
        out = {}
        for key in ["accuracy", "macro_f1"] + [f"{c}.{m}" for c in classes for m in ("precision", "recall", "f1")]:
            v = np.array([r[key] if "." not in key else r[key.split(".")[0]][key.split(".")[1]] for r in rs])
            out[key] = [round(float(v.mean()), 3), round(float(1.96 * v.std(ddof=1) / np.sqrt(len(v))), 3)]
        return out
    return {k_: agg(v) for k_, v in per.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", default="trained")
    ap.add_argument("--labels", choices=["allin1", "energy"], default="allin1")
    ap.add_argument("--features", choices=["fly", "energy", "fused"], default="fused")
    ap.add_argument("--lam", type=float, default=None, help="neuron-feature penalty (default: picked by CV)")
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--bench-fold", type=int, default=0,
                    help="the exported model leaves this fold out, and data/realtracks/held_out.json lists it for djbench")
    args = ap.parse_args()
    tracks, groups, classes, n_fly = load(args.brain, args.labels, args.features)
    k = len(classes)
    print(f"{len(tracks)} tracks, {sum(len(t['y']) for t in tracks)} bars, labels {args.labels}, features {args.features}")
    lams = [args.lam] if args.lam is not None else ([0.01, 0.05, 0.2] if n_fly else [0.01])
    best = None
    for lam in lams:
        cv = cross_validate(tracks, lam, n_fly, k, classes)
        print(f"lam {lam}: macro-F1 {cv['with_prior']['macro_f1']} (classifier alone {cv['fly_only']['macro_f1']}, "
              f"prior alone {cv['prior_only']['macro_f1']})", flush=True)
        if best is None or cv["with_prior"]["macro_f1"][0] > best[1]["with_prior"]["macro_f1"][0]:
            best = (lam, cv)
    lam, cv = best
    res = {"brain": args.brain, "labels": args.labels, "features": args.features, "lam": lam, "cv": cv}
    out = DATA / f"sections_cv_{args.brain}_{args.labels}_{args.features}.json"
    json.dump(res, open(out, "w"), indent=1)
    print(json.dumps(cv["with_prior"], indent=0)[:1500])
    if args.export:
        keep = [t for t in tracks if fold(t["slug"]) != args.bench_fold]
        json.dump([t["slug"] for t in tracks if fold(t["slug"]) == args.bench_fold], open(DATA / "held_out.json", "w"))
        m = train(keep, lam, n_fly, k)
        W2 = m["W"] / m["sd"][:, None]                       # fold standardisation in: logits = x @ W' + b'
        b2 = m["b"] - m["mu"] @ W2
        spec = {"version": 3, "brain": args.brain, "labels": args.labels, "features": args.features,
                "classes": classes, "groups": groups if n_fly else [], "energy": args.features in ("energy", "fused"),
                "feature": {"sd_floor": 0.05, "warmup_bars": 4, "context_bars": 4},
                "W": np.round(W2, 5).tolist(), "b": np.round(b2, 5).tolist(),
                "T": np.round(m["T"], 5).tolist(), "start": np.round(m["start"], 5).tolist(), "pos": np.round(m["pos"], 4).tolist(),
                "cv": {"macro_f1": cv["with_prior"]["macro_f1"], "accuracy": cv["with_prior"]["accuracy"]},
                "trained_on_tracks": len(keep), "bench_fold": args.bench_fold}
        json.dump(spec, open(ROOT / "brains" / f"sections_{args.brain}.json", "w"))
        print("exported brains/sections_%s.json" % args.brain)


if __name__ == "__main__":
    main()
