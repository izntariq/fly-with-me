"""Python port of web/js/ears.js: audio -> firing drive (0..1) for each Johnston's-organ band.

Used offline (training, evaluation) so the brain hears exactly what it hears in the browser: an AnalyserNode-style
spectrum (2048-point FFT, Blackman window, magnitude / N, temporal smoothing 0.5, dB), band power averaged over the
band's bins, a slowly decaying peak (1.5 dB/s) defining a 36 dB window, plus an onset bonus.
"""
from __future__ import annotations

import wave

import numpy as np

from .mapping import EAR_BANDS

N_FFT = 2048


def load_wav(path) -> tuple[np.ndarray, int]:
    """(samples[channels, n] float32 in -1..1, sample_rate)"""
    with wave.open(str(path), "rb") as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        x = np.frombuffer(w.readframes(n), np.int16).astype(np.float32) / 32768
    return x.reshape(-1, ch).T, sr


def ear_drive(x: np.ndarray, sr: int, hop_s: float = 0.02) -> tuple[np.ndarray, list[str]]:
    """Drive levels per frame for both ears. x: [2, n]. Returns (levels[frames, 24], channel names)."""
    hop = int(round(hop_s * sr))
    frames = (x.shape[1] - N_FFT) // hop
    win = np.blackman(N_FFT).astype(np.float32)
    bin_hz = sr / N_FFT
    names, bands = [], []
    for ear in ("L", "R"):
        for typ, lo, hi in EAR_BANDS:
            i0 = max(1, int(np.floor(lo / bin_hz)))
            i1 = max(i0 + 1, int(np.ceil(hi / bin_hz)))
            names.append(f"ear{ear}:{typ}")
            bands.append((0 if ear == "L" else 1, i0, min(i1, N_FFT // 2)))
    out = np.zeros((frames, len(bands)), np.float32)
    smooth = [np.zeros(N_FFT // 2 + 1, np.float32), np.zeros(N_FFT // 2 + 1, np.float32)]
    peak = np.full(len(bands), -50.0)
    avg = np.full(len(bands), -80.0)
    dt = hop_s
    for f in range(frames):
        o = f * hop
        db_spec = []
        for c in (0, 1):
            mag = np.abs(np.fft.rfft(x[c, o:o + N_FFT] * win)) / N_FFT
            smooth[c] = 0.5 * smooth[c] + 0.5 * mag
            db_spec.append(20 * np.log10(smooth[c] + 1e-12))
        for b, (c, i0, i1) in enumerate(bands):
            p = np.mean(10 ** (db_spec[c][i0:i1] / 10))
            db = 10 * np.log10(p + 1e-12)
            peak[b] = max(db, peak[b] - dt * 1.5)
            onset = max(0.0, db - avg[b]) / 12
            avg[b] += (db - avg[b]) * min(1.0, dt / 0.25)
            lvl = min(1.0, max(0.0, (db - (peak[b] - 36)) / 36)) ** 1.5 * 0.7 + min(0.5, onset * 0.5)
            out[f, b] = 0.0 if db < -95 else min(1.0, lvl)
    return out, names
