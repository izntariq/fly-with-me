"""All-In-One analysis of one dropped file, for the server's background queue (flybrain/server.py Analyses).
    .venv-allin1/bin/python tools/label_one.py <audio file> <out dir>     -> <out dir>/<file stem>.json
"""
import os, sys
os.environ.setdefault("OMP_NUM_THREADS", "4")
import torch
torch.set_num_threads(4)
import allin1_infer as a
sys_path = __import__('sys').path; sys_path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from mlx_stems import MLXStems          # Demucs on the GPU through MLX (~8x the CPU)
STEMS = MLXStems()

path, out = sys.argv[1], sys.argv[2]
try:                                     # over 20 min: a whole DJ set / megamix, not a track (and it runs out of memory)
    import soundfile as sf
    dur = sf.info(path).duration
except Exception:
    import librosa
    dur = librosa.get_duration(path=path)
if dur > 20 * 60:
    sys.exit(f"skipped: {dur / 60:.0f} min long")
os.chdir(out)
a.analyze(path, out_dir=out, device="cpu", multiprocess=False, stem_provider=STEMS)
