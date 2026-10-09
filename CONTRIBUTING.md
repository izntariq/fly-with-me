# Contributing to Fly With Me

Thanks for wanting to help the fly DJ. Bug reports, new DJ moves, better DJ styles, music analysis, neuroscience
corrections and docs are all welcome.

## Getting set up

```bash
uv venv --python 3.12 .venv && uv pip install -r requirements.lock.txt   # or: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.lock.txt
PORT=8766 ./run.sh                # first run downloads ~210 MB of FlyWire data into vendor/ and data/
cd tools && npm ci                # only for the Node tests and browser tools
```

The browser app is plain JavaScript modules in `web/`, with no build step: edit and reload the page. The brain server
is `flybrain/`. [docs/NOTES.md](docs/NOTES.md) explains how everything fits together.

Test against a server of your own on port **8766** (as above, or `python -m flybrain.server --port 8766`), so it
never collides with an app you have open on the default 8765. The browser tools in `tools/` read the port from
`PORT`; run them as `PORT=8766 node tools/…` too.

## The checks

```bash
cd tools && npm test                  # DJ decisions and section-sense parity: plain Node, no browser, server or brain
.venv/bin/python -m unittest discover -s tests  # Python tests (tests/): LIF core, CPU/GPU parity, sections, mapping, guards
.venv/bin/python tools/gpucheck.py    # GPU users (Apple silicon, MLX): the paper's sugar experiment and speed
```

`test_dj_logic.mjs` runs the app's own Mixer, Performer and FlyDJ on a stand-in for Web Audio, so it needs nothing but
Node. The Python tests are standard-library `unittest`; run them with the project's `.venv` python, since tests whose
packages are missing skip rather than fail. `gpucheck.py` prints the GPU simulator's spike counts for the
sugar experiment beside the CPU's, then its speed for 1, 3 and 18 flies; the counts should land near the CPU numbers it
prints.

## Before you open a pull request

- **Tests:** new Python tests use the standard library's `unittest` (no pytest), build what they need in the test (see
  `tests/toy.py` for a toy connectome), and skip cleanly when an optional dependency (numba, mlx) isn't there. Never
  read `data/` or `vendor/` from a test. Browser-logic tests are plain Node scripts in `tools/test_*.mjs` that exit
  non-zero on failure: add new ones to the `test` script in `tools/package.json` and to `.github/workflows/ci.yml`.
  Tests never start the server on a port or open a browser.
- **Section sense:** `flybrain/sections.py` and `web/js/sections.js` must agree. Regenerate
  `tests/fixtures/sections_golden.json` only when the model is meant to change, and keep
  `tools/test_sections_parity.mjs` passing.

- **Run the checks above** and say in the PR that they pass.
- **Brain model changes:** run `tools/gpucheck.py` (or the CPU equivalent you used), and say in the PR what changed in
  the numbers.
- **Audio / DJ changes:** add or update a case in `tools/test_dj_logic.mjs` where you can, and describe what you tested
  and how. Measured is better than "sounds fine": levels, timing, pitch.
- **Match the code around you.** Comments explain *why*, not *what*.
- **Commit messages:** a subject line saying what changed, and a body saying why and anything you measured. The
  project history is a readable story, so please keep it that way ([docs/GIT.md](docs/GIT.md)).
- **DJ styles:** add sources to [docs/DJ_RESEARCH.md](docs/DJ_RESEARCH.md), and mark anything unverified as
  *(uncertain)*.

## Data and licensing

Code contributions are accepted under the project's [Apache 2.0 license](LICENSE).

Don't commit FlyWire data or anything derived from it (`data/` and `vendor/` are git-ignored). That data is
CC BY-NC 4.0, and users download it themselves. The one exception is `brains/`: the trained brain files are
FlyWire-derived and are distributed under CC BY-NC 4.0, not Apache-2.0 ([brains/README.md](brains/README.md),
[NOTICE](NOTICE)). A change to `brains/` is accepted under CC BY-NC 4.0; keep it to files the app loads, and don't
add snapshots nothing uses. The same goes for the male CNS connectome (CC BY 4.0): it is downloaded, never committed.

Don't commit copyrighted audio, lyrics, track names or analyses of real tracks either; the demo tracks are synthesized
in code for that reason, and your own tracks stay in the git-ignored `data/`.

## Be kind

Assume good faith, be patient with newcomers, and keep discussion about the work. See the
[code of conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not public issues.
