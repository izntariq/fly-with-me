"""Check the simulator against the published model.

    python -m flybrain.validate

Reproduces the example experiment from Shiu et al. (2024): 21 right-hemisphere sugar-sensing neurons driven at
200 Hz for 1 s. The paper reports about 400 active neurons, with feeding motor neurons among them.
"""
import sys
import time

import numpy as np

from .brain import Brain

# the paper's example sugar GRNs (FlyWire IDs from Drosophila_brain_model/example.ipynb; 20 of 21 exist in v783)
SUGAR = [720575940624963786, 720575940630233916, 720575940637568838, 720575940638202345, 720575940617000768,
         720575940630797113, 720575940632889389, 720575940621754367, 720575940621502051, 720575940640649691,
         720575940639332736, 720575940616885538, 720575940639198653, 720575940620900446, 720575940617937543,
         720575940632425919, 720575940633143833, 720575940612670570, 720575940628853239, 720575940629176663,
         720575940611875570]


def main():
    t = time.time()
    b = Brain()
    print(f"connectome: {b.n:,} neurons, {len(b.indices):,} connections (loaded in {time.time() - t:.1f}s)")
    idx = np.array([b.id2idx[i] for i in SUGAR if i in b.id2idx])
    b.set_stim(idx, np.full(len(idx), 200.0))
    b.run(1); b.reset()
    t = time.time()
    si, _ = b.run(1000)
    wall = time.time() - t
    active = len(np.unique(si))
    print(f"sugar GRNs driven: {len(idx)} at 200 Hz for 1 s -> {len(si):,} spikes, {active} active neurons "
          f"(paper: ~400), {wall:.2f}s compute for 1 s of brain")
    ok = 300 <= active <= 500 and b.n > 130_000
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
