"""Hand-built toy connectomes for the LIF tests: a few neurons in CSR form, swapped in for the real FlyWire load so
Brain / GPUBrains can be constructed without data/ or vendor/."""
from __future__ import annotations

import contextlib
from unittest import mock

import numpy as np

ALWAYS_HZ = 1e9          # a Poisson rate whose per-step probability clips to 1: a kick every step, no randomness


def csr(n: int, edges: list[tuple[int, int, float]]):
    """(ids, indptr, indices, weights) like brain.load_connectome: edges are (pre, post, signed synapse count)."""
    edges = sorted(edges, key=lambda e: e[0])
    indptr = np.zeros(n + 1, np.int64)
    for pre, _, _ in edges:
        indptr[pre + 1] += 1
    indptr = np.cumsum(indptr)
    indices = np.array([e[1] for e in edges], np.int32)
    weights = np.array([e[2] for e in edges], np.float32)
    ids = np.arange(1000, 1000 + n, dtype=np.int64)
    return ids, indptr, indices, weights


@contextlib.contextmanager
def connectome(n, edges, module="flybrain.brain"):
    """Make `module`.load_connectome return the toy network while constructing a model."""
    con = csr(n, edges)
    with mock.patch(f"{module}.load_connectome", lambda: con):
        yield con


def random_network(n=40, p=0.15, seed=0):
    """A small random network, mostly excitatory, with weights in synapse counts (x w_syn = mV)."""
    rng = np.random.default_rng(seed)
    edges = []
    for i in range(n):
        for j in range(n):
            if i != j and rng.random() < p:
                sign = -1.0 if rng.random() < 0.25 else 1.0
                edges.append((i, j, sign * float(rng.integers(5, 60))))
    return edges
