"""Section sense, version 2: where in the track a listener fly is, read from its descending / motor neurons.

Version 1 (docs/AUDIT.md, findings 1-3) z-scored a few trained neurons and fired when the value ranked in the top X%
of the last 3 minutes. It ignored the bar grid and the order of sections, and threw most of the signal away.

Version 2:
  1. labels: reference sections of real tracks (the user's crate), from each track's whole energy profile seen at
     once (label_track). The fly has to sense them causally, live.
  2. features: per bar, the listener fly's output-neuron rates pooled by cell type, log-scaled and normalised
     against the track so far (causal), plus the previous 4 bars' mean.
  3. classifier: multinomial logistic regression (numpy, L2), trained on whole tracks, tested on held-out tracks.
  4. arrangement prior: an online HMM over intro -> main <-> break -> outro, with the track position (how much of
     the deck is left, which a DJ always knows) shaping the intro / outro odds.
The app runs the same model in the browser (web/js/sections.js) from brains/sections.json.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "realtracks"
CLASSES = ["intro", "main", "break", "outro"]


# ---------------- reference labels ----------------
def label_track(energy: list[float]) -> list[str]:
    """Per-bar reference sections from the per-bar energy (web/js/analysis.js analyzeEnergy), judged in 4-bar blocks
    relative to the track's own range:
        main   blocks at >= 60% of the way from its quiet (10th pct) to loud (90th pct) level
        break  blocks below 35% of the way, between the first and last main block
        intro  everything before the first main block (at least 4 bars)
        outro  everything after the last main block (at least 4 bars)
    """
    e = np.asarray(energy, float)
    n = len(e)
    nb = max(1, n // 4)
    blk = np.array([e[4 * k:4 * k + 4].mean() for k in range(nb)])
    lo, hi = np.percentile(blk, 10), np.percentile(blk, 90)
    rel = (blk - lo) / max(1e-6, hi - lo)
    main = rel >= 0.6
    lab = np.array(["main"] * nb, dtype=object)
    lab[rel < 0.35] = "break"
    first = int(np.argmax(main)) if main.any() else 1
    last = nb - 1 - int(np.argmax(main[::-1])) if main.any() else nb - 2
    first, last = max(1, first), min(nb - 2, last)
    lab[:first] = "intro"
    lab[last + 1:] = "outro"
    bars = [lab[min(b // 4, nb - 1)] for b in range(n)]
    return bars


# ---------------- features ----------------
def type_groups(meta: list[dict]) -> tuple[list[str], np.ndarray]:
    """Output slots pooled by (class, type): returns group names and slot -> group index."""
    keys = sorted({f"{m['cls']}:{m['type']}" for m in meta})
    pos = {k: i for i, k in enumerate(keys)}
    return keys, np.array([pos[f"{m['cls']}:{m['type']}"] for m in meta])


def bar_features(rates: np.ndarray, group_of: np.ndarray, n_groups: int) -> np.ndarray:
    """rates [bars, slots] (Hz) -> causal features [bars, 2 * n_groups]: log rate per type normalised against the
    track so far, and the mean of the previous 4 bars of that."""
    g = np.zeros((rates.shape[0], n_groups))
    np.add.at(g.T, group_of, rates.T)
    cnt = np.bincount(group_of, minlength=n_groups)
    x = np.log1p(g / np.maximum(1, cnt))
    z = np.zeros_like(x)
    s = np.zeros(n_groups)
    s2 = np.zeros(n_groups)
    for b in range(len(x)):
        s += x[b]
        s2 += x[b] ** 2
        k = b + 1
        mu = s / k
        sd = np.sqrt(np.maximum(s2 / k - mu ** 2, 0)) + 0.05
        z[b] = (x[b] - mu) / sd if k >= 4 else 0.0
    ctx = np.zeros_like(z)
    for b in range(len(z)):
        ctx[b] = z[max(0, b - 4):b].mean(0) if b > 0 else 0.0
    return np.concatenate([z, ctx], 1)


# ---------------- classifier ----------------
def fit_logreg(X, y, k, lam=1e-2, iters=600, lr=0.5, w_cls=None):
    """Multinomial logistic regression by full-batch gradient descent (features already ~unit scale)."""
    n, d = X.shape
    W = np.zeros((d, k))
    b = np.zeros(k)
    Y = np.eye(k)[y]
    sw = np.ones(n) if w_cls is None else w_cls[y]
    sw = sw / sw.mean()
    for _ in range(iters):
        P = softmax(X @ W + b)
        G = (P - Y) * sw[:, None] / n
        W -= lr * (X.T @ G + lam * W)
        b -= lr * G.sum(0)
    return W, b


def softmax(a):
    a = a - a.max(1, keepdims=True)
    e = np.exp(a)
    return e / e.sum(1, keepdims=True)


# ---------------- arrangement prior (online HMM) ----------------
def transitions(stay=0.93):
    """Section order: intro -> main; main <-> break; main / break -> outro; outro stays."""
    T = np.zeros((4, 4))
    i, m, br, o = range(4)
    T[i, i], T[i, m] = stay, 1 - stay
    T[m, m], T[m, br], T[m, o] = stay, (1 - stay) * 0.75, (1 - stay) * 0.25
    T[br, br], T[br, m], T[br, o] = stay, (1 - stay) * 0.8, (1 - stay) * 0.2
    T[o, o] = 1.0
    return T


def position_prior(frac: float) -> np.ndarray:
    """How likely each section is given how far into the track we are (0..1)."""
    intro = np.exp(-frac / 0.12)
    outro = np.exp(-(1 - frac) / 0.10)
    return np.array([intro, 1.0, 0.5, outro]) + 1e-3


def hmm_filter(P: np.ndarray, frac: np.ndarray, T=None, power=1.0) -> np.ndarray:
    """Forward-filter per-bar classifier probabilities P [bars, 4] -> posterior [bars, 4] (causal)."""
    T = transitions() if T is None else T
    a = np.array([0.9, 0.06, 0.02, 0.02])
    out = np.zeros_like(P)
    for b in range(len(P)):
        a = (a @ T) * (P[b] ** power) * position_prior(frac[b])
        a /= a.sum()
        out[b] = a
    return out


def scores(y, pred, k=4):
    """Per-class precision / recall / F1, accuracy and macro F1."""
    res = {}
    for c in range(k):
        tp = np.sum((pred == c) & (y == c))
        p = tp / max(1, np.sum(pred == c))
        r = tp / max(1, np.sum(y == c))
        res[CLASSES[c]] = {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / max(1e-9, p + r), 3)}
    res["accuracy"] = round(float(np.mean(y == pred)), 3)
    res["macro_f1"] = round(float(np.mean([res[CLASSES[c]]["f1"] for c in range(k)])), 3)
    return res
