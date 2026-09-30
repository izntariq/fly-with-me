"""GPU simulator check: the paper's sugar experiment and a music-like drive on flybrain/gpu.py, against the CPU numbers,
then speed for 1 / 3 / 18 flies.   .venv/bin/python tools/gpucheck.py"""
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from flybrain.gpu import GPUBrains
from flybrain.mapping import load_annotations, build_inputs
sugar=[720575940624963786,720575940630233916,720575940637568838,720575940638202345,720575940617000768,720575940630797113,720575940632889389,720575940621754367,720575940621502051,720575940640649691,720575940639332736,720575940616885538,720575940639198653,720575940620900446,720575940617937543,720575940632425919,720575940633143833,720575940612670570,720575940628853239,720575940629176663,720575940611875570]
g1 = GPUBrains(1)
idx = np.array([g1.id2idx[i] for i in sugar if i in g1.id2idx])
ann = load_annotations(); ear = [c for c in build_inputs(ann, g1.id2idx) if c.name.startswith('ear')]
music_idx = np.concatenate([c.idx for c in ear]); music_rate = np.full(len(music_idx), 90.0)
# correctness: sugar experiment, a few seeds
for seed in (1, 2, 3):
    g1.seed = seed; g1.reset(); g1.set_stim(0, idx, np.full(len(idx), 200.0))
    (s, t), = g1.run(1000)
    print(f'GPU sugar seed {seed}: {len(s)} spikes, {len(np.unique(s))} active neurons   (CPU: 20,145 / 406)')
g1.reset(); g1.set_stim(0, music_idx, music_rate); (s, t), = g1.run(1000)
print(f'GPU music-like: {len(s)} spikes, {len(np.unique(s))} active   (CPU: ~34,600-34,900 / 520-560)')
# speed
for B in (1, 3, 18):
    gb = GPUBrains(B)
    for k in range(B): gb.set_stim(k, music_idx, music_rate)
    gb.run(20); gb.reset()
    for k in range(B): gb.set_stim(k, music_idx, music_rate)
    t0 = time.time(); res = gb.run(1000); w = time.time() - t0
    print(f'B={B:2d} flies: 1 s of brain for all of them in {w:.3f} s wall = {w / B:.3f} s per fly-second   (CPU: 0.23 event / 0.59 dense 1-thread)  spikes/fly ~{np.mean([len(r[0]) for r in res]):.0f}')
    watch = np.arange(0, g1.n, 7)
    t0 = time.time(); gb.run(1000, watch=watch); w2 = time.time() - t0
    print(f'        same with a watched subset (1/7 of neurons): {w2:.3f} s wall')
