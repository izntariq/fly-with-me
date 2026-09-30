"""Which real neurons the music goes into, and which ones the music comes out of.

Inputs are sensory neurons identified in the FlyWire annotations (Schlegel et al. 2024).
Outputs are every descending neuron (brain -> body commands) and brain motor neuron.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
ANNOT = ROOT / "data" / "neuron_annotations.tsv"
XY_CACHE = ROOT / "data" / "brain_xy.bin"
XYZ_CACHE = ROOT / "data" / "brain_xyz.bin"
# super-classes, in the order the visualiser colours them (web/js/visualiser.js); class code = index + 1, 0 = unknown
SUPER_CLASSES = ["optic", "central", "sensory", "visual_projection", "ascending", "descending", "sensory_ascending",
                 "visual_centrifugal", "motor", "endocrine"]

# Johnston's organ (the fly's ear, in the antenna). JO-B neurons respond to
# low-frequency sound (courtship song), JO-A to higher-frequency vibration.
# Spreading subtypes across bands is an artistic tonotopy, not a measured one.
EAR_BANDS = [
    ("JO-B1_a", 40, 70), ("JO-B1_b", 70, 110), ("JO-B1_c", 110, 160),
    ("JO-B2", 160, 230), ("JO-B3", 230, 320), ("JO-B4_a", 320, 450),
    ("JO-B4_b", 450, 650), ("JO-A1", 650, 1200), ("JO-A2", 1200, 2200),
    ("JO-A3", 2200, 3500), ("JO-A4", 3500, 5500), ("JO-A5", 5500, 12000),
]


@dataclass
class InputChannel:
    name: str
    idx: np.ndarray
    max_hz: float
    desc: str
    meta: dict = field(default_factory=dict)


def load_annotations() -> pd.DataFrame:
    a = pd.read_csv(ANNOT, sep="\t", low_memory=False,
                    usecols=["root_id", "pos_x", "pos_y", "pos_z", "super_class", "cell_class",
                             "cell_sub_class", "cell_type", "side", "top_nt"])
    a["cell_type"] = a["cell_type"].fillna("")
    return a.set_index("root_id")


def build_inputs(ann: pd.DataFrame, id2idx: dict) -> list[InputChannel]:
    def idx(mask):
        return np.array([id2idx[i] for i in ann.index[mask] if i in id2idx], np.int64)

    ct = ann.cell_type
    chans: list[InputChannel] = []
    for ear, side in (("L", "left"), ("R", "right")):
        for typ, lo, hi in EAR_BANDS:
            chans.append(InputChannel(
                f"ear{ear}:{typ}", idx((ct == typ) & (ann.side == side)), 200.0,
                f"{side} Johnston's organ {typ} ({lo}-{hi} Hz)",
                {"ear": ear, "lo": lo, "hi": hi}))
    chans.append(InputChannel("wind", idx(ct.str.match(r"JO-(C|E)")), 120.0,
                              "Johnston's organ C/E wind & gravity neurons"))
    chans.append(InputChannel("sugar", idx((ann.cell_sub_class == "sugar/water") & (ct == "LB3")), 80.0,
                              "sugar-sensing gustatory neurons (reward)"))
    chans.append(InputChannel("bitter", idx(ann.cell_sub_class == "bitter"), 100.0,
                              "bitter-sensing gustatory neurons (aversive)"))
    return [c for c in chans if len(c.idx)]


def build_outputs(ann: pd.DataFrame, ids: np.ndarray) -> tuple[np.ndarray, list[dict]]:
    """Descending + motor neurons. Returns (brain indices, metadata list), sorted by type."""
    sub = ann[ann.super_class.isin(["descending", "motor"])]
    id2idx = {int(f): i for i, f in enumerate(ids)}
    rows = []
    for fid, r in sub.iterrows():
        if fid in id2idx:
            rows.append((r.super_class, r.cell_type, r.side if isinstance(r.side, str) else "", id2idx[fid], str(fid), r.top_nt))
    rows.sort(key=lambda r: (r[0], r[1], str(r[2]), r[3]))
    idx = np.array([r[3] for r in rows], np.int64)
    meta = [{"cls": r[0], "type": r[1], "side": r[2], "id": r[4], "nt": r[5] if isinstance(r[5], str) else ""}
            for r in rows]
    return idx, meta


def brain_xy(ann: pd.DataFrame, ids: np.ndarray) -> bytes:
    """Frontal-view soma/root positions as uint16 x,y per neuron (0,0 = unknown)."""
    if XY_CACHE.exists():
        return XY_CACHE.read_bytes()
    pos = ann.reindex(ids)[["pos_x", "pos_y"]].to_numpy(np.float64)
    ok = ~np.isnan(pos).any(1)
    lo = np.nanmin(pos[ok], 0)
    span = (np.nanmax(pos[ok], 0) - lo).max()      # one scale for both axes keeps the brain's shape
    q = np.zeros((len(ids), 2), np.uint16)
    q[ok] = 1 + ((pos[ok] - lo) / span * 65534).astype(np.uint16)
    XY_CACHE.write_bytes(q.tobytes())
    return q.tobytes()


def brain_xyz(ann: pd.DataFrame, ids: np.ndarray) -> bytes:
    """3D positions + super-class per neuron, as 4 x uint16: x, y, z on one common scale (so the brain keeps its
    shape; 0,0,0 = unknown) and the class code (SUPER_CLASSES index + 1). FlyWire positions are 4 x 4 x 40 nm voxels."""
    if XYZ_CACHE.exists():
        return XYZ_CACHE.read_bytes()
    a = ann.reindex(ids)
    pos = a[["pos_x", "pos_y", "pos_z"]].to_numpy(np.float64) * np.array([4.0, 4.0, 40.0])
    ok = ~np.isnan(pos).any(1)
    lo = pos[ok].min(0)
    span = (pos[ok].max(0) - lo).max()
    q = np.zeros((len(ids), 4), np.uint16)
    q[ok, :3] = 1 + ((pos[ok] - lo) / span * 65534).astype(np.uint16)
    q[:, 3] = a["super_class"].map({c: i + 1 for i, c in enumerate(SUPER_CLASSES)}).fillna(0).to_numpy(np.uint16)
    XYZ_CACHE.write_bytes(q.tobytes())
    return q.tobytes()
