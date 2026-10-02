"""The male CNS connectome as a drop-in for the FlyWire brain.

FlyEM / Janelia et al., male-cns v1.0 (2026, CC-BY 4.0): https://male-cns.janelia.org
The whole central nervous system of one male fly: central brain, optic lobes and ventral nerve cord, joined through
an intact neck. Its 165,122 traced neurons are connected by 25,563,197 connections (124M synapses). The ventral nerve
cord adds the leg, wing and haltere motor neurons, so the descending neurons drive real motor neurons instead of
ending at the neck.

Choose it with `python -m flybrain.server --connectome malecns` (or FLYBRAIN_CONNECTOME=malecns). It plugs into the
same Shiu et al. LIF model:
  - weight = sign x synapse count x SCALE, with sign -1 for GABA and glutamate (the neuron's consensus prediction),
    as in the FlyWire model
  - SCALE = 0.52. This dataset finds about 1.9x as many input synapses per neuron as FlyWire 783 (mean 751 vs 393;
    the extra comes from the nerve cord and finer synapse detection). Scaling keeps each neuron's total drive where
    the model's parameters were tuned
  - cell types share FlyWire's names (JO-A1 ... JO-B4_b, DNp01, MDN ...), so the ears, DJ moves and listener taps
    map unchanged. Taste neurons come from the dataset's own FlyWire matches (flywireType LB3 = sugar, LB1* = bitter)
  - neurons without a soma in the volume (most sensory afferents) are placed at the synapse-weighted mean soma
    position of their partners, and given the side of the midline that puts them on
  - positions are re-oriented like the classic whole-CNS picture, seen from above: pos_x lateral (the fly's left
    smaller, as in FlyWire), pos_y from the front of the brain down the nerve cord, pos_z dorsal-ventral (depth)
"""
from __future__ import annotations

import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "data" / "malecns"
BASE = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/"
F_ANN = "body-annotations-male-cns-v1.0-minconf-0.5.feather"
F_NT = "body-neurotransmitters-male-cns-v1.0.feather"
F_W = "connectome-weights-male-cns-v1.0-minconf-0.5.feather"
CACHE = ROOT / "data" / "connectome_csr_malecns.npz"
ANN_CACHE = ROOT / "data" / "malecns_annotations.parquet"
SCALE = 0.52
INHIBITORY = {"gaba", "glutamate"}

# dataset superclass -> the FlyWire-style super_class the rest of the code uses
SUPER = {
    "ol_intrinsic": "optic", "ol_sensory": "sensory", "cb_intrinsic": "central", "cb_sensory": "sensory",
    "vnc_intrinsic": "nerve_cord", "vnc_sensory": "sensory", "visual_projection": "visual_projection",
    "visual_centrifugal": "visual_centrifugal", "ascending_neuron": "ascending", "descending_neuron": "descending",
    "sensory_ascending": "sensory_ascending", "sensory_descending": "sensory", "cb_motor": "motor",
    "vnc_motor": "leg_wing_motor", "cb_endocrine": "endocrine", "vnc_endocrine": "endocrine", "ENS": "endocrine",
    "cb_efferent": "endocrine", "vnc_efferent": "endocrine", "efferent_ascending": "endocrine",
    "efferent_descending": "endocrine", "vnc_tbc": "nerve_cord", "vnc_sensory_tbc": "sensory",
    "cb_sensory_tbc": "sensory", "visual_projection_tbc": "visual_projection",
}
SUGAR = {"LB3"}
BITTER = {"LB1e", "LB1c", "LB1a,LB1d", "LB1b"}


def fetch():
    """Download the three tables we need (about 1.1 GB, once)."""
    DIR.mkdir(parents=True, exist_ok=True)
    for f in (F_ANN, F_NT, F_W):
        if not (DIR / f).exists():
            print(f"fetching the male CNS connectome: {f} ...")
            urllib.request.urlretrieve(BASE + f, DIR / f)


def _traced() -> pd.DataFrame:
    a = pd.read_feather(DIR / F_ANN)
    return a[a.status == "Traced"].reset_index(drop=True)


def _edges(ids: np.ndarray) -> pd.DataFrame:
    w = pd.read_feather(DIR / F_W)
    return w[w.body_pre.isin(ids) & w.body_post.isin(ids)]


def load_connectome():
    """(body ids, indptr, indices, weights) as CSR by presynaptic index, like brain.load_connectome."""
    if CACHE.exists():
        z = np.load(CACHE)
        return z["ids"], z["indptr"], z["indices"], z["weights"]
    fetch()
    a = _traced()
    ids = a.bodyId.to_numpy(np.int64)
    pos = pd.Series(np.arange(len(ids)), index=ids)
    e = _edges(ids)
    pre, post = pos[e.body_pre].to_numpy(np.int64), pos[e.body_post].to_numpy(np.int32)
    nt = pd.read_feather(DIR / F_NT, columns=["body", "consensus_nt"]).set_index("body").consensus_nt
    sign = np.where(nt.reindex(ids).astype(str).str.lower().isin(INHIBITORY).to_numpy(), -1.0, 1.0)
    w = (e.weight.to_numpy(np.float32) * SCALE * sign[pre]).astype(np.float32)
    order = np.argsort(pre, kind="stable")
    pre, post, w = pre[order], post[order], w[order]
    indptr = np.zeros(len(ids) + 1, np.int64)
    np.add.at(indptr, pre + 1, 1)
    indptr = np.cumsum(indptr)
    np.savez(CACHE, ids=ids, indptr=indptr, indices=post, weights=w)
    return ids, indptr, post, w


def load_annotations() -> pd.DataFrame:
    """The columns mapping.load_annotations gives for FlyWire, indexed by body id."""
    if ANN_CACHE.exists():
        return pd.read_parquet(ANN_CACHE)
    fetch()
    a = _traced()
    ids = a.bodyId.to_numpy(np.int64)
    xyz = np.full((len(ids), 3), np.nan)
    has = a.somaLocation.notna().to_numpy()
    xyz[has] = np.stack(a.somaLocation[has].to_numpy()).astype(np.float64)
    # no soma in the volume: place it at the synapse-weighted mean soma position of its partners
    pos = pd.Series(np.arange(len(ids)), index=ids)
    e = _edges(ids)
    i, j, w = pos[e.body_pre].to_numpy(), pos[e.body_post].to_numpy(), e.weight.to_numpy(np.float64)
    acc, tot = np.zeros((len(ids), 3)), np.zeros(len(ids))
    for me, other in ((i, j), (j, i)):
        k = ~has[me] & has[other]
        np.add.at(acc, me[k], xyz[other[k]] * w[k, None])
        np.add.at(tot, me[k], w[k])
    fill = ~has & (tot > 0)
    xyz[fill] = acc[fill] / tot[fill, None]
    nt = pd.read_feather(DIR / F_NT, columns=["body", "consensus_nt"]).set_index("body").consensus_nt
    ft = a.flywireType.astype(str)
    side = a.somaSide.fillna(a.rootSide).map({"L": "left", "R": "right", "M": "center"})
    # no annotated side (afferents without a soma): the side of the midline they sit on (the fly's left has larger x)
    mid = (np.nanmean(xyz[(side == "left").to_numpy(), 0]) + np.nanmean(xyz[(side == "right").to_numpy(), 0])) / 2
    guess = np.where(xyz[:, 0] > mid + 1500, "left", np.where(xyz[:, 0] < mid - 1500, "right", "center"))
    side = side.where(side.notna() | np.isnan(xyz[:, 0]), pd.Series(guess, index=side.index))
    out = pd.DataFrame({
        "pos_x": -xyz[:, 0], "pos_y": xyz[:, 2], "pos_z": xyz[:, 1],     # seen from above, brain at the top
        "super_class": a.superclass.map(SUPER).fillna("central").to_numpy(),
        "cell_class": a["class"].to_numpy(),
        "cell_sub_class": np.where(ft.isin(SUGAR), "sugar/water", np.where(ft.isin(BITTER), "bitter", a.subclass.astype(object))),
        # taste neurons carry their FlyWire type, which is how mapping.build_inputs finds the sugar ones
        "cell_type": np.where(ft.isin(SUGAR | BITTER), ft, a.type.fillna("").astype(str)),
        "side": side.to_numpy(),
        "top_nt": nt.reindex(ids).to_numpy(),
    }, index=pd.Index(ids, name="root_id"))
    out.to_parquet(ANN_CACHE)
    return out
