"""Human-style section labels for the real tracks: the All-In-One music structure analyzer (Kim & Nam 2023, trained on
the human-annotated Harmonix Set; the NATTEN-free fork all-in-one-infer), run in its own environment:
    caffeinate -i .venv-allin1/bin/python tools/label_allin1.py      -> data/realtracks/allin1/<slug>.json
(segments with start / end / label: intro, verse, chorus, bridge, inst, solo, break, outro, plus beats and downbeats)
"""
import json, sys, time
from pathlib import Path
import allin1_infer as a

D = Path(__file__).resolve().parents[1] / "data" / "realtracks"
todo = [p for p in sorted((D / "wav").glob("*.wav")) if not (D / "allin1" / f"{p.stem}.json").exists()]
print(len(todo), "tracks to label", flush=True)
for i in range(0, len(todo), 4):
    t = time.time()
    a.analyze([str(p) for p in todo[i:i + 4]], out_dir=str(D / "allin1"), device="cpu")
    print(f"{i + 4}/{len(todo)} ({time.time() - t:.0f} s)", flush=True)
