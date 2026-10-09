"""The LIF core (flybrain/brain.py) on hand-built toy networks: exact integration, spike / reset / refractory,
synaptic delay, Poisson drive, and the event-driven kernel against the dense one."""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

import numpy as np

try:
    import numba  # noqa: F401
    from flybrain.brain import Brain, Params
except ImportError as e:                      # numba (or pandas) missing: nothing here can run
    Brain = None
    _why = str(e)

sys.path.insert(0, str(Path(__file__).resolve().parent))      # tests/ (when run as a single file)
sys.path.insert(0, str(Path(__file__).resolve().parent))          # tests/, also when run as a single file
from toy import ALWAYS_HZ, connectome, random_network  # noqa: E402

NO_STIM = (np.zeros(0, np.int64), np.zeros(0))


def make(n, edges, params=None, seed=1, kernel="event"):
    with connectome(n, edges):
        b = Brain(params, seed=seed)
    b.event = kernel == "event"
    return b


def steps(b, spikes_t):
    """Spike times (ms) -> integer steps."""
    return [int(round(t / b.p.dt)) for t in spikes_t]


@unittest.skipIf(Brain is None, "numba / flybrain.brain not importable")
class LIFCore(unittest.TestCase):
    KERNELS = ("event", "dense")

    def test_psp_matches_closed_form(self):
        """A single presynaptic spike: B's membrane follows the exact solution of the coupled linear ODE,
        v(t) = v_0 + w * tau / (tau - t_mbr) * (exp(-t/tau) - exp(-t/t_mbr)), from the step the input arrives."""
        for kernel in self.KERNELS:
            with self.subTest(kernel=kernel):
                count = 40.0                                   # synapses; w = 40 * 0.275 = 11 mV, peak ~1.7 mV
                b = make(2, [(0, 1, count)], kernel=kernel)
                p = b.p
                w = count * p.w_syn
                b.set_stim(np.array([0]), np.array([ALWAYS_HZ]))
                idx, t = b.run(p.dt)                            # step 0: A is kicked and fires
                self.assertEqual(list(idx), [0])
                b.set_stim(*NO_STIM)
                for s in range(1, 80):
                    idx, _ = b.run(p.dt)
                    self.assertEqual(len(idx), 0)
                    vb = float(b.v[1])
                    if s < b.n_dly:
                        self.assertEqual(vb, p.v_0, f"input arrived early, step {s}")
                    else:
                        tt = (s - b.n_dly + 1) * p.dt               # the input lands at the start of step n_dly
                        want = p.v_0 + w * p.tau / (p.tau - p.t_mbr) * (math.exp(-tt / p.tau) - math.exp(-tt / p.t_mbr))
                        self.assertAlmostEqual(vb, want, delta=1e-4, msg=f"step {s}")

    def test_inhibitory_input_hyperpolarises(self):
        b = make(2, [(0, 1, -40.0)])
        b.set_stim(np.array([0]), np.array([ALWAYS_HZ]))
        b.run(b.p.dt)
        b.set_stim(*NO_STIM)
        b.run(5.0)
        self.assertLess(float(b.v[1]), b.p.v_0 - 0.5)

    def test_spike_reset_and_refractory_period(self):
        """Driven every step, a neuron fires once per refractory period, and resets to v_rst when it does."""
        for kernel in self.KERNELS:
            with self.subTest(kernel=kernel):
                b = make(1, [], kernel=kernel)
                b.set_stim(np.array([0]), np.array([ALWAYS_HZ]))
                idx, t = b.run(10.0)
                s = steps(b, t)
                self.assertEqual(b.n_ref, round(b.p.t_rfc / b.p.dt))
                self.assertEqual(s, list(range(0, 40, b.n_ref)))
                b2 = make(1, [], kernel=kernel)
                b2.set_stim(np.array([0]), np.array([ALWAYS_HZ]))
                b2.run((b2.n_ref + 1) * b2.p.dt)                 # ends on the step of the second spike
                self.assertEqual(float(b2.v[0]), b2.p.v_rst)
                self.assertEqual(int(b2.ref[0]), b2.n_ref)

    def test_input_during_refractory_waits(self):
        """Input arriving while refractory isn't lost and can't fire the neuron: the conductance is held (no decay,
        no integration) and fires it on the first step after the refractory period."""
        for kernel in self.KERNELS:
            with self.subTest(kernel=kernel):
                big = 4000.0                                    # far above threshold in one step
                b = make(3, [(0, 2, big), (1, 2, big)], kernel=kernel)
                b.set_stim(np.array([0]), np.array([ALWAYS_HZ]))
                b.run(b.p.dt)                                   # step 0: A fires
                b.set_stim(np.array([1]), np.array([ALWAYS_HZ]))
                b.run(b.p.dt)                                   # step 1: A' fires
                b.set_stim(*NO_STIM)
                idx, t = b.run(10.0)
                s = [st for i, st in zip(idx, steps(b, t)) if i == 2]
                self.assertEqual(s, [b.n_dly, b.n_dly + b.n_ref + 1])

    def test_synaptic_delay(self):
        """A presynaptic spike at step 0 reaches its target n_dly = round(t_dly / dt) steps later."""
        for t_dly in (1.8, 1.0, 0.5):
            with self.subTest(t_dly=t_dly):
                b = make(2, [(0, 1, 4000.0)], params=Params(t_dly=t_dly))
                b.set_stim(np.array([0]), np.array([ALWAYS_HZ]))
                b.run(b.p.dt)
                b.set_stim(*NO_STIM)
                idx, t = b.run(5.0)
                self.assertEqual(list(idx), [1])
                self.assertEqual(steps(b, t), [max(1, round(t_dly / b.p.dt))])

    def test_poisson_drive_rate(self):
        """Isolated neurons at 20 Hz: every kick fires the neuron (a kick during refractory fires it right after),
        except when two kicks share one refractory period, so the rate is a few percent under nominal."""
        n, hz, ms = 400, 20.0, 2000.0
        b = make(n, [], seed=7)
        b.set_stim(np.arange(n), np.full(n, hz))
        idx, _ = b.run(ms)
        rate = len(idx) / n / (ms / 1000)
        self.assertGreater(rate, 0.93 * hz)
        self.assertLess(rate, 1.02 * hz)
        # the per-neuron counts look Poisson-ish (variance ~ mean), not clocked
        c = np.bincount(idx, minlength=n)
        self.assertGreater(c.var() / c.mean(), 0.6)
        self.assertLess(c.var() / c.mean(), 1.4)

    def test_seeded_runs_repeat(self):
        out = []
        for _ in range(2):
            b = make(30, random_network(30, seed=3), seed=11)
            b.set_stim(np.arange(10), np.full(10, 80.0))
            out.append(b.run(200.0))
        np.testing.assert_array_equal(out[0][0], out[1][0])
        np.testing.assert_array_equal(out[0][1], out[1][1])

    def test_event_kernel_matches_dense(self):
        """The event-driven kernel skips neurons at rest; with the same seed it draws the same random numbers in the
        same order, so it must give the dense kernel's spikes exactly (same neurons, same steps)."""
        edges = random_network(40, seed=5)
        res = {}
        for kernel in self.KERNELS:
            b = make(40, edges, seed=3, kernel=kernel)
            b.set_stim(np.arange(8), np.full(8, 120.0))
            a = b.run(150.0)
            b.set_stim(np.arange(4, 12), np.full(8, 60.0))         # change the drive mid-run
            c = b.run(150.0)
            # within one step the two list spikes in a different order (active list vs index order): compare as sets
            res[kernel] = sorted(zip(np.concatenate([a[1], c[1]]).tolist(), np.concatenate([a[0], c[0]]).tolist()))
        self.assertGreater(len(res["event"]), 50)
        self.assertEqual(res["event"], res["dense"])

    def test_reset_and_sibling(self):
        b = make(2, [(0, 1, 4000.0)])
        b.set_stim(np.array([0]), np.array([ALWAYS_HZ]))
        b.run(5.0)
        s = b.sibling()
        self.assertTrue(np.all(s.v == b.p.v_0))
        self.assertIs(s.indptr, b.indptr)
        self.assertEqual(len(s.run(5.0)[0]), 0)                   # a sibling has its own (empty) drive
        b.reset()
        self.assertTrue(np.all(b.v == b.p.v_0) and np.all(b.ring == 0) and np.all(b.ref == 0))


if __name__ == "__main__":
    unittest.main()
