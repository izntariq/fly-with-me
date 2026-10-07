# Training the fly brain to DJ

*Branch `fork/steady-mix`.* Training began on its own branch (now `fork/trained-3flies-gpu-visualiser`), which this
one continues. On `main` the connectome is never changed. Here, some of its synapses are trained.

## Where it stands

- **What's trained:** 9,978 existing synapses onto 25 descending neurons, about 0.07% of the connectome's
  connections. The server loads them by default (`--brain auto` uses `brains/trained_brain.npz`); `--brain naive`
  runs the untouched connectome. All three flies get the same trained synapses. The readout and the section model
  load only with the trained brain (there's no `sections_naive.json`), so a naive run has neither.
- **What it did:** offline, the trained neurons fire more in the sections they were trained for. Live, the listener
  flies' trained neurons still order the sections (PEAK drops in breakdowns, MIX is highest in intros), but the
  detectors built on them land near chance.
- **What the app decides with:** where a deck is in its track comes from the analysed song structure (All-In-One) when
  the track has one, and otherwise from section sense v3, a classifier on all of the listener fly's output neurons.
  Moves, transition styles and track picks come from hand-set rules on the flies' spikes (burst detectors, steering,
  spike counts), not from anything trained.
- **The fair test:** on 131 real tracks, a section model built on the trained brain scores the same as one built on
  the untrained brain (+0.002 ± 0.012 macro-F1), and no better than one built on the fly's own ear input
  (+0.013 ± 0.028). **Synapse training doesn't measurably help section sensing, and the brain doesn't beat its own
  input.** Details in [The fair test](#the-fair-test-does-the-brain-add-anything-3-october).

## What the fly learns

A DJ's big decisions depend on where you are in a track. Four of the fly's own descending-neuron groups (the same
groups the app listens to for moves) were each trained to recognise one kind of moment:

| Intent | Neurons | Should fire during | What it was meant to drive |
|---|---|---|---|
| **SPACE** | DNp02 · DNp06 · DNp11 · DNp55 | breakdowns | echo and reverb throws |
| **MIX** | DNb06 · DNge113 · DNge145 | intros and outros (mixing windows) | getting ready to transition |
| **PEAK** | DNg24 · DNg29 | the full-energy main sections | flourishes, scratches |
| **BUILD** | DNp01 (giant fiber) | build-ups | rolls and builds |

The targets come from each demo track's arrangement: intro 8 · build 8 · main 16 · break 4 · main 8 · outro 4 bars.

**How the app uses the trained neurons today:**
- The listener flies' readout (`brains/readout.json`, below) drives the visualiser's MIX / SPACE / PEAK meters. The DJ
  uses it only when no section model is loaded.
- The first six of the 12 listener taps that feed the DJ fly's ears are the readout's neurons: DNp55, DNge145,
  DNge113, DNp12, DNg24 and DNg29. All but DNp12 are trained; the trained types are DNp01, DNp02, DNp06, DNp11, DNp55,
  DNb06, DNge113, DNge145, DNg24 and DNg29.
- Section sense v3 was fitted on recordings of the trained brain, but it reads all 518 output-neuron types, not just
  the trained ones.

## How

- **Training data.** The 8 synthesized demo tracks (4 club, 4 desi), exported by `tools/export_demo_tracks.mjs`.
  - **6 train.** Proboscis Extension, Giant Fiber Escape, Moonwalker DN, Dhol Descending Neuron, Tabla Theka
    Connectome, Bhairav in the Mushroom Body.
  - **2 held out, never trained on.** *Johnston's Organ* (club) and *Proboscis Dhamaal* (desi).
- **Ears.** The fly hears each track through a Python port of the app's ears (`flybrain/ears.py`), driving its real
  Johnston's-organ neurons.
- **What changes.** Only the **9,978 existing synapses onto the 25 trained neurons**. No connections are added.
  - Each synapse keeps its sign, so an excitatory synapse stays excitatory (Dale's law).
  - Magnitudes stay between 0 and 4× the original, plus 5 synapses' worth.
  - Everything else (138,614 neurons, ~15 million connections) is the untouched FlyWire connectome.
- **Two learning methods** (`python -m flybrain.train --method …`):
  - **`online`: a three-factor rule, the way flies learn.** For every synapse, presynaptic activity × the
    postsynaptic error (target − actual rate) is accumulated over a track and applied once per track. The error
    plays the role dopamine plays in the fly's own learning circuits.
  - **`fit`: model-based, the fast method.**
    1. Record the brain listening to the training tracks.
    2. Measure each trained neuron's input-to-rate curve: rate ≈ gain × (drive − threshold).
    3. Fit its synapse magnitudes so that the model neuron fires on the targets. The same constraints apply, plus a
       pull toward the original weights.
    4. Install the weights, re-record, and repeat.

    Every result below is checked in the **full spiking brain**, not in the model.
- **Options:** `--init` starts from a saved brain, `--freeze` keeps an intent's synapses at the connectome's weights,
  and `--split` trains on two different tracks, one per ear.

## Can the brain even know? (measured first)

Before training, I recorded the ~560 active neurons that feed the trained ones while the fly listened to one track.
Then I fitted the best possible *linear* readout and tested it on a different track:

| Intent | Best readout (any sign) | Best readout keeping Dale's law | Verdict |
|---|---|---|---|
| SPACE (breakdowns) | r = 0.93 | r = 0.81 | learnable |
| MIX (intros/outros) | r = 0.72 | r = 0.49 | partly learnable |
| PEAK (main sections) | r = 0.59 | r = 0.46 | partly learnable |
| BUILD (build-ups) | r = 0.16 | r = −0.14 | **not in the sound**: a build-up sounds like the main section second to second; knowing "a drop is coming" needs memory the auditory pathway doesn't have |

An earlier fourth intent, GROOVE ("not the first 8 bars after a drop"), was dropped for the same reason: r = 0.22,
because it depends on time since the drop, not on sound.

## Results (session 1, 28 September)

The kept brain is `brains/trained_brain.npz`: the `fit` method, round 2, with BUILD's 962 synapses reset to the
connectome's original weights. Plain round 2 is kept as `brains/trained_brain_fit_r2.npz`.

### In the spiking brain, on 2 held-out tracks never trained on

Each cell shows correlation with the target sections, then selectivity (rate in target sections ÷ rate elsewhere).

| Intent | Untouched brain | Fit round 1 | **Fit round 2 (kept)** |
|---|---|---|---|
| SPACE (breakdowns) | −0.23 · 0.73 | −0.16 · 0.85 | **+0.21 · 1.20** |
| MIX (intros/outros) | 0.00 · 1.01 | −0.11 · 0.95 | **+0.38 · 1.31** |
| PEAK (main sections) | +0.33 · 1.16 | +0.48 · 1.29 | +0.42 · 1.18 |
| BUILD (build-ups) | +0.20 · 1.15 | +0.19 · 1.13 | −0.06 · 0.84, so restored to the original (+0.22) |

In the fit model, error fell 562 → 263 in round 1 and 1585 → 206 in round 2, and synapses moved about 41–42% on
average. The trained brain is as active as the untouched one (about 28k spikes/s), with no runaway.

### In the live app (one fly): where the fly acts

Headless runs of 8–10 minutes each, logging the section of the on-air track at every move and transition decision.
These trained runs used plain fit round 2, before BUILD was restored; that's why the giant fiber's rolls were almost
absent and the trained fly made fewer moves overall.

| | Untouched brain (8 min) | Trained brain (2 runs, 18 min) |
|---|---|---|
| Echo / reverb moves (SPACE neurons) in breakdowns or outros | **0 of 24** (build 12, main 9, intro 3) | **4 of 5** (break 3, outro 1, intro 1) |
| Transitions started in intros or outros | 0 of 14 | 0 of 6 |
| Total moves | 45 | 16 and 16: calmer |

**What changed:**
- **SPACE:** the trained fly saved its space moves for breakdowns, where a DJ puts them.
- **MIX:** its neurons learned to fire more in mixing windows (+0.38), but at ~5 Hz their bursts rarely cleared the
  app's detection threshold, so transitions still started mid-track.
- **PEAK:** its flourishes fired in intros during the live runs, so that intent wasn't doing its job.

The samples are small (5 space moves in the trained runs).

### What didn't work

- **Fit round 3** stalled for about 2 hours (the Mac slept) and was stopped. Runs now use `caffeinate`.
- **Online fine-tuning from round 2 made it worse on the held-out tracks**, so it was not kept:

  | Learning rate | SPACE | MIX | PEAK |
  |---|---|---|---|
  | 0.3 (epoch 1) | +0.22 → −0.11 | +0.37 → +0.06 | +0.42 → +0.19 |
  | 0.05 (epoch 1) | +0.22 → +0.11 | +0.37 → +0.21 | +0.42 → +0.43 |

- **The fit method mis-calibrates firing rates:** PEAK ends near 120 Hz everywhere, and SPACE and MIX near 5 Hz.
  The patterns are learned but the levels aren't, which limits how the app can use them.

## Session 2 (28–29 Sep): detectors, more music, live transfer

**Detecting sections from the trained neurons** (offline, spiking brain, rates smoothed over 4 s). AUC on the 2
held-out tracks:

| Intent | Untouched | Trained v1 |
|---|---|---|
| SPACE | 0.30 | 0.76 |
| MIX | 0.51 | 0.84 |
| PEAK | 0.66 | 0.87 |

**Detector thresholds**, picked on the training tracks and then scored on the held-out ones (F1):

| Intent | Detector | Trained | Untouched |
|---|---|---|---|
| SPACE | rank > 0.95 of the last 2 min | **0.46** | 0.00 |
| MIX | rank > 0.75 | 0.01 (doesn't transfer) | – |
| PEAK | ratio > 1.9 × 2-min average | 0.86 | 0.88 (the same; untrained works too) |

These were the single-fly detectors. The three-fly app later replaced them with a relative detector on the readout
(session 3): SPACE on in its top 10% of the last ~3 minutes, MIX in its top 20%, PEAK off in its bottom 25%.

**3× the music (v2)** didn't help. 16 seed/tempo/key variations → 18 train + 6 held-out tracks. On the same 6 held-out
tracks:

| | SPACE | MIX | PEAK |
|---|---|---|---|
| v2 | −0.02 | +0.39 | +0.41 |
| v1 | **+0.21** | +0.37 | +0.41 |

v1 stays active. v2 is kept as `brains/trained_brain_v2.npz`.

**Live transfer failed.** In the app, 10 min of v1 with section sense read from the on-air side of the brain:
- "breakdown sensed" was 0/34 correct (main 17, intro 11, build 6)
- PEAK-on was about chance (44% in main sections)

The leading hypotheses then were habituation, two different tracks at once (one per ear), and a mismatch between the
browser's ears and `flybrain/ears.py`. Session 3 tested all three.

## Session 3 (29 Sep): a readout, split ears, three flies

**Diagnostics.**
- **Habituation isn't the cause.** A live run with "ears hear room mix" (no habituation, the same sound in both ears)
  still sensed breakdowns at chance (14 of 149 onsets).
- **The ears match.** The browser's ears and `flybrain/ears.py` on the same track give matching means in all 24 bands
  (for example 0.60 against 0.60), with frame correlations of 0.5–0.9.
- **Averaging whole groups diluted the signal.** Only 50 of the 1,299 descending neurons fire during music. Picked one
  by one on the training tracks, single trained neurons are good section detectors on the 6 held-out tracks: DNp55
  for breakdowns, DNge145 and DNge113 for mixing windows, DNg24 for main sections.
- **A correction.** The first held-out AUCs of this session (SPACE 0.98, for example) used centred smoothing that
  peeks about 2 s ahead. With causal smoothing, which is all the app can do, the numbers are those in the table below.

**The readout** (`brains/readout.json`, built by `experiments/readout.py`). For each sense, a few descending neurons
of the trained brain per side (mostly trained ones), with z-score stats and on/off thresholds, all picked on the
training tracks. Held out, with causal smoothing:

| Sense | Neurons | AUC | F1 | Precision | Recall |
|---|---|---|---|---|---|
| SPACE | DNp55 (left, right) | 0.90 | 0.40 | 0.28 | 0.70 |
| MIX | DNge145 ×2 (left), DNp12, DNge113 (right) | 0.84 | 0.29 | 0.59 | 0.19 |
| PEAK | DNg24, DNg29, DNp18 (left); DNg24, DNge130, DNp01 (right) | 0.79 | 0.75 | 0.60 | 0.98 |

The saved file's smoothing (0.5–1 s) and its causal AUCs come from a later run than the script in the repo, which
smooths over 4 s.

**Split-ear training** (`train.py --split`): pairs of different tracks, one per ear, the second offset in time; each
side's neurons get their own ear's targets. Why: in split-ear mode one side of the brain alone is weak, and the other
ear's track bleeds in. Offline, the left-side readout went from the same track in both ears to split ears: MIX 49% →
19% of its on-time in intros (chance 17%), PEAK 64% → 61% (chance 50%), SPACE 13% → 12% (chance 8%).

Correlation on 6 held-out pairs, each neuron against its own ear's sections:

| | SPACE | MIX | PEAK |
|---|---|---|---|
| v1 before | +0.10 | +0.13 | +0.39 |
| split, round 1 | +0.00 | +0.06 | +0.49 |
| split, round 2 | +0.06 | +0.13 | +0.44 |

With one track per ear, these neurons can't separate breakdowns or intros even when trained that way. The result is
kept as `brains/trained_brain_split.npz`; v1 stays active.

**Three flies.** Every test so far said the trained sense works when a fly hears *one* track in both ears and falls
apart when one fly splits its ears between two decks. So each deck got its own listener fly hearing its deck in both
ears, and a third fly DJs, hearing the listeners' tapped neurons. Two more changes followed for live use:
- The listeners hear each deck's raw track, before the fly's own EQ, filter sweeps and bass kills. Otherwise the fly
  rewrites what its listeners hear, a feedback loop training never had.
- Live readout levels sit offset from the offline ones, so each listener ranks its readout against its own last
  ~3 minutes instead of using the offline thresholds.

Live, 150 s headless on the GPU (3 flies, trained brain):

| Measure | Result | Chance |
|---|---|---|
| MIX on-time that falls in intros | 67% | 25% |
| SPACE on-time that falls in breakdowns | 0% | 4% |
| Listener PEAK z in breakdowns | −2.06 | – |
| Listener SPACE z in breakdowns | −1.28 | – |

The listeners' neurons order the sections live, PEAK most clearly, but SPACE goes the wrong way: lower in breakdowns,
not higher. AUDIT.md (2 October) has the full picture over three runs.

## Section sense on real music (2–3 October)

The rank detector threw most of the signal away and ignored the bar grid (AUDIT.md, findings 1–3). Section sense v2
and v3 replace it with a classifier on the bar grid.

**Recording.** `tools/record_real.py` plays each of 131 real tracks to a listener fly on the GPU (16 tracks at a time,
the track in both ears) and saves every output neuron's rate per bar, on the bar grid of the app's own in-browser
analysis (`tools/analyze_tracks.mjs`). Trained and naive brains are recorded separately (`--brain`).

**The model** (`flybrain/sections.py`, trained by `tools/train_sections.py`, run live by `web/js/sections.js`):
1. Per bar, output neurons pooled by cell type (518 types), log rates normalised causally against the track so far,
   plus the previous 4 bars' mean.
2. A multinomial logistic regression (L2) to the sections.
3. An online HMM over the section order, with a song-position prior.

**v2: labels from energy.** Reference sections came from each track's energy profile (`label_track`). On 37 held-out
tracks (4,419 bars):

| | Accuracy | Macro-F1 |
|---|---|---|
| Always "main" | 0.66 | 0.20 |
| Song order + position only (no fly) | 0.69 | 0.31 |
| The fly's neurons only | 0.49 | 0.41 |
| Fly + song order (v2) | 0.72 | 0.54 |

Audit 2 then found that these labels favour the app's own analysis: a 2-feature detector on the app's per-bar energy,
with the same model and prior, scored 0.62.

**v3: labels from All-In-One.** The All-In-One structure analyzer (Kim & Nam 2023, trained on the human-annotated
Harmonix Set) labelled every track: intro / verse / chorus / break / outro. 5-fold cross-validation by track
(`data/realtracks/sections_cv_trained_allin1_*.json`):

| Features | Macro-F1 |
|---|---|
| Song position / order alone | 0.44 |
| The app's per-bar energy | 0.48 ± 0.02 |
| The fly's neurons | 0.50 ± 0.02 |
| Fused (neurons + energy) | 0.50 ± 0.02, kept |

The kept model (`brains/sections_trained.json`) was refitted on 107 tracks, leaving out the 24 that the benchmark
uses. Two caveats (AUDIT.md, Audit 4):
- These figures include the song-position prior. Without it, the fly's neurons score 0.31, below position alone.
- `train_sections.py` uses 1.96 over 5 folds and picks the penalty on the outer folds, so it isn't nested. The fair
  test below is.

Another known gap: the model trains on the in-browser beat tracker's bars, but live, an analysed track runs on the
All-In-One grid. Audit 4 counted only 59 of the 131 tracks agreeing in tempo and bar phase. That count used the grid
fit of the time (commit 1167539); the fit has changed since (5cc2bbc, 1fb7f0e), and it hasn't been recounted.

## The fair test: does the brain add anything? (3 October)

`tools/compare_sense.py` builds the same section model from five different inputs, with the same HMM and the same
5 outer folds by track. The penalty is chosen by an inner 4-fold search on the training folds only (nested), and
intervals are Student t over the 5 folds. Results in `data/realtracks/compare_sense.json`.

| Input | Macro-F1 | Accuracy |
|---|---|---|
| Song position + section order only | 0.442 ± 0.027 | 0.412 |
| The app's per-bar energy | 0.475 ± 0.024 | 0.462 |
| The fly's own ear input (the 24 Johnston's-organ band drives) | 0.485 ± 0.040 | 0.492 |
| The untrained brain's output neurons | 0.496 ± 0.028 | 0.518 |
| The trained brain's output neurons | 0.498 ± 0.026 | 0.518 |

Paired differences in macro-F1:

| Difference | 95% CI | Significant? |
|---|---|---|
| trained − naive | +0.002 ± 0.012 | no |
| trained − the fly's ear input | +0.013 ± 0.028 | no |
| trained − energy | +0.023 ± 0.031 | no |
| trained − position prior | +0.056 ± 0.036 | yes |

**What this says, plainly:**
- **Synapse training doesn't measurably help section sensing.** The trained and untrained brains score the same.
- **The brain doesn't beat its own input.** Reading the fly's output neurons is no better than reading the ear drive
  that goes into the brain.
- The neurons do carry real information about where a track is (they beat song position alone), but no more than the
  sound itself does.
- Every input's accuracy (0.41–0.52) is below always guessing "chorus" (0.56). Macro-F1 is the fairer measure with
  sections this unbalanced, but it shows how hard the task is.

## Next steps

From the audits (AUDIT.md), roughly in order:
- **Retrain the section model on the All-In-One grid** (re-record on it), then use `compare_sense` to decide whether
  the fly's neurons are worth the decision weight they carry.
- **Give the DJ fly no trained synapses, or train it for its own job.** It hears listener taps, input it was never
  trained on.
- **Train where the app runs:** record training data through the live pipeline (the listeners' real ear drive, with
  cue-backs, beat jumps and tempo changes), on the GPU (`gpu.py` runs 18 flies at once; `train.py` still records on
  the CPU).
- **Calibrate the rates:** an absolute-rate term in the fit objective, so PEAK stops saturating and MIX isn't stuck
  near 5 Hz.
- **Learn the DJ skills themselves:** a reward-modulated rule whose reward is DJ craft, so training shapes the move
  groups' timing, not just section recognition.
