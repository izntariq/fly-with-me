"""The fly brain on the GPU (Apple silicon, MLX custom Metal kernels): many flies simulated together.

Same model and numerics as flybrain/brain.py (Shiu et al. 2024 LIF, exact exponential integration, dt 0.25 ms,
1.8 ms synaptic delay, 2.2 ms refractory, Poisson drive), but batched: B flies share the wiring and step together.

The trick that makes it GPU-friendly is the synaptic delay. A spike reaches its targets 7 steps (1.75 ms) later,
so within a window of W = 5 steps no neuron can affect any other. Each window is two kernel launches:
  1. integrate: one GPU thread per (fly, neuron) advances it 5 steps (input delivery, integration, threshold,
     refractory, Poisson kicks) and records which of the 5 steps it spiked in (a 5-bit mask)
  2. propagate: one thread per spiking neuron adds its outgoing synaptic weights (atomic float adds) into the
     arrival slots, which are 2..6 steps into the NEXT window
so a second of brain time is 800 windows = 1,600 launches for all flies together, instead of 4,000 sequential
steps per fly on the CPU. At the end of each run() a third kernel (collect) compacts every spike of every fly into a
short list on the GPU, so only the spikes themselves come back to the CPU.
"""
from __future__ import annotations

import math

import mlx.core as mx
import numpy as np

from .brain import Params, load_connectome

W = 5                                   # steps per window (must be < the synaptic delay in steps, 7)

_HEADER = """
inline float rnd(uint seed, uint step, uint gid) {
    // stateless hash -> uniform [0,1): a fresh random number per (fly, neuron, step)
    uint x = seed ^ (step * 0x9E3779B1u) ^ (gid * 0x85EBCA6Bu);
    x ^= x >> 16; x *= 0x7FEB352Du; x ^= x >> 15; x *= 0x846CA68Bu; x ^= x >> 16;
    return float(x >> 8) * (1.0f / 16777216.0f);
}
"""


def _integrate_src(p: Params, dv_decay, g_decay, k_gv, n_ref, kick):
    return f"""
    uint gid = thread_position_in_grid.x;
    uint BN = meta[2];
    if (gid >= BN) return;
    uint step0 = meta[0], seed = meta[1];
    float vi = v[gid], gi = g[gid];
    int ri = ref[gid];
    float pk = pstim[gid];
    uint mask = 0;
    for (uint s = 0; s < {W}; s++) {{
        // synaptic input arriving this step: offsets 0,1 were scheduled by the window before last, 2..4 by the last
        float inp = (s < 2) ? pprev[(3 + s) * BN + gid] : pcur[(s - 2) * BN + gid];
        gi += inp;
        if (ri > 0) {{
            ri -= 1;
        }} else {{
            float u = vi - {p.v_0}f;
            vi = {p.v_0}f + u * {dv_decay}f + gi * {k_gv}f;
            gi = gi * {g_decay}f;
            if (fabs(gi) < 1e-6f) gi = 0.0f;
            if (vi > {p.v_th}f) {{
                vi = {p.v_rst}f; gi = 0.0f; ri = {n_ref}; mask |= (1u << s);
            }} else if (fabs(u) < 1e-5f && gi == 0.0f) {{
                vi = {p.v_0}f;
            }}
        }}
        if (pk > 0.0f && rnd(seed, step0 + s, gid) < pk) {{      // Poisson kick, lands on v immediately
            vi += {kick}f;
            if (vi > {p.v_th}f) {{ vi = {p.v_rst}f; gi = 0.0f; mask |= (1u << s); }}
        }}
    }}
    v_out[gid] = vi; g_out[gid] = gi; ref_out[gid] = ri; spk[gid] = (uint8_t)mask;
    """


_PROPAGATE_SRC = """
    uint gid = thread_position_in_grid.x;
    uint BN = meta[2], N = meta[3];
    if (gid >= BN) return;
    uint m = spk[gid];
    if (m == 0) return;
    uint b = gid / N, i = gid - b * N;
    int k0 = indptr[i], k1 = indptr[i + 1];
    for (uint s = 0; s < 5; s++) {
        if (((m >> s) & 1u) == 0) continue;
        // a spike at window step s arrives s + 7 steps later = step s + 2 of the next window -> arrival slot s
        uint base = s * BN + b * N;
        for (int k = k0; k < k1; k++) {
            atomic_fetch_add_explicit(&P[base + indices[k]], weights[k], memory_order_relaxed);
        }
    }
"""


_COLLECT_SRC = """
    uint gid = thread_position_in_grid.x;
    uint total = meta[0], BN = meta[1], N = meta[2], cap = meta[3];
    if (gid >= total) return;
    uint m = masks[gid];
    if (m == 0) return;
    uint w = gid / BN, i = gid - w * BN;                 // window, (fly, neuron)
    atomic_fetch_add_explicit(&counts[i / N], popcount(m), memory_order_relaxed);
    uint k = atomic_fetch_add_explicit(&out[0], 1u, memory_order_relaxed);
    if (k < cap) {
        atomic_store_explicit(&out[1 + 2 * k], i, memory_order_relaxed);
        atomic_store_explicit(&out[2 + 2 * k], (w << 8) | m, memory_order_relaxed);
    }
"""

CAP = 1 << 18                           # spiking (window, neuron) entries collected per run() call


class GPUBrains:
    """B flies on the GPU. API close to Brain: set_stim(k, idx, rates_hz), run(ms) -> per-fly spike lists."""

    def __init__(self, n_flies: int = 1, params: Params | None = None, seed: int = 1, weights: np.ndarray | None = None):
        self.p = p = params or Params()
        ids, indptr, indices, w = load_connectome()
        self.ids, self.n, self.B = ids, len(ids), n_flies
        self.id2idx = {int(f): i for i, f in enumerate(ids)}
        n_dly = max(1, round(p.t_dly / p.dt))
        assert n_dly == 7 and W == 5, "window layout assumes a 7-step synaptic delay and 5-step windows"
        self.n_ref = max(1, round(p.t_rfc / p.dt))
        self.dv_decay = math.exp(-p.dt / p.t_mbr)
        self.g_decay = math.exp(-p.dt / p.tau)
        self.k_gv = p.tau / (p.tau - p.t_mbr) * (self.g_decay - self.dv_decay)
        self.kick = p.w_syn * p.f_poi
        self.indptr = mx.array(indptr.astype(np.int32))
        self.indices = mx.array(indices.astype(np.int32))
        self.w_np = (w * p.w_syn).astype(np.float32) if weights is None else weights.astype(np.float32)
        self.weights = mx.array(self.w_np)
        self.BN = self.B * self.n
        self._integrate = mx.fast.metal_kernel(
            name="fly_integrate", input_names=["v", "g", "ref", "pstim", "pprev", "pcur", "meta"],
            output_names=["v_out", "g_out", "ref_out", "spk"], header=_HEADER,
            source=_integrate_src(p, self.dv_decay, self.g_decay, self.k_gv, self.n_ref, self.kick))
        self._propagate = mx.fast.metal_kernel(
            name="fly_propagate", input_names=["spk", "indptr", "indices", "weights", "meta"],
            output_names=["P"], source=_PROPAGATE_SRC, atomic_outputs=True)
        self._collect = mx.fast.metal_kernel(
            name="fly_collect", input_names=["masks", "meta"], output_names=["out", "counts"],
            source=_COLLECT_SRC, atomic_outputs=True)
        self.seed = seed
        self.stim = [(np.zeros(0, np.int64), np.zeros(0))] * self.B
        self.reset()

    # ---- state ----
    def reset(self, k: int | None = None):
        """Reset every fly (k=None) or one fly back to rest."""
        if k is None or not hasattr(self, "v"):
            self.v = mx.full((self.BN,), self.p.v_0, dtype=mx.float32)
            self.g = mx.zeros((self.BN,), dtype=mx.float32)
            self.ref = mx.zeros((self.BN,), dtype=mx.int32)
            self.pprev = mx.zeros((W * self.BN,), dtype=mx.float32)
            self.pcur = mx.zeros((W * self.BN,), dtype=mx.float32)
            self.step = 0
            return
        sl = slice(k * self.n, (k + 1) * self.n)
        v = np.array(self.v); v[sl] = self.p.v_0; self.v = mx.array(v)
        for name in ("g", "ref"):
            a = np.array(getattr(self, name)); a[sl] = 0; setattr(self, name, mx.array(a))
        for name in ("pprev", "pcur"):
            a = np.array(getattr(self, name)).reshape(W, self.BN); a[:, sl] = 0; setattr(self, name, mx.array(a.reshape(-1)))

    def set_weights(self, K: np.ndarray, values: np.ndarray):
        """Install learned synaptic weights (flybrain.train) for every fly."""
        self.w_np[K] = values
        self.weights = mx.array(self.w_np)

    def set_stim(self, k: int, idx: np.ndarray, rates_hz: np.ndarray):
        self.stim[k] = (np.asarray(idx, np.int64), np.asarray(rates_hz, np.float64))

    def _pstim(self):
        ps = np.zeros(self.BN, np.float32)
        for k, (idx, r) in enumerate(self.stim):
            if len(idx):
                ps[k * self.n + idx] = np.clip(r * self.p.dt * 1e-3, 0, 1)
        return mx.array(ps)

    # ---- simulation ----
    def run(self, ms: float, watch: np.ndarray | None = None):
        """Simulate `ms` (a multiple of 1.25 ms). Returns, per fly, (neuron_idx, time_ms) of its spikes, in time order.
        watch: optional neuron indices to keep (default: every neuron)."""
        n_win = int(round(ms / (W * self.p.dt)))
        pstim = self._pstim()
        masks = []
        grid = (self.BN, 1, 1)
        for wi in range(n_win):
            meta = mx.array(np.array([self.step, self.seed, self.BN, self.n], np.uint32))
            v, g, ref, spk = self._integrate(
                inputs=[self.v, self.g, self.ref, pstim, self.pprev, self.pcur, meta],
                grid=grid, threadgroup=(256, 1, 1),
                output_shapes=[(self.BN,), (self.BN,), (self.BN,), (self.BN,)],
                output_dtypes=[mx.float32, mx.float32, mx.int32, mx.uint8])
            (P,) = self._propagate(
                inputs=[spk, self.indptr, self.indices, self.weights, meta],
                grid=grid, threadgroup=(256, 1, 1),
                output_shapes=[(W * self.BN,)], output_dtypes=[mx.float32], init_value=0.0)
            self.v, self.g, self.ref = v, g, ref
            self.pprev, self.pcur = self.pcur, P
            masks.append(spk)
            self.step += W
        # compact every spike of every fly into a list: (fly*N + neuron, window << 8 | 5-bit step mask)
        total = n_win * self.BN
        out, counts = self._collect(
            inputs=[mx.concatenate(masks), mx.array(np.array([total, self.BN, self.n, CAP], np.uint32))],
            grid=(total, 1, 1), threadgroup=(256, 1, 1),
            output_shapes=[(1 + 2 * CAP,), (self.B,)], output_dtypes=[mx.uint32, mx.uint32], init_value=0)
        mx.eval(out, counts, self.v, self.pcur)
        self.last_counts = np.array(counts).astype(np.int64)      # spikes per fly this call (all neurons)
        o = np.asarray(out)
        k = min(int(o[0]), CAP)
        e = o[1:1 + 2 * k].reshape(-1, 2).astype(np.int64)
        fly, neuron = np.divmod(e[:, 0], self.n)
        w, m = e[:, 1] >> 8, e[:, 1] & 0xFF
        rows, s = np.nonzero((m[:, None] >> np.arange(W)[None, :]) & 1)     # expand the 5-bit masks
        fly, neuron = fly[rows], neuron[rows]
        t = (self.step - n_win * W + w[rows] * W + s) * self.p.dt
        if watch is not None:
            keep = np.isin(neuron, watch)
            fly, neuron, t = fly[keep], neuron[keep], t[keep]
        order = np.lexsort((t, fly))
        fly, neuron, t = fly[order], neuron[order], t[order]
        cut = np.searchsorted(fly, np.arange(self.B + 1))
        return [(neuron[cut[b]:cut[b + 1]], t[cut[b]:cut[b + 1]]) for b in range(self.B)]
