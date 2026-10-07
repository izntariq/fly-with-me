"""Real-time whole-brain Drosophila LIF simulator.

Same model as Shiu et al. 2024 (Nature, "A Drosophila computational brain model
reveals sensorimotor processing"), https://github.com/philshiu/Drosophila_brain_model,
running on the FlyWire v783 connectome (138,639 neurons, ~15M connections).

The Brian2 reference implementation takes minutes per simulated second. This is a
Numba re-implementation with exact exponential integration so it can run faster
than real time on a laptop:

    dv/dt = (v_0 - v + g) / t_mbr     (unless refractory)
    dg/dt = -g / tau                  (unless refractory)
    spike: v > v_th  ->  v = v_rst, g = 0, refractory for t_rfc
    presynaptic spike -> g_post += w  after t_dly
    w = (sign x synapse count) * w_syn

External drive works like the paper's Poisson "optogenetic" activation: each
stimulated neuron receives Poisson kicks of w_syn * f_poi (enough to fire it),
except here every neuron has its own rate that can change every tick. As with
Brian's PoissonInput, a kick still adds to v while the neuron is refractory but
can't fire it then; a kick that fires it starts a refractory period like any spike.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import json
import os

from numba import njit, prange, set_num_threads

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "vendor" / "Drosophila_brain_model"
PATH_COMP = MODEL_DIR / "Completeness_783.csv"
PATH_CON = MODEL_DIR / "Connectivity_783.parquet"
CACHE = ROOT / "data" / "connectome_csr_783.npz"


@dataclass
class Params:
    dt: float = 0.25        # ms, integration step
    v_0: float = -52.0      # mV resting potential
    v_rst: float = -52.0    # mV reset
    v_th: float = -45.0     # mV threshold
    t_mbr: float = 20.0     # ms membrane time constant
    tau: float = 5.0        # ms synaptic time constant
    t_rfc: float = 2.2      # ms refractory period
    t_dly: float = 1.8      # ms synaptic delay
    w_syn: float = 0.275    # mV per synapse
    f_poi: float = 250.0    # Poisson kick = w_syn * f_poi


# which connectome: "flywire" (FlyWire v783 brain, the Shiu et al. model; default) or "malecns" (the whole male CNS,
# brain + nerve cord: flybrain/malecns.py). Set by the server's --connectome.
def connectome_name() -> str:
    return os.environ.get("FLYBRAIN_CONNECTOME", "flywire")


def load_connectome():
    """Return (neuron ids, indptr, indices, signed weights in synapses) as CSR by presynaptic index."""
    if connectome_name() == "malecns":
        from .malecns import load_connectome as load_malecns
        return load_malecns()
    if CACHE.exists():
        z = np.load(CACHE)
        return z["ids"], z["indptr"], z["indices"], z["weights"]
    comp = pd.read_csv(PATH_COMP, index_col=0)
    con = pd.read_parquet(
        PATH_CON, columns=["Presynaptic_Index", "Postsynaptic_Index", "Excitatory x Connectivity"]
    )
    n = len(comp)
    pre = con["Presynaptic_Index"].to_numpy(np.int64)
    order = np.argsort(pre, kind="stable")
    pre = pre[order]
    indices = con["Postsynaptic_Index"].to_numpy(np.int32)[order]
    weights = con["Excitatory x Connectivity"].to_numpy(np.float32)[order]
    indptr = np.zeros(n + 1, np.int64)
    np.add.at(indptr, pre + 1, 1)
    indptr = np.cumsum(indptr)
    ids = comp.index.to_numpy(np.int64)
    CACHE.parent.mkdir(exist_ok=True)
    # written whole, then renamed: an interrupted write can't leave a truncated cache that is loaded ever after
    # (through a file object, so np.savez doesn't append .npz to the name)
    tmp = CACHE.with_name(CACHE.name + ".part")
    with open(tmp, "wb") as f:
        np.savez(f, ids=ids, indptr=indptr, indices=indices, weights=weights)
    os.replace(tmp, CACHE)
    return ids, indptr, indices, weights


N_BLOCKS = 64


@njit(cache=True, fastmath=True, nogil=True, parallel=True)
def _run(n_steps, step0, v, g, ref, ring, indptr, indices, weights, rates_p,
         stim_idx, v_0, v_th, v_rst, dv_decay, g_decay, k_gv, n_ref, n_dly,
         kick, spk_idx, spk_step):
    """Advance the network n_steps. Returns number of spikes written to spk_idx/spk_step.

    Integration is parallel over neuron blocks; spike propagation is serial (it
    scatters into shared postsynaptic buffers).
    """
    n = v.shape[0]
    D = ring.shape[0]
    n_spk = 0
    cap = spk_idx.shape[0]
    bsize = (n + N_BLOCKS - 1) // N_BLOCKS
    local = np.empty((N_BLOCKS, bsize), np.int32)
    cnt = np.zeros(N_BLOCKS, np.int64)
    for t in range(n_steps):
        step = step0 + t
        buf = ring[step % D]
        out = ring[(step + n_dly) % D]
        # 1. deliver delayed synaptic input, integrate, threshold (parallel)
        for b in prange(N_BLOCKS):
            c = 0
            for i in range(b * bsize, min(n, (b + 1) * bsize)):
                gi = g[i] + buf[i]
                buf[i] = 0.0
                if ref[i] > 0:
                    ref[i] -= 1
                    g[i] = gi
                    continue
                vi = v[i]
                if vi == v_0 and gi == 0.0:
                    continue
                u = vi - v_0
                vi = v_0 + u * dv_decay + gi * k_gv
                gi = gi * g_decay
                if abs(gi) < 1e-6:
                    gi = 0.0
                if vi > v_th:
                    vi = v_rst
                    gi = 0.0
                    ref[i] = n_ref
                    local[b, c] = i
                    c += 1
                elif abs(u) < 1e-5 and gi == 0.0:
                    vi = v_0
                v[i] = vi
                g[i] = gi
            cnt[b] = c
        # 2. record spikes and schedule postsynaptic input (serial)
        for b in range(N_BLOCKS):
            for k in range(cnt[b]):
                i = local[b, k]
                if n_spk < cap:
                    spk_idx[n_spk] = i
                    spk_step[n_spk] = step
                    n_spk += 1
                for s in range(indptr[i], indptr[i + 1]):
                    out[indices[s]] += weights[s]
        # 3. Poisson drive; kicks land on v immediately, like Brian's PoissonInput. A refractory neuron (including one
        # that just spiked this step) takes the kick but isn't checked against threshold, so it can't spike twice in
        # a step; a kick-caused spike starts a refractory period too
        for j in range(stim_idx.shape[0]):
            p = rates_p[j]
            if p <= 0.0:
                continue
            if np.random.random() < p:
                i = stim_idx[j]
                v[i] += kick
                if ref[i] == 0 and v[i] > v_th:
                    v[i] = v_rst
                    g[i] = 0.0
                    ref[i] = n_ref
                    if n_spk < cap:
                        spk_idx[n_spk] = i
                        spk_step[n_spk] = step
                        n_spk += 1
                    for s in range(indptr[i], indptr[i + 1]):
                        out[indices[s]] += weights[s]
    return n_spk


@njit(cache=True, fastmath=True, nogil=True)
def _run_active(n_steps, step0, v, g, ref, ring, indptr, indices, weights, rates_p,
                stim_idx, v_0, v_th, v_rst, dv_decay, g_decay, k_gv, n_ref, n_dly,
                kick, spk_idx, spk_step, act, flag, n_act):
    """Event-driven version of _run: only neurons on the active list (received input, not yet back at rest) are
    updated. Same equations; typically a few percent of the brain is active, so this is several times faster.
    act[:n_act] = active neurons, flag[i] = 1 if i is on the list. Returns (n_spikes, n_act)."""
    D = ring.shape[0]
    n_spk = 0
    cap = spk_idx.shape[0]
    for t in range(n_steps):
        step = step0 + t
        buf = ring[step % D]
        out = ring[(step + n_dly) % D]
        k = 0
        n_now = n_act
        while k < n_now:
            i = act[k]
            gi = g[i] + buf[i]
            buf[i] = 0.0
            if ref[i] > 0:
                ref[i] -= 1
                g[i] = gi
                k += 1
                continue
            vi = v[i]
            u = vi - v_0
            vi = v_0 + u * dv_decay + gi * k_gv
            gi = gi * g_decay
            if abs(gi) < 1e-6:
                gi = 0.0
            if vi > v_th:
                vi = v_rst
                gi = 0.0
                ref[i] = n_ref
                if n_spk < cap:
                    spk_idx[n_spk] = i
                    spk_step[n_spk] = step
                    n_spk += 1
                for s_ in range(indptr[i], indptr[i + 1]):
                    j = indices[s_]
                    out[j] += weights[s_]
                    if flag[j] == 0:
                        flag[j] = 1
                        act[n_act] = j
                        n_act += 1
            elif abs(u) < 1e-5 and gi == 0.0:
                vi = v_0
            v[i] = vi
            g[i] = gi
            # back at rest with nothing pending: leave the active list (swap-remove)
            if vi == v_0 and gi == 0.0 and ref[i] == 0:
                pending = False
                for d in range(D):
                    if ring[d][i] != 0.0:
                        pending = True
                        break
                if not pending:
                    flag[i] = 0
                    n_act -= 1
                    act[k] = act[n_act]
                    if n_act < n_now:
                        n_now -= 1
                        continue
                    continue
            k += 1
        for jj in range(stim_idx.shape[0]):           # Poisson drive, as in _run (refractory: no threshold)
            p = rates_p[jj]
            if p <= 0.0:
                continue
            if np.random.random() < p:
                i = stim_idx[jj]
                v[i] += kick
                if flag[i] == 0:
                    flag[i] = 1
                    act[n_act] = i
                    n_act += 1
                if ref[i] == 0 and v[i] > v_th:
                    v[i] = v_rst
                    g[i] = 0.0
                    ref[i] = n_ref
                    if n_spk < cap:
                        spk_idx[n_spk] = i
                        spk_step[n_spk] = step
                        n_spk += 1
                    for s_ in range(indptr[i], indptr[i + 1]):
                        j = indices[s_]
                        out[j] += weights[s_]
                        if flag[j] == 0:
                            flag[j] = 1
                            act[n_act] = j
                            n_act += 1
    return n_spk, n_act


@njit(cache=True)
def _seed(seed):
    np.random.seed(seed)


class Brain:
    def __init__(self, params: Params | None = None, seed: int = 1):
        self.p = p = params or Params()
        self.ids, self.indptr, self.indices, w = load_connectome()
        self.n = len(self.ids)
        # a few threads is plenty and stays real-time when the browser is busy too;
        # every step has a thread barrier, so one descheduled thread stalls all of them
        set_num_threads(int(os.environ.get("FLYBRAIN_THREADS", min(4, os.cpu_count() or 1))))
        self.weights = (w * p.w_syn).astype(np.float32)
        self.id2idx = {int(f): i for i, f in enumerate(self.ids)}

        self.dv_decay = math.exp(-p.dt / p.t_mbr)
        self.g_decay = math.exp(-p.dt / p.tau)
        # exact solution of the coupled linear ODE over one step
        self.k_gv = p.tau / (p.tau - p.t_mbr) * (self.g_decay - self.dv_decay)
        self.n_ref = max(1, round(p.t_rfc / p.dt))
        self.n_dly = max(1, round(p.t_dly / p.dt))
        self.kick = p.w_syn * p.f_poi

        self.v = np.full(self.n, p.v_0, np.float32)
        self.g = np.zeros(self.n, np.float32)
        self.ref = np.zeros(self.n, np.int32)
        self.ring = np.zeros((self.n_dly + 1, self.n), np.float32)
        self.step = 0
        _seed(seed)

        # Poisson-driven neurons: all neurons that any input channel may touch
        self.stim_idx = np.zeros(0, np.int64)
        self.stim_rate_hz = np.zeros(0, np.float64)

        self._spk_idx = np.zeros(2_000_000, np.int64)
        self._spk_step = np.zeros(2_000_000, np.int64)
        # event-driven kernel state (FLYBRAIN_KERNEL=dense falls back to visiting every neuron each step)
        self.event = os.environ.get("FLYBRAIN_KERNEL", "event") == "event"
        self._act = np.zeros(self.n, np.int32)
        self._flag = np.zeros(self.n, np.uint8)
        self._n_act = 0

    @property
    def t_ms(self) -> float:
        return self.step * self.p.dt

    def set_stim(self, idx: np.ndarray, rates_hz: np.ndarray):
        """Set Poisson drive (Hz) for neuron indices. Replaces previous drive."""
        self.stim_idx = np.ascontiguousarray(idx, np.int64)
        self.stim_rate_hz = np.ascontiguousarray(rates_hz, np.float64)

    def run(self, ms: float):
        """Simulate `ms` milliseconds. Returns (neuron_idx, time_ms) arrays of spikes."""
        n_steps = int(round(ms / self.p.dt))
        p_spk = np.clip(self.stim_rate_hz * self.p.dt * 1e-3, 0.0, 1.0)
        if self.event:
            k, self._n_act = _run_active(n_steps, self.step, self.v, self.g, self.ref, self.ring, self.indptr,
                                         self.indices, self.weights, p_spk, self.stim_idx, self.p.v_0, self.p.v_th,
                                         self.p.v_rst, self.dv_decay, self.g_decay, self.k_gv, self.n_ref,
                                         self.n_dly, self.kick, self._spk_idx, self._spk_step,
                                         self._act, self._flag, self._n_act)
        else:
            k = _run(n_steps, self.step, self.v, self.g, self.ref, self.ring, self.indptr,
                     self.indices, self.weights, p_spk, self.stim_idx, self.p.v_0, self.p.v_th,
                     self.p.v_rst, self.dv_decay, self.g_decay, self.k_gv, self.n_ref,
                     self.n_dly, self.kick, self._spk_idx, self._spk_step)
        self.step += n_steps
        return self._spk_idx[:k].copy(), self._spk_step[:k] * self.p.dt

    def sibling(self) -> "Brain":
        """Another fly with the same wiring (arrays shared, read-only) but its own membrane state and input."""
        o = object.__new__(Brain)
        o.__dict__.update({k: v for k, v in self.__dict__.items()
                           if k not in ("v", "g", "ref", "ring", "step", "stim_idx", "stim_rate_hz", "_spk_idx",
                                        "_spk_step", "_act", "_flag", "_n_act")})
        o.v = np.full(self.n, self.p.v_0, np.float32); o.g = np.zeros(self.n, np.float32)
        o.ref = np.zeros(self.n, np.int32); o.ring = np.zeros_like(self.ring); o.step = self.step
        o.stim_idx = np.zeros(0, np.int64); o.stim_rate_hz = np.zeros(0, np.float64)
        o._spk_idx = np.zeros_like(self._spk_idx); o._spk_step = np.zeros_like(self._spk_step)
        o._act = np.zeros(self.n, np.int32); o._flag = np.zeros(self.n, np.uint8); o._n_act = 0
        return o

    def load_trained(self, path) -> dict:
        """Apply learned synaptic weights (from flybrain.train) on top of the connectome. Returns the file's metadata."""
        z = np.load(path)
        self.weights[z["K"]] = z["weights"]
        self.trained = {"file": str(path), "synapses": int(len(z["K"])), "epoch": int(z["epoch"]),
                        "intents": json.loads(str(z["intents"]))}
        return self.trained

    def reset(self):
        self.v[:] = self.p.v_0
        self.g[:] = 0
        self.ref[:] = 0
        self.ring[:] = 0
        self._flag[:] = 0
        self._n_act = 0
