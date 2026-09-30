# How brains/readout.json was built (2026-09-29). Run from the repo root: .venv/bin/python experiments/readout.py
# Build the trained brain's section readout: chosen neurons + z-score stats + hysteresis thresholds, all picked on the
# TRAINING tracks; report held-out F1; save brains/readout.json for the app.
import sys, json, math; sys.path.insert(0, '.')
import numpy as np
from pathlib import Path
from flybrain.brain import Brain
from flybrain.mapping import load_annotations, build_inputs, build_outputs
from flybrain.ears import load_wav, ear_drive
from flybrain.train import intent_targets, INTENTS, FRAME_MS, HELD_OUT
SP = 'data/readout_cache/'          # recorded DN rates (gitignored)
Path(SP).mkdir(parents=True, exist_ok=True)
ann = load_annotations(); b = Brain(); z = np.load('brains/trained_brain.npz'); b.weights[z['K']] = z['weights']
ear = [c for c in build_inputs(ann, b.id2idx) if c.name.startswith('ear')]
stim = np.concatenate([c.idx for c in ear]); seg = np.cumsum([0] + [len(c.idx) for c in ear])
out_idx, meta = build_outputs(ann, b.ids)
dsel = [i for i, m in enumerate(meta) if m['cls'] == 'descending']
dn = out_idx[dsel]; side = np.array([meta[i]['side'] for i in dsel]); types = [meta[i]['type'] for i in dsel]; fid = [meta[i]['id'] for i in dsel]
def record(slugs):
    a = math.exp(-FRAME_MS / 200); out = []
    for slug in slugs:
        mt = json.load(open(f'data/tracks/{slug}.json')); x, sr = load_wav(f'data/tracks/{slug}.wav')
        d, _ = ear_drive(x, sr); y = intent_targets(mt, len(d)); b.reset()
        r = np.zeros(len(dn)); R = np.zeros((len(d), len(dn)), np.float32); rates = np.zeros(len(stim))
        for f in range(len(d)):
            for k, c in enumerate(ear): rates[seg[k]:seg[k + 1]] = d[f, k] * c.max_hz
            b.set_stim(stim, rates); si, _ = b.run(FRAME_MS)
            r = a * r + (1 - a) * np.bincount(si, minlength=b.n)[dn] * 50; R[f] = r
        out.append((R, y))
    return out
train = ['proboscis-extension', 'giant-fiber-escape', 'moonwalker-dn', 'dhol-descending-neuron', 'tabla-theka-connectome', 'bhairav-in-the-mushroom-body']
held = sorted(p.stem for p in Path('data/tracks').glob('*.wav') if any(p.stem == h or p.stem.startswith(h + '-v') for h in HELD_OUT))
TR, HO = record(train), record(held)
np.save(SP + 'dn_train.npy', np.array(TR, dtype=object), allow_pickle=True); np.save(SP + 'dn_held.npy', np.array(HO, dtype=object), allow_pickle=True)
dt = FRAME_MS / 1000
def ema(v, tau):
    a = dt / tau; o = np.zeros(len(v)); f = v[0]
    for i, x in enumerate(v): f += (x - f) * a; o[i] = f
    return o
def hyst(s, on, off):
    st = False; o = np.zeros(len(s), bool)
    for i, v in enumerate(s):
        st = v > on if not st else v > off; o[i] = st
    return o
def f1(recs, pick, mu, sd, k, on, off):
    tp = fp = fn = 0; onsets = good = 0
    for R, y in recs:
        s = ema(((R[:, pick] - mu) / sd).mean(1), 4.0)[500:]; yy = y[500:, k]
        o = hyst(s, on, off)
        tp += (o & yy).sum(); fp += (o & ~yy).sum(); fn += (~o & yy).sum()
        starts = np.nonzero(o[1:] & ~o[:-1])[0] + 1; onsets += len(starts); good += yy[starts].sum()
    p, r = tp / max(1, tp + fp), tp / max(1, tp + fn)
    return 2 * p * r / max(1e-9, p + r), p, r, onsets, good
Rt = np.vstack([R for R, _ in TR]); Yt = np.vstack([y for _, y in TR]); active = Rt.mean(0) > 0.5
St = np.column_stack([np.convolve(Rt[:, j], np.ones(200) / 200, 'same') for j in range(Rt.shape[1])])
spec = {}
for k, name in enumerate(INTENTS):
    if name == 'BUILD': continue
    corr = np.array([np.corrcoef(St[:, j], Yt[:, k])[0, 1] if active[j] and St[:, j].std() > 0 else -9 for j in range(len(dn))])
    best = None
    for K in (1, 2, 3):
        pick = []
        for sd_ in ('left', 'right'):
            c = np.nonzero((side == sd_) & active)[0]; pick += list(c[np.argsort(-corr[c])][:K])
        mu, sd = Rt[:, pick].mean(0), Rt[:, pick].std(0) + 1e-6
        for on in np.arange(0.2, 2.01, 0.1):
            off = on - 0.4
            sc = f1(TR, pick, mu, sd, k, on, off)
            if best is None or sc[0] > best[0][0]: best = (sc, K, pick, mu, sd, on, off)
    sc, K, pick, mu, sd, on, off = best
    ho = f1(HO, pick, mu, sd, k, on, off)
    spec[name] = {'neurons': [{'id': fid[j], 'type': types[j], 'side': side[j], 'mu': float(mu[i]), 'sd': float(sd[i])} for i, j in enumerate(pick)],
                  'on': float(on), 'off': float(off), 'tau_s': 4.0,
                  'train': {'f1': sc[0], 'precision': sc[1], 'recall': sc[2]},
                  'held_out': {'f1': ho[0], 'precision': ho[1], 'recall': ho[2], 'onsets': int(ho[3]), 'onsets_in_section': int(ho[4])}}
    print(f"{name:5s} {K}/side {' '.join(types[j] + '(' + side[j][0] + ')' for j in pick)} on>{on:.1f} off<{off:.1f} | "
          f"train F1 {sc[0]:.2f} | HELD-OUT F1 {ho[0]:.2f} (P {ho[1]:.2f} R {ho[2]:.2f}), onsets {ho[4]}/{ho[3]} in the right section")
json.dump(spec, open('brains/readout.json', 'w'), indent=1)
