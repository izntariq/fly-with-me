"""Same protocol on either connectome (FLYBRAIN_CONNECTOME=flywire|malecns): silence, sugar, music-like ear drive.
Reports spikes per second, active neurons, the busiest output types and the feeding motor neurons (MN9) for sugar.
    FLYBRAIN_CONNECTOME=malecns .venv/bin/python tools/cnscheck.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from flybrain.gpu import GPUBrains
from flybrain.mapping import load_annotations, build_inputs, build_outputs

g = GPUBrains(1)
ann = load_annotations(); ch = {c.name: c for c in build_inputs(ann, g.id2idx)}
out_idx, meta = build_outputs(ann, g.ids)
types = np.array([m['type'] for m in meta]); cls = np.array([m['cls'] for m in meta])
ears = [c for n, c in ch.items() if n.startswith('ear')]
def trial(name, idx, hz, ms=1000):
    g.reset(); g.set_stim(0, idx, np.full(len(idx), hz)); g.run(200)       # settle 0.2 s
    (s, t), = g.run(ms)
    cnt = np.bincount(s, minlength=g.n)[out_idx]
    top = sorted({ty: cnt[types == ty].sum() for ty in set(types[cnt > 0])}.items(), key=lambda x: -x[1])[:6]
    mn9 = cnt[types == 'MN9'].sum()
    print(f"{name:8s} {len(s) * 1000 / ms:9.0f} spikes/s  {len(np.unique(s)):6d} active  outputs {cnt.sum():6d}  "
          f"by class {dict((k, int(cnt[cls == k].sum())) for k in ('descending', 'motor', 'leg_wing_motor'))}  MN9 {mn9}  top {top}")
print(os.environ.get('FLYBRAIN_CONNECTOME', 'flywire'), g.n, 'neurons')
trial('silence', np.zeros(0, np.int64), 0)
trial('sugar', ch['sugar'].idx, 200)
trial('music', np.concatenate([c.idx for c in ears]), 90)
trial('loud', np.concatenate([c.idx for c in ears]), 200)
