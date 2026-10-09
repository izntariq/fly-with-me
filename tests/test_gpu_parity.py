"""CPU (flybrain/brain.py, Numba) against GPU (flybrain/gpu.py, MLX Metal kernels) on toy networks.

Skipped unless both numba and mlx import and a Metal device is there (Apple silicon). The deterministic part (drive
whose per-step probability is 1, so neither side draws random numbers) must give the same spikes exactly. The
stochastic part can't: the two sides use different random number generators, and the GPU's synaptic sums are float
atomics whose order isn't fixed (gpu.py _PROPAGATE_SRC), so only spike counts are compared, within a tolerance."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

try:
    import numba  # noqa: F401
    import mlx.core as mx
    from flybrain.brain import Brain
    from flybrain.gpu import GPUBrains
    mx.eval(mx.zeros(1) + 1)
    _ok = mx.metal.is_available()
except Exception:                          # noqa: BLE001 -- ImportError, or no Metal device
    _ok = False

sys.path.insert(0, str(Path(__file__).resolve().parent))      # tests/ (when run as a single file)
sys.path.insert(0, str(Path(__file__).resolve().parent))          # tests/, also when run as a single file
from toy import ALWAYS_HZ, connectome, random_network  # noqa: E402


def cpu(n, edges, seed=1):
    with connectome(n, edges, "flybrain.brain"):
        return Brain(seed=seed)


def gpu(n, edges, flies=1, seed=1):
    with connectome(n, edges, "flybrain.gpu"):
        return GPUBrains(flies, seed=seed)


def events(idx, t):
    return sorted(zip(np.round(np.asarray(t) / 0.25).astype(int).tolist(), np.asarray(idx).tolist()))


@unittest.skipUnless(_ok, "mlx / Metal not available (GPU parity runs on Apple silicon only)")
class GPUParity(unittest.TestCase):
    def test_deterministic_drive_same_spikes(self):
        """Neurons kicked every step (p = 1) drive a random network: no randomness on either side, so the CPU and
        the GPU must agree spike for spike, including across run() calls and a change of drive."""
        n = 40
        edges = random_network(n, p=0.2, seed=2)
        c, g = cpu(n, edges), gpu(n, edges)
        out_c, out_g = [], []
        for drive in (np.arange(0, 3), np.arange(5, 9)):
            c.set_stim(drive, np.full(len(drive), ALWAYS_HZ))
            g.set_stim(0, drive, np.full(len(drive), ALWAYS_HZ))
            for _ in range(4):
                out_c += events(*c.run(12.5))
                (gi, gt), = g.run(12.5)
                out_g += events(gi, gt)
        self.assertGreater(len(out_c), 100)
        self.assertGreater(len({i for _, i in out_c} - set(range(9))), 3, "the drive should spread into the network")
        self.assertEqual(out_c, out_g)

    def test_flies_are_independent(self):
        """Batched flies share the wiring but not their state or drive."""
        n = 30
        edges = random_network(n, seed=4)
        g = gpu(n, edges, flies=3)
        g.set_stim(1, np.arange(3), np.full(3, ALWAYS_HZ))
        res = g.run(25.0)
        self.assertEqual(len(res[0][0]), 0)
        self.assertEqual(len(res[2][0]), 0)
        c = cpu(n, edges)
        c.set_stim(np.arange(3), np.full(3, ALWAYS_HZ))
        self.assertEqual(events(*res[1]), events(*c.run(25.0)))
        self.assertEqual(list(g.last_counts), [0, len(res[1][0]), 0])

    def test_poisson_counts_agree(self):
        """20 Hz Poisson drive on isolated neurons: different generators, same statistics."""
        n, hz, ms = 400, 20.0, 2000.0
        c, g = cpu(n, []), gpu(n, [])
        c.set_stim(np.arange(n), np.full(n, hz))
        g.set_stim(0, np.arange(n), np.full(n, hz))
        nc = len(c.run(ms)[0])
        ng = len(g.run(ms)[0][0])
        expected = n * hz * ms / 1000
        for k in (nc, ng):
            self.assertLess(abs(k - expected) / expected, 0.07)
        self.assertLess(abs(nc - ng) / expected, 0.05)

    def test_poisson_network_rates_agree(self):
        """Stochastic drive into a recurrent network: per-neuron spike counts agree on average (not exactly)."""
        n = 40
        edges = random_network(n, p=0.15, seed=6)
        c, g = cpu(n, edges, seed=3), gpu(n, edges, seed=3)
        c.set_stim(np.arange(8), np.full(8, 100.0))
        g.set_stim(0, np.arange(8), np.full(8, 100.0))
        cc = np.bincount(c.run(2000.0)[0], minlength=n)
        gc = np.bincount(g.run(2000.0)[0][0], minlength=n)
        self.assertGreater(cc.sum(), 1000)
        self.assertLess(abs(cc.sum() - gc.sum()) / cc.sum(), 0.1)
        busy = cc > 50
        self.assertLess(np.median(np.abs(cc[busy] - gc[busy]) / cc[busy]), 0.15)


if __name__ == "__main__":
    unittest.main()
