"""Label tracks with All-In-One in the order of data/realtracks/label_queue.txt, gently: one track at a time,
Demucs on the GPU (MLX), the structure model on 4 CPU threads at low priority. Skips tracks already labelled.
    nice -n 12 .venv-allin1/bin/python tools/label_queue.py
"""
import os
os.environ.setdefault("OMP_NUM_THREADS", "4")
import time
from pathlib import Path
import torch
torch.set_num_threads(4)
import allin1_infer as a
sys_path = __import__('sys').path; sys_path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from mlx_stems import MLXStems          # Demucs on the GPU through MLX (~8x the CPU)
STEMS = MLXStems()

D = Path(__file__).resolve().parents[1] / "data" / "realtracks"
os.chdir(D)                                      # demix/ and spec/ byproducts stay inside data/
for slug in (D / "label_queue.txt").read_text().split():
    out = D / "allin1" / f"{slug}.json"
    wav = D / "wav" / f"{slug}.wav"
    if out.exists() or not wav.exists():
        continue
    if wav.stat().st_size > 20 * 60 * 176400:        # over 20 min: a whole DJ set / megamix, not a track (and it runs out of memory)
        print("skipped (over 20 min)", slug, flush=True); continue
    t = time.time()
    try:
        a.analyze(str(D / "wav" / f"{slug}.wav"), out_dir=str(D / "allin1"), device="cpu", multiprocess=False, stem_provider=STEMS)
    except Exception as e:
        print("failed", slug, e, flush=True); continue
    print(f"{slug} {time.time() - t:.0f} s", flush=True)
