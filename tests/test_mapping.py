"""Which neurons the music goes into and comes out of (flybrain/mapping.py), and the offline ears (flybrain/ears.py),
on small synthetic annotation tables and test tones."""
from __future__ import annotations

import unittest

import numpy as np

try:
    import pandas as pd
    from flybrain import ears, mapping
except ImportError:                       # pandas missing
    mapping = None


def annotations():
    rows = []
    rid = 100

    def add(**kw):
        nonlocal rid
        rid += 1
        base = {"super_class": "central", "cell_class": "", "cell_sub_class": "", "cell_type": "", "side": "left",
                "top_nt": "ach", "pos_x": 1.0, "pos_y": 2.0, "pos_z": 3.0}
        base.update(kw)
        rows.append({"root_id": rid, **base})
        return rid
    for side in ("left", "right"):
        add(super_class="sensory", cell_type="JO-B1_a", side=side)
        add(super_class="sensory", cell_type="JO-B1_a", side=side)
        add(super_class="sensory", cell_type="JO-A3", side=side)
    add(super_class="sensory", cell_type="JO-B2", side="left")            # one side only: band left out
    add(super_class="sensory", cell_type="JO-A-unclear", side="left")     # joins the smallest JO-A band
    add(super_class="sensory", cell_type="JO-A-unclear", side="right")
    add(super_class="sensory", cell_type="JO-CE", side="left")            # wind
    add(super_class="sensory", cell_sub_class="sugar/water", cell_type="LB3")
    add(super_class="sensory", cell_sub_class="sugar/water", cell_type="other")   # not LB3: not sugar
    add(super_class="descending", cell_type="DNp01", side="right", top_nt=np.nan)
    add(super_class="descending", cell_type="DNa02", side="left")
    add(super_class="motor", cell_type="MN1", side=np.nan)
    missing = add(super_class="descending", cell_type="DNx", side="left")  # not in the connectome
    a = pd.DataFrame(rows).set_index("root_id")
    ids = np.array([i for i in a.index if i != missing], np.int64)[::-1]   # connectome order differs from the table
    return a, ids


@unittest.skipIf(mapping is None, "pandas not importable")
class Mapping(unittest.TestCase):
    def setUp(self):
        self.ann, self.ids = annotations()
        self.id2idx = {int(f): i for i, f in enumerate(self.ids)}

    def test_inputs(self):
        ch = {c.name: c for c in mapping.build_inputs(self.ann, self.id2idx)}
        self.assertIn("earL:JO-B1_a", ch)
        self.assertEqual(len(ch["earL:JO-B1_a"].idx), 2)
        self.assertEqual(ch["earR:JO-B1_a"].meta, {"ear": "R", "lo": 40, "hi": 70})
        self.assertNotIn("earL:JO-B2", ch, "a band with neurons on one side only is left out of both ears")
        # the unclassified JO-A neuron joins the smallest JO-A band, which then exists on both sides
        jo_a = [n for n in ch if n.startswith("earL:JO-A")]
        self.assertTrue(jo_a)
        self.assertEqual(sum(len(ch[n].idx) for n in jo_a), 2)
        self.assertEqual(len(ch["wind"].idx), 1)
        self.assertEqual(len(ch["sugar"].idx), 1)
        self.assertNotIn("bitter", ch, "empty channels are dropped")
        for c in ch.values():
            self.assertTrue(np.all(self.ids[c.idx] > 0))

    def test_outputs_sorted_with_metadata(self):
        idx, meta = mapping.build_outputs(self.ann, self.ids)
        self.assertEqual([(m["cls"], m["type"]) for m in meta],
                         [("descending", "DNa02"), ("descending", "DNp01"), ("motor", "MN1")])
        self.assertEqual([str(self.ids[i]) for i in idx], [m["id"] for m in meta])
        self.assertEqual(meta[1]["nt"], "")                 # NaN transmitter -> ""
        self.assertEqual(meta[2]["side"], "")

    def test_ear_bands_are_contiguous(self):
        for (_, _, hi), (_, lo, _) in zip(mapping.EAR_BANDS[:-1], mapping.EAR_BANDS[1:]):
            self.assertEqual(hi, lo)


@unittest.skipIf(mapping is None, "pandas not importable")
class Ears(unittest.TestCase):
    def test_tone_drives_its_band(self):
        sr = 44100
        t = np.arange(sr) / sr
        for hz in (90.0, 400.0, 3000.0):
            with self.subTest(hz=hz):
                x = np.stack([0.5 * np.sin(2 * np.pi * hz * t), np.zeros_like(t)]).astype(np.float32)
                lv, names = ears.ear_drive(x, sr)
                self.assertEqual(len(names), 2 * len(mapping.EAR_BANDS))
                mean = lv[10:].mean(0)
                want = next(f"earL:{typ}" for typ, lo, hi in mapping.EAR_BANDS if lo <= hz < hi)
                self.assertEqual(names[int(mean.argmax())], want)
                self.assertTrue(np.all(lv[:, len(mapping.EAR_BANDS):] == 0), "silent right channel drives nothing")
                self.assertTrue(np.all((lv >= 0) & (lv <= 1)))


if __name__ == "__main__":
    unittest.main()
