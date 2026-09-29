"""Train the fly brain to DJ: error-modulated (dopamine-like) plasticity on the synapses onto its DJ neurons.

    python -m flybrain.train --method fit --rounds 2   # trains, evaluates before/after, saves brains/trained_brain.npz

What is learned
  Four DJ "intents", each expressed by a real descending-neuron group the app already listens to:
    BUILD  giant fiber DNp01                  fire during a track's build-up           -> cue builds / rolls
    SPACE  DNp02 · DNp06 · DNp11 · DNp55      fire in breakdowns                         -> echo / reverb
    MIX    DNb06 · DNge113 · DNge145          fire in intros and outros (mixing windows) -> transitions
    PEAK   DNg24 · DNg29                      fire in the main (full-energy) sections    -> hype / flourishes
  Targets come from each track's arrangement (intro 8 | build 8 | main 16 | break 4 | main 8 | outro 4 bars).

How
  The fly hears each track through the same ears as in the app (flybrain/ears.py). For every synapse i -> j onto a
  trained neuron j, the product of presynaptic activity and the postsynaptic error is accumulated over the track:
      G_ij = sum_t (target_j - rate_j)(t) * trace_i(t)          (class-balanced: rare "fire now" moments weigh more)
  and applied once per track: dw_ij = eta * sign_ij * G_ij / RMS(G_ij over past tracks)  (a slow, averaged update
  instead of noisy 20 ms steps).
  trace_i: presynaptic activity (spikes low-passed, 100 ms); rate_j: postsynaptic rate (200 ms); the error term plays
  the role of dopamine in the fly's own learning circuits (three-factor rule: pre activity x post error x
  neuromodulator). Only existing synapses change; sign (excitatory / inhibitory, Dale's law) is kept; magnitude is
  bounded to [0, 4x original + 5 synapses' worth].
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np

from .brain import Brain, ROOT
from .ears import ear_drive, load_wav
from .mapping import build_inputs, load_annotations

TRACKS = ROOT / "data" / "tracks"
OUT = ROOT / "brains" / "trained_brain.npz"      # small (~160 KB), kept in git
LOG = ROOT / "brains" / "training_log.json"

INTENTS = {
    "BUILD": ["DNp01"],
    "SPACE": ["DNp02", "DNp06", "DNp11", "DNp55"],
    "MIX": ["DNb06", "DNge113", "DNge145"],
    "PEAK": ["DNg24", "DNg29"],
}
HIGH, LOW = 30.0, 2.0          # target rates (Hz)
FRAME_MS = 20.0
HELD_OUT = ["johnston-s-organ", "proboscis-dhamaal"]   # one club, one desi track never used for training


def intent_targets(meta: dict, n_frames: int) -> np.ndarray:
    """[frames, 4] target on/off for BUILD, SPACE, MIX, PEAK from the arrangement."""
    fps = 1000 / FRAME_MS
    t = (np.arange(n_frames) + 0.5) / fps + 1024 / meta["sr"]          # frame centres (ears use 2048-sample windows)
    bar = (t - meta["firstBeat"]) * meta["bpm"] / 60 / 4
    y = np.zeros((n_frames, 4), bool)
    for name, a, b in meta["sections"]:
        m = (bar >= a) & (bar < b)
        if name == "build":
            y[m, 0] = True
        if name == "break":
            y[m, 1] = True
        if name in ("intro", "outro"):
            y[m, 2] = True
        if name == "main":
            y[m, 3] = True
    return y


class Trainer:
    def __init__(self, eta: float, seed: int = 1):
        self.brain = b = Brain(seed=seed)
        ann = load_annotations()
        self.ear_chans = [c for c in build_inputs(ann, b.id2idx) if c.name.startswith("ear")]
        self.stim_idx = np.concatenate([c.idx for c in self.ear_chans])
        # trained neurons, grouped by intent
        self.groups = []
        for k, types in enumerate(INTENTS.values()):
            ids = ann.index[ann.cell_type.isin(types) & (ann.super_class == "descending")]
            self.groups.append(np.array(sorted(b.id2idx[i] for i in ids if i in b.id2idx), np.int64))
        self.post = np.concatenate(self.groups)
        self.post_group = np.concatenate([np.full(len(g), k) for k, g in enumerate(self.groups)])
        side_of = {int(i): ann.loc[i, "side"] for i in ann.index[ann.super_class == "descending"]}
        self.post_side = np.array([0 if side_of.get(int(b.ids[i])) != "right" else 1 for i in self.post])
        # every synapse (CSR entry) onto a trained neuron
        slot = np.full(b.n, -1, np.int64); slot[self.post] = np.arange(len(self.post))
        self.K = np.nonzero(slot[b.indices] >= 0)[0]
        self.syn_post = slot[b.indices[self.K]]
        self.syn_pre = np.searchsorted(b.indptr, self.K, side="right") - 1
        self.w0 = b.weights[self.K].copy()
        self.sign = np.sign(self.w0)
        self.mag = np.abs(self.w0).astype(np.float64)
        self.mag_max = 4 * np.abs(self.w0) + 5 * 0.275
        self.eta = eta
        self.g2 = np.zeros(len(self.K))            # running mean square of each synapse's accumulated gradient
        self.pre_u, self.pre_inv = np.unique(self.syn_pre, return_inverse=True)
        print(f"trainable: {len(self.post)} neurons in 4 intent groups, {len(self.K):,} synapses from "
              f"{len(self.pre_u):,} presynaptic neurons")

    def set_weights(self, mag):
        self.brain.weights[self.K] = (self.sign * mag).astype(np.float32)

    def run_track(self, drive: np.ndarray, targets: np.ndarray, learn: bool):
        """Play one track through the ears. Returns per-frame group rates [frames, 4] (Hz per neuron)."""
        b = self.brain
        b.reset()
        n = len(drive)
        a_pre, a_post = math.exp(-FRAME_MS / 100), math.exp(-FRAME_MS / 200)
        trace = np.zeros(len(self.pre_u))
        rate = np.zeros(len(self.post))
        out = np.zeros((n, 4))
        rates_hz = np.concatenate([np.full(len(c.idx), 0.0) for c in self.ear_chans])
        seg = np.cumsum([0] + [len(c.idx) for c in self.ear_chans])
        G = np.zeros(len(self.K))
        tgt_hz = np.where(targets, HIGH, LOW)
        # class balance: "fire now" moments are rare (8–24% of a track); weight them so on and off count equally
        p_on = np.clip(targets.mean(0), 0.02, 0.98)
        bal = np.where(targets, 0.5 / p_on, 0.5 / (1 - p_on))
        for f in range(n):
            for k, c in enumerate(self.ear_chans):
                rates_hz[seg[k]:seg[k + 1]] = drive[f, k] * c.max_hz
            b.set_stim(self.stim_idx, rates_hz)
            si, _ = b.run(FRAME_MS)
            cnt = np.bincount(si, minlength=b.n)
            post_hz = cnt[self.post] * (1000 / FRAME_MS)
            rate = a_post * rate + (1 - a_post) * post_hz
            for k in range(4):
                out[f, k] = post_hz[self.post_group == k].mean()
            if learn:
                trace = a_pre * trace + cnt[self.pre_u]
                err = (tgt_hz[f, self.post_group] - rate) * bal[f, self.post_group]   # per trained neuron
                G += err[self.syn_post] * trace[self.pre_inv]
        if learn:
            G /= n
            self.g2 = 0.8 * self.g2 + 0.2 * G * G if self.g2.any() else G * G
            step = self.eta * G / (np.sqrt(self.g2) + 1e-9)             # ~eta per synapse per track, sign from G
            self.mag += step * self.sign * (np.abs(self.w0) + 0.275)     # scaled to each synapse's own size
            np.clip(self.mag, 0, self.mag_max, out=self.mag)
            fz = getattr(self, "frozen", None)
            if fz is not None and fz.any():
                self.mag[fz] = np.abs(self.w0[fz])
            self.set_weights(self.mag)
        return out


    # ---------------- model-based ("fit") training ----------------
    def record(self, drive: np.ndarray):
        """Play a track without learning; return presynaptic rates [frames, n_pre] and trained-neuron rates [frames, n_post],
        both low-passed at 200 ms (Hz)."""
        b = self.brain
        b.reset()
        n, a = len(drive), math.exp(-FRAME_MS / 200)
        rates_hz = np.zeros(len(self.stim_idx))
        seg = np.cumsum([0] + [len(c.idx) for c in self.ear_chans])
        X = np.zeros((n, len(self.pre_u)), np.float32); R = np.zeros((n, len(self.post)), np.float32)
        x = np.zeros(len(self.pre_u)); r = np.zeros(len(self.post))
        for f in range(n):
            for k, c in enumerate(self.ear_chans):
                rates_hz[seg[k]:seg[k + 1]] = drive[f, k] * c.max_hz
            b.set_stim(self.stim_idx, rates_hz)
            si, _ = b.run(FRAME_MS)
            cnt = np.bincount(si, minlength=b.n) * (1000 / FRAME_MS)
            x = a * x + (1 - a) * cnt[self.pre_u]; r = a * r + (1 - a) * cnt[self.post]
            X[f] = x; R[f] = r
        return X, R

    def fit(self, X: np.ndarray, R: np.ndarray, Y: np.ndarray, lam: float = 0.05, iters: int = 400, col_of_pre=None):
        """For each trained neuron, fit its synapse magnitudes so a rectified-linear model of the neuron
        (rate = a * (drive - theta), measured from the recording) hits the class-balanced targets.
        Sign fixed (Dale's law), magnitudes in [0, bound], L2 pull toward the connectome's own weights."""
        per_neuron = Y.shape[1] == len(self.post)            # split training: each neuron has its own ear's targets
        tgt = np.where(Y, HIGH, LOW)
        p_on = np.clip(Y.mean(0), 0.02, 0.98)
        report = []
        for j in range(len(self.post)):
            g = self.post_group[j]
            S = np.nonzero(self.syn_post == j)[0]
            if not len(S):
                continue
            if col_of_pre is not None:                               # X holds only presynaptic neurons that fired
                cols = col_of_pre[self.pre_inv[S]]
                S, cols = S[cols >= 0], cols[cols >= 0]
                Xj = X[:, cols].astype(np.float64)
            else:
                Xj = X[:, self.pre_inv[S]].astype(np.float64)
            keep = Xj.std(0) > 0 if len(S) else np.zeros(0, bool)    # silent inputs can't be learned
            S, Xj = S[keep], Xj[:, keep]
            if not len(S):
                continue
            s, m0 = self.sign[S], self.mag[S].copy()
            scale = np.abs(self.w0[S]) + 0.275
            u = Xj @ (s * m0)
            r = R[:, j]
            act = r > 1
            if act.sum() > 50 and np.std(u[act]) > 0:
                A = np.vstack([u[act], np.ones(act.sum())]).T
                a, c = np.linalg.lstsq(A, r[act], rcond=None)[0]
            else:
                a, c = 0.0, 0.0
            if a <= 1e-6:                                           # no usable gain estimate: assume a gentle one
                a = max(1e-3, r.mean() / max(u.mean(), 1e-6)); c = 0.0
            theta = -c / a
            c = j if per_neuron else g
            bal = np.where(Y[:, c], 0.5 / p_on[c], 0.5 / (1 - p_on[c]))
            T = tgt[:, c]
            z = m0 / scale                                          # optimise in units of each synapse's size
            z0 = np.abs(self.w0[S]) / scale
            zmax = self.mag_max[S] / scale
            mom, vel = np.zeros_like(z), np.zeros_like(z)
            for it in range(1, iters + 1):
                m = z * scale
                u = Xj @ (s * m)
                pre = a * (u - theta)
                out = np.maximum(pre, 0)
                d = bal * 2 * (out - T) * a * (pre > 0) / len(u)
                grad = (Xj.T @ d) * s * scale + 2 * lam * (z - z0) / len(z)
                mom = 0.9 * mom + 0.1 * grad; vel = 0.999 * vel + 0.001 * grad * grad
                z -= 0.05 * (mom / (1 - 0.9 ** it)) / (np.sqrt(vel / (1 - 0.999 ** it)) + 1e-9)
                np.clip(z, 0, zmax, out=z)
            if getattr(self, "frozen", None) is not None and self.frozen[S].any():
                continue                                          # frozen intent: leave its synapses alone
            self.mag[S] = z * scale
            loss0 = float(np.sum(bal * (np.maximum(a * (Xj @ (s * m0) - theta), 0) - T) ** 2) / len(T))
            loss1 = float(np.sum(bal * (out - T) ** 2) / len(T))
            report.append((j, g, len(S), loss0, loss1))
        self.set_weights(self.mag)
        return report


def score(rates: np.ndarray, targets: np.ndarray) -> dict:
    """Per intent: rate in target sections vs elsewhere, their ratio, and the correlation with the target."""
    res = {}
    for k, name in enumerate(INTENTS):
        on, off = rates[targets[:, k], k], rates[~targets[:, k], k]
        # smooth over 1 s before correlating (the DJ logic works on smoothed rates)
        r = np.convolve(rates[:, k], np.ones(50) / 50, mode="same")
        corr = float(np.corrcoef(r, targets[:, k])[0, 1]) if r.std() > 0 else 0.0
        res[name] = {"on_hz": float(on.mean()) if len(on) else 0.0, "off_hz": float(off.mean()),
                     "selectivity": float((on.mean() + 0.1) / (off.mean() + 0.1)) if len(on) else 0.0, "corr": corr}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--method", choices=["fit", "online"], default="fit",
                    help="fit: record the brain, fit the synapses to a model of each neuron, verify (fast); "
                         "online: the three-factor rule applied track by track (slow)")
    ap.add_argument("--epochs", type=int, default=8, help="online: passes over the training tracks")
    ap.add_argument("--rounds", type=int, default=3, help="fit: record -> fit -> install rounds")
    ap.add_argument("--eta", type=float, default=0.05)
    ap.add_argument("--lam", type=float, default=0.05, help="fit: pull toward the connectome's original weights")
    ap.add_argument("--init", help="start from a saved trained brain (e.g. brains/trained_brain.npz)")
    ap.add_argument("--split", action="store_true",
                    help="train as the app listens: a different track in each ear (the other offset in time); each "
                         "side's neurons learn their own ear's sections")
    ap.add_argument("--freeze", default="", help="comma-separated intents whose synapses stay at the connectome's "
                                                   "original weights (e.g. BUILD, which can't be learned from sound)")
    args = ap.parse_args()
    t0 = time.time()
    tr = Trainer(args.eta)
    if args.init:
        z = np.load(args.init)
        assert np.array_equal(z["K"], tr.K), "saved brain was trained on a different synapse set"
        tr.mag = np.abs(z["weights"]).astype(np.float64)
        tr.set_weights(tr.mag)
        print(f"starting from {args.init} (round/epoch {int(z['epoch'])})")
    frozen = [list(INTENTS).index(x) for x in args.freeze.split(",") if x]
    tr.frozen = np.isin(tr.post_group[tr.syn_post], frozen)
    if frozen:
        tr.mag[tr.frozen] = np.abs(tr.w0[tr.frozen]); tr.set_weights(tr.mag)
        print(f"frozen at the connectome's weights: {args.freeze} ({int(tr.frozen.sum())} synapses)")
    data = {}
    for wav in sorted(TRACKS.glob("*.wav")):
        meta = json.loads(wav.with_suffix(".json").read_text())
        x, sr = load_wav(wav)
        drive, names = ear_drive(x, sr, FRAME_MS / 1000)
        assert names == [c.name for c in tr.ear_chans]
        data[wav.stem] = (drive, intent_targets(meta, len(drive)))
    # held out: the two base tracks and every variation of them (…-v1, …-v2)
    is_held = lambda k: any(k == h or k.startswith(h + "-v") for h in HELD_OUT)
    held = [k for k in data if is_held(k)]
    train = [k for k in data if not is_held(k)]
    print(f"{len(data)} tracks ({len(train)} train, {len(held)} held out: {', '.join(held)}); features in {time.time() - t0:.0f}s")

    # split-ear pairs: left ear = track A, right ear = track B started at another point (as with two decks)
    def make_pairs(keys, seed):
        rng_ = np.random.default_rng(seed)
        keys = list(keys); pairs = []
        for i, a in enumerate(keys):
            bk = keys[(i + 1 + int(rng_.integers(0, len(keys) - 1))) % len(keys)]
            if bk == a:
                bk = keys[(i + 1) % len(keys)]
            dA, yA = data[a]; dB, yB = data[bk]
            off = int(rng_.integers(0, len(dB) // 2))
            dB, yB = np.roll(dB, -off, 0), np.roll(yB, -off, 0)
            n = min(len(dA), len(dB))
            drive = np.hstack([dA[:n, :12], dB[:n, 12:]])
            Yn = np.where(tr.post_side[None, :] == 0, yA[:n][:, tr.post_group], yB[:n][:, tr.post_group])
            pairs.append((f"{a} | {bk}", drive, Yn))
        return pairs

    def evaluate_split(tag, pairs):
        """per intent: correlation of each neuron's 1 s causal-smoothed rate with ITS OWN ear's target, averaged"""
        acc = {i: [] for i in INTENTS}
        for name, drive, Yn in pairs:
            _, R = tr.record(drive)
            for j in range(len(tr.post)):
                sm = np.zeros(len(R)); f = 0.0
                for t_, v in enumerate(R[:, j]):
                    f += (v - f) * 0.02; sm[t_] = f
                y = Yn[:, j]
                if sm.std() > 0 and 0 < y.mean() < 1:
                    acc[list(INTENTS)[tr.post_group[j]]].append(np.corrcoef(sm, y)[0, 1])
        summ = {i: float(np.mean(v)) if v else 0.0 for i, v in acc.items()}
        print(f"[{tag}] " + " | ".join(f"{i}: r {v:+.2f}" for i, v in summ.items()) + "  (split ears, held-out pairs)", flush=True)
        return summ

    def evaluate(tag, full=False):
        """score held-out tracks + a few training tracks (all of them when full=True)"""
        keys_now = list(data) if full else held + train[:3]
        res = {}
        for k in keys_now:
            d, y = data[k]
            res[k] = score(tr.run_track(d, y, learn=False), y)
        summ = {}
        for split, keys in (("train", [k for k in train if k in res]), ("held_out", held)):
            summ[split] = {i: {m: float(np.mean([res[k][i][m] for k in keys])) for m in ("on_hz", "off_hz", "selectivity", "corr")}
                           for i in INTENTS}
        print(f"[{tag}] " + " | ".join(f"{i}: sel {summ['held_out'][i]['selectivity']:.2f} r {summ['held_out'][i]['corr']:+.2f}"
                                        for i in INTENTS) + "  (held-out)")
        return {"per_track": res, "summary": summ}

    log = {"method": args.method, "init": args.init, "freeze": args.freeze, "held_out_tracks": held, "train_tracks": train, "eta": args.eta, "lam": args.lam, "epochs": args.epochs, "rounds": args.rounds,
           "intents": INTENTS, "held_out": HELD_OUT,
           "trainable_synapses": int(len(tr.K)), "trainable_neurons": int(len(tr.post))}
    if args.split:
        train_pairs = make_pairs(train, 0)
        held_pairs = make_pairs(held, 1)
        log["split"] = True
        log["before"] = {"split": evaluate_split("before", held_pairs)}
    else:
        log["before"] = evaluate("before", full=True)
    rng = np.random.default_rng(0)
    log["epochs_log"] = []
    if args.method == "fit":
        for rd in range(args.rounds):
            te = time.time()
            # record every training track, keeping only presynaptic neurons that ever fire (memory: ~10x smaller)
            parts, Rs = [], []
            sources = [(p[1], p[2]) for p in train_pairs] if args.split else [(data[k][0], data[k][1]) for k in train]
            for drive_k, _ in sources:
                Xk, Rk = tr.record(drive_k)
                cols = np.nonzero(Xk.max(0) > 0)[0]
                parts.append((cols, Xk[:, cols].copy())); Rs.append(Rk)
                del Xk
            union = np.unique(np.concatenate([c for c, _ in parts]))
            col_of_pre = np.full(len(tr.pre_u), -1, np.int64); col_of_pre[union] = np.arange(len(union))
            X = np.zeros((sum(len(x) for _, x in parts), len(union)), np.float32)
            row = 0
            for cols, xs in parts:
                X[row:row + len(xs), col_of_pre[cols]] = xs; row += len(xs)
            R = np.vstack(Rs); Y = np.vstack([y_k for _, y_k in sources])
            print(f"  recorded {len(X):,} frames, {len(union)} presynaptic neurons active", flush=True)
            rep = tr.fit(X, R, Y, lam=args.lam, col_of_pre=col_of_pre)
            del X, R, parts
            change = float(np.mean(np.abs(tr.mag - np.abs(tr.w0)) / (np.abs(tr.w0) + 1e-6)))
            ev = {"summary": {"split": evaluate_split(f"round {rd + 1}", held_pairs)}} if args.split else evaluate(f"round {rd + 1}")
            log["epochs_log"].append({"round": rd + 1, "mean_rel_weight_change": change, "summary": ev["summary"],
                                      "model_loss_before": float(np.mean([x[3] for x in rep])),
                                      "model_loss_after": float(np.mean([x[4] for x in rep])), "seconds": time.time() - te})
            np.savez(OUT, K=tr.K, weights=(tr.sign * tr.mag).astype(np.float32), w0=tr.w0,
                     intents=json.dumps(INTENTS), epoch=rd + 1, method="fit")
            LOG.write_text(json.dumps(log, indent=1))
            print(f"  round {rd + 1}: model loss {log['epochs_log'][-1]['model_loss_before']:.0f} -> "
                  f"{log['epochs_log'][-1]['model_loss_after']:.0f}, mean |dw|/w0 {change:.3f}, {time.time() - te:.0f}s")
    for ep in range(args.epochs if args.method == "online" else 0):
        te = time.time()
        for k in rng.permutation(train):
            d, y = data[k]
            tr.run_track(d, y, learn=True)
        change = float(np.mean(np.abs(tr.mag - np.abs(tr.w0)) / (np.abs(tr.w0) + 1e-6)))
        ev = evaluate(f"epoch {ep + 1}")
        log["epochs_log"].append({"epoch": ep + 1, "mean_rel_weight_change": change, "summary": ev["summary"],
                                  "seconds": time.time() - te})
        np.savez(OUT, K=tr.K, weights=(tr.sign * tr.mag).astype(np.float32), w0=tr.w0,
                 intents=json.dumps(INTENTS), epoch=ep + 1, method="online" + (" from " + args.init if args.init else ""))
        LOG.write_text(json.dumps(log, indent=1))
        print(f"  epoch {ep + 1}: mean |dw|/w0 {change:.3f}, {time.time() - te:.0f}s")
    if args.split:
        log["after"] = log["epochs_log"][-1]["summary"] if log["epochs_log"] else log["before"]
    else:
        log["after"] = evaluate("after", full=True)["summary"] if log["epochs_log"] else log["before"]["summary"]
    LOG.write_text(json.dumps(log, indent=1))
    print(f"done in {(time.time() - t0) / 60:.1f} min -> {OUT}")


if __name__ == "__main__":
    main()
