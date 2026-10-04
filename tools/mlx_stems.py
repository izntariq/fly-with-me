"""Demucs on MLX (the demucs-mlx port, Apple-silicon GPU) as All-In-One's stem separator.

The PyTorch Demucs runs ~8x faster on the GPU through MLX than on the CPU (1.1 s vs 8.8 s per 30 s of audio on an M3 Pro;
PyTorch's own GPU backend: 1.7 s). Plug it in with:
    import allin1_infer as a; from mlx_stems import MLXStems
    a.analyze(path, ..., stem_provider=MLXStems())
"""
from pathlib import Path

import numpy as np
import soundfile as sf
from allin1_infer.stems import StemProvider


class MLXStems(StemProvider):
    def __init__(self, model: str = "htdemucs"):
        import demucs_mlx
        self.sep = demucs_mlx.Separator(model=model)
        self.model_name = model

    def get_stems(self, identifier, output_dir, progress_callback=None):
        audio_path = Path(identifier)
        out = Path(output_dir) / self.model_name / audio_path.stem
        names = ["bass", "drums", "other", "vocals"]
        if all((out / f"{n}.wav").exists() for n in names):
            return out
        out.mkdir(parents=True, exist_ok=True)
        _, stems = self.sep.separate_audio_file(str(audio_path))
        for n in names:
            sf.write(out / f"{n}.wav", np.asarray(stems[n], dtype=np.float32).T, self.sep.samplerate, subtype="FLOAT")
        return out
