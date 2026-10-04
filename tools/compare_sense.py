"""Does the fly's brain add anything? A fair comparison of what section sense can be built from.

Arms (same model, same HMM, same nested hyper-parameter search, same 5 outer folds by track):
  prior    song position + learned section order only
  ears     the fly's own input: the 24 Johnston's-organ band drives, per bar (what goes INTO the brain)
  energy   the app's per-bar loudness
  naive    the untouched connectome's output neurons (listener fly, data/realtracks/rec_naive)
  trained  the trained brain's output neurons (data/realtracks/rec_trained)
Labels: All-In-One sections (intro / verse / chorus / break / outro). Reported: macro-F1, balanced accuracy and
accuracy (with the always-chorus baseline), per outer fold, and paired differences between arms.
    .venv/bin/python tools/compare_sense.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import numpy as np

from flybrain.sections import DJ_CLASSES, bar_features, energy_features, fit_logreg, hmm_filter, label_allin1, learn_arrangement, softmax, type_groups
from train_sections import fold

DATA = ROOT / "data" / "realtracks"
K = len(DJ_CLASSES)


def causal_z(x):
    """[bars, d] -> causal z against the track so far + previous-4-bar context (like bar_features)."""
    z = np.zeros_like(x); s = np.zeros(x.shape[1]); s2 = np.zeros(x.shape[1])
    for b in range(len(x)):
        s += x[b]; s2 += x[b] ** 2; k = b + 1; mu = s / k
        sd = np.sqrt(np.maximum(s2 / k - mu ** 2, 0)) + 0.05
        z[b] = (x[b] - mu) / sd if k >= 4 else 0
    ctx = np.zeros_like(z)
    for b in range(1, len(z)):
        ctx[b] = z[max(0, b - 4):b].mean(0)
    return np.concatenate([z, ctx], 1)


def load():
    from flybrain.brain import load_connectome
    from flybrain.mapping import build_outputs, load_annotations
    ids, *_ = load_connectome()
    _, meta = build_outputs(load_annotations(), ids)
    groups, group_of = type_groups(meta)
    A = json.load(open(DATA / "analysis.json"))
    tracks = []
    for f in sorted((DATA / "rec_trained").glob("*.npz")):
        s = f.stem
        if not (DATA / "rec_naive" / f"{s}.npz").exists() or not (DATA / "allin1" / f"{s}.json").exists():
            continue
        a = A[s]; nb = len(a["energy"])
        y = np.array([DJ_CLASSES.index(c) for c in label_allin1(json.load(open(DATA / "allin1" / f"{s}.json")), a["firstBeat"], a["bpm"], nb)])
        zt, zn = np.load(f), np.load(DATA / "rec_naive" / f"{s}.npz")
        ok = zt["covered"] > 0.5 * zt["bar_s"]
        # ear drive per bar (20 ms frames -> the same bars the recorder used)
        d = np.load(DATA / "drive" / f"{s}.npy").astype(np.float32)
        tc = np.arange(len(d)) * 0.02 + 1024 / 44100
        bi = ((tc - a["firstBeat"]) // zt["bar_s"]).astype(int)
        E = np.zeros((nb, d.shape[1])); c = np.zeros(nb)
        m = (bi >= 0) & (bi < nb)
        np.add.at(E, bi[m], d[m]); np.add.at(c, bi[m], 1)
        ears = causal_z(np.log1p(10 * E / np.maximum(c, 1)[:, None]))
        X = {"ears": ears, "energy": energy_features(a["energy"])[:nb],
             "naive": bar_features(zn["rates"], group_of, len(groups)), "trained": bar_features(zt["rates"], group_of, len(groups))}
        tracks.append({"slug": s, "y": y[ok], "frac": ((np.arange(nb) + 0.5) / nb)[ok], **{k: v[ok] for k, v in X.items()}})
    return tracks


def fit(tr, arm, lam):
    X = np.concatenate([t[arm] for t in tr]); y = np.concatenate([t["y"] for t in tr])
    w = 1 / np.maximum(1, np.bincount(y, minlength=K)); mu, sd = X.mean(0), X.std(0) + 1e-3
    W, b = fit_logreg((X - mu) / sd, y, K, lam=lam, w_cls=w / w.mean())
    return W, b, mu, sd


def predict(tracks, arm, model, arr):
    T, start, pos = arr
    out = []
    for t in tracks:
        if arm == "prior":
            P = np.full((len(t["y"]), K), 1 / K)
        else:
            W, b, mu, sd = model; P = softmax(((t[arm] - mu) / sd) @ W + b)
        out.append(hmm_filter(P, t["frac"], T=T, start=start, pos=pos).argmax(1))
    return out


def metrics(y, p):
    f1, rec = [], []
    for c in range(K):
        tp = np.sum((p == c) & (y == c)); pr = tp / max(1, np.sum(p == c)); r = tp / max(1, np.sum(y == c))
        f1.append(2 * pr * r / max(1e-9, pr + r)); rec.append(r)
    return {"macro_f1": float(np.mean(f1)), "balanced_acc": float(np.mean(rec)), "acc": float(np.mean(y == p))}


def main():
    tracks = load()
    arms = ["prior", "ears", "energy", "naive", "trained"]
    lams = [0.01, 0.05, 0.2, 1.0]
    res = {a: [] for a in arms}
    maj = []
    for f in range(5):
        tr = [t for t in tracks if fold(t["slug"]) != f]; te = [t for t in tracks if fold(t["slug"]) == f]
        y = np.concatenate([t["y"] for t in te]); maj.append(float(np.mean(y == DJ_CLASSES.index("chorus"))))
        arr = learn_arrangement([t["y"] for t in tr], K)
        for arm in arms:
            if arm == "prior":
                res[arm].append(metrics(y, np.concatenate(predict(te, arm, None, arr)))); continue
            # nested: pick lambda on the training folds only (inner 4-fold by track)
            best, bl = -1, None
            for lam in lams:
                sc = []
                for g in range(5):
                    if g == f: continue
                    itr = [t for t in tr if fold(t["slug"]) != g]; ite = [t for t in tr if fold(t["slug"]) == g]
                    iarr = learn_arrangement([t["y"] for t in itr], K)
                    yy = np.concatenate([t["y"] for t in ite])
                    sc.append(metrics(yy, np.concatenate(predict(ite, arm, fit(itr, arm, lam), iarr)))["macro_f1"])
                if np.mean(sc) > best: best, bl = np.mean(sc), lam
            res[arm].append({**metrics(y, np.concatenate(predict(te, arm, fit(tr, arm, bl), arr))), "lam": bl})
        print(f"fold {f}: " + "  ".join(f"{a} {res[a][-1]['macro_f1']:.3f}" for a in arms), flush=True)
    tcrit = 2.776
    summary = {}
    print(f"\n{len(tracks)} tracks. always-chorus accuracy {np.mean(maj):.3f}")
    for a in arms:
        v = {m: np.array([r[m] for r in res[a]]) for m in ("macro_f1", "balanced_acc", "acc")}
        summary[a] = {m: [round(float(x.mean()), 3), round(float(tcrit * x.std(ddof=1) / np.sqrt(5)), 3)] for m, x in v.items()}
        print(f"{a:8s} macro-F1 {summary[a]['macro_f1']}  balanced acc {summary[a]['balanced_acc']}  acc {summary[a]['acc']}")
    print("\npaired differences in macro-F1 (mean ± t95 over folds; > 0 means the first arm is better):")
    pairs = [("trained", "naive"), ("trained", "ears"), ("naive", "ears"), ("trained", "energy"), ("ears", "energy"), ("ears", "prior"), ("trained", "prior")]
    for x, z in pairs:
        d = np.array([res[x][i]["macro_f1"] - res[z][i]["macro_f1"] for i in range(5)])
        summary[f"{x}-{z}"] = [round(float(d.mean()), 3), round(float(tcrit * d.std(ddof=1) / np.sqrt(5)), 3)]
        print(f"  {x:8s} - {z:8s} {d.mean():+.3f} ± {tcrit * d.std(ddof=1) / np.sqrt(5):.3f}   folds {np.round(d, 3).tolist()}")
    json.dump({"folds": res, "summary": summary, "always_chorus_acc": float(np.mean(maj))}, open(DATA / "compare_sense.json", "w"), indent=1)


if __name__ == "__main__":
    main()
