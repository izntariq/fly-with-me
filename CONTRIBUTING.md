# Contributing to Fly With Me

Thanks for wanting to help the fly DJ. Bug reports, new DJ moves, better DJ styles, music analysis, neuroscience
corrections and docs are all welcome.

## Getting set up

```bash
python3 -m pip install -r requirements.txt
./run.sh                          # first run downloads ~400 MB of FlyWire data into vendor/ and data/
python3 -m flybrain.validate      # the simulator should reproduce the paper's sugar experiment (PASS)
```

The browser app is plain JavaScript modules in `web/`, with no build step: edit and reload the page. The brain server
is `flybrain/`. [docs/NOTES.md](docs/NOTES.md) explains how everything fits together.

## Before you open a pull request

- **Brain model changes:** run `python3 -m flybrain.validate`, and say in the PR what changed in the numbers.
- **Audio / DJ changes:** describe what you tested and how. Measured is better than "sounds fine": levels, timing,
  pitch.
- **Match the code around you.** Comments explain *why*, not *what*.
- **Commit messages:** a subject line saying what changed, and a body saying why and anything you measured. The
  project history is a readable story, so please keep it that way ([docs/GIT.md](docs/GIT.md)).
- **DJ styles:** add sources to [docs/DJ_RESEARCH.md](docs/DJ_RESEARCH.md), and mark anything unverified as
  *(uncertain)*.

## Data and licensing

Contributions are accepted under the project's [Apache 2.0 license](LICENSE). Don't commit FlyWire data or anything
derived from it (`data/` and `vendor/` are git-ignored). That data is CC BY-NC 4.0, and users download it
themselves. Don't commit copyrighted audio either; the demo tracks are synthesized in code for that reason.

## Be kind

Assume good faith, be patient with newcomers, and keep discussion about the work.
