"""Section sense (flybrain/sections.py): the golden fixture the browser is checked against, and the small helpers."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "fixtures"))
from flybrain import sections as S  # noqa: E402
from make_sections_golden import posteriors  # noqa: E402

GOLDEN = json.loads((HERE / "fixtures" / "sections_golden.json").read_text())


class Golden(unittest.TestCase):
    def test_python_still_matches_golden(self):
        """If this fails, sections.py changed what it computes: if that's meant, regenerate the fixture
        (tests/fixtures/make_sections_golden.py) and check web/js/sections.js with tools/test_sections_parity.mjs."""
        counts, energy, frac = np.array(GOLDEN["counts"]), np.array(GOLDEN["energy"]), np.array(GOLDEN["frac"])
        for name, case in GOLDEN["cases"].items():
            with self.subTest(case=name):
                P, A = posteriors(case["spec"], GOLDEN["outputs"], counts, energy, frac)
                np.testing.assert_allclose(P, case["P"], atol=1e-9)
                np.testing.assert_allclose(A, case["posterior"], atol=1e-9)
                np.testing.assert_allclose(A.sum(1), 1.0, atol=1e-12)


class Helpers(unittest.TestCase):
    def test_type_groups(self):
        meta = [{"cls": "motor", "type": "B"}, {"cls": "descending", "type": "A"}, {"cls": "motor", "type": "B"}]
        groups, of = S.type_groups(meta)
        self.assertEqual(groups, ["descending:A", "motor:B"])
        self.assertEqual(of.tolist(), [1, 0, 1])

    def test_bar_features_are_causal(self):
        rng = np.random.default_rng(0)
        rates = rng.uniform(0, 20, (30, 5))
        of = np.array([0, 0, 1, 2, 2])
        f = S.bar_features(rates, of, 3)
        self.assertEqual(f.shape, (30, 6))
        self.assertTrue(np.all(f[:3, :3] == 0), "no z-score before the 4-bar warm-up")
        changed = rates.copy()
        changed[20:] *= 3
        np.testing.assert_array_equal(S.bar_features(changed, of, 3)[:20], f[:20])
        # context = mean of the previous 4 bars' z
        np.testing.assert_allclose(f[10, 3:], f[6:10, :3].mean(0))

    def test_energy_features_are_causal(self):
        e = np.linspace(0.01, 0.1, 25)
        f = S.energy_features(e)
        e2 = e.copy()
        e2[15:] = 1.0
        np.testing.assert_array_equal(S.energy_features(e2)[:15], f[:15])
        self.assertTrue(np.all(f[:3, 0] == 0))

    def test_softmax(self):
        p = S.softmax(np.array([[1000.0, 1000.0], [0.0, np.log(3.0)]]))
        np.testing.assert_allclose(p, [[0.5, 0.5], [0.25, 0.75]])

    def test_fit_logreg_separates(self):
        rng = np.random.default_rng(1)
        y = rng.integers(0, 3, 300)
        X = np.eye(3)[y] * 2 + rng.normal(0, 0.3, (300, 3))
        W, b = S.fit_logreg(X, y, 3)
        self.assertGreater(np.mean(S.softmax(X @ W + b).argmax(1) == y), 0.95)

    def test_transitions_and_learned_arrangement(self):
        T = S.transitions()
        np.testing.assert_allclose(T.sum(1), 1.0)
        self.assertEqual(T[3, 3], 1.0)                      # outro stays
        self.assertEqual(T[0, 2], 0.0)                      # no intro -> break
        labels = [np.array([0, 0, 1, 1, 2, 1, 3, 3]), np.array([0, 1, 1, 1, 3])]
        T2, start, pos = S.learn_arrangement(labels, 4)
        np.testing.assert_allclose(T2.sum(1), 1.0)
        self.assertAlmostEqual(start.sum(), 1.0)
        self.assertEqual(start.argmax(), 0)
        self.assertEqual(pos.shape, (10, 4))
        self.assertGreater(T2[0, 1], T2[0, 2])

    def test_hmm_filter_is_causal_and_normalised(self):
        rng = np.random.default_rng(2)
        P = S.softmax(rng.normal(0, 1, (30, 4)))
        frac = (np.arange(30) + 0.5) / 30
        A = S.hmm_filter(P, frac)
        np.testing.assert_allclose(A.sum(1), 1.0)
        P2 = P.copy()
        P2[20:] = [0.97, 0.01, 0.01, 0.01]
        np.testing.assert_array_equal(S.hmm_filter(P2, frac)[:20], A[:20])
        # once in the outro it never leaves (outro -> outro = 1)
        Po = np.tile([0.01, 0.01, 0.01, 0.97], (30, 1))
        self.assertEqual(S.hmm_filter(Po, frac).argmax(1)[-1], 3)

    def test_label_track(self):
        energy = [0.1] * 8 + [1.0] * 16 + [0.2] * 8 + [1.0] * 16 + [0.1] * 8
        lab = S.label_track(energy)
        self.assertEqual(len(lab), len(energy))
        self.assertEqual(lab[0], "intro")
        self.assertEqual(lab[10], "main")
        self.assertEqual(lab[27], "break")
        self.assertEqual(lab[-1], "outro")

    def test_label_allin1(self):
        segs = {"segments": [{"start": 0.0, "end": 10.0, "label": "intro"}, {"start": 10.0, "end": 20.0, "label": "chorus"},
                             {"start": 20.0, "end": 25.0, "label": "bridge"}, {"start": 25.0, "end": 30.0, "label": "weird"}]}
        # 120 BPM: 2 s bars, labelled at each bar's midpoint
        lab = S.label_allin1(segs, first_beat=0.0, bpm=120.0, n_bars=17)
        self.assertEqual(lab[:5], ["intro"] * 5)
        self.assertEqual(lab[5:10], ["chorus"] * 5)
        self.assertEqual(lab[10:12], ["break", "break"])    # bridge -> break
        self.assertEqual(lab[12:15], ["verse"] * 3)         # midpoint 25 s is in the next segment; unknown -> verse
        self.assertEqual(lab[15:], ["outro"] * 2)           # after the last segment

    def test_scores(self):
        y = np.array([0, 0, 1, 1, 2, 3])
        r = S.scores(y, y.copy())
        self.assertEqual(r["accuracy"], 1.0)
        self.assertEqual(r["macro_f1"], 1.0)
        r = S.scores(y, np.zeros_like(y))
        self.assertAlmostEqual(r["intro"]["precision"], 2 / 6, places=3)
        self.assertEqual(r["main"]["recall"], 0.0)


class ShippedSpec(unittest.TestCase):
    def test_shipped_specs_have_consistent_shapes(self):
        found = 0
        for f in sorted((HERE.parent / "brains").glob("sections_*.json")):
            found += 1
            with self.subTest(file=f.name):
                s = json.loads(f.read_text())
                k = len(s["classes"])
                self.assertEqual(len(s["W"]), 2 * len(s["groups"]) + (2 if s.get("energy") else 0))
                self.assertTrue(all(len(r) == k for r in s["W"]))
                self.assertEqual(len(s["b"]), k)
                if "T" in s:
                    self.assertEqual(np.array(s["T"]).shape, (k, k))
                    np.testing.assert_allclose(np.array(s["T"]).sum(1), 1.0, atol=1e-3)
                    self.assertEqual(len(s["start"]), k)
                    self.assertEqual(np.array(s["pos"]).shape[1], k)
        if not found:
            self.skipTest("no brains/sections_*.json")


if __name__ == "__main__":
    unittest.main()
