# Training the fly brain to DJ

*Branch `fork/trained-brain`.* On `main` the connectome is never changed. Here, some of its synapses are trained.

## What the fly learns

A DJ's big decisions depend on where you are in a track. Four of the fly's own descending-neuron groups (the same
groups the app already listens to) were each trained to recognise one kind of moment:

| Intent | Neurons | Should fire during | What the app does with it |
|---|---|---|---|
| **SPACE** | DNp02 · DNp06 · DNp11 · DNp55 | breakdowns | echo and reverb throws |
| **MIX** | DNb06 · DNge113 · DNge145 | intros and outros (mixing windows) | gets ready to transition |
| **PEAK** | DNg24 · DNg29 | the full-energy main sections | flourishes, scratches |
| **BUILD** | DNp01 (giant fiber) | build-ups | rolls and builds |

The targets come from each track's arrangement: intro 8 · build 8 · main 16 · break 4 · main 8 · outro 4 bars.

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

## Results

The kept brain is `brains/trained_brain.npz`: the `fit` method, round 2, with BUILD's 962 synapses reset to the
connectome's original weights. The server loads it by default; `--brain naive` runs the untouched connectome.

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

### In the live app: where the fly acts

Headless runs of 8–10 minutes each, logging the section of the on-air track at every move and transition decision.
These trained runs used plain fit round 2, before BUILD was restored; that's why the giant fiber's rolls were almost
absent and the trained fly made fewer moves overall.

| | Untouched brain (8 min) | Trained brain (2 runs, 18 min) |
|---|---|---|
| Echo / reverb moves (SPACE neurons) in breakdowns or outros | **0 of 24** (build 12, main 9, intro 3) | **4 of 5** (break 3, outro 1, intro 1) |
| Transitions started in intros or outros | 0 of 14 | 0 of 6 |
| Total moves | 45 | 16 and 16: calmer |

**What changed:**
- **SPACE:** the trained fly saves its space moves for breakdowns, where a DJ puts them.
- **MIX:** its neurons learned to fire more in mixing windows (+0.38), but at ~5 Hz their bursts rarely clear the
  app's detection threshold, so transitions still start mid-track.
- **PEAK:** its flourishes fired in intros during the live runs, so that intent isn't doing its job yet.

### What didn't work

- **Fit round 3** stalled for about 2 hours (the Mac slept) and was stopped. Runs now use `caffeinate`.
- **Online fine-tuning from round 2 made it worse on the held-out tracks**, so it was not kept:

  | Learning rate | SPACE | MIX | PEAK |
  |---|---|---|---|
  | 0.3 (epoch 1) | +0.22 → −0.11 | +0.37 → +0.06 | +0.42 → +0.19 |
  | 0.05 (epoch 1) | +0.22 → +0.11 | +0.37 → +0.21 | +0.42 → +0.43 |

- **The fit method mis-calibrates firing rates:** PEAK ends near 120 Hz everywhere, and SPACE and MIX near 5 Hz.
  The patterns are learned but the levels aren't, which limits how the app can use them.

## Next steps

- Make MIX usable: detect its bursts relative to its own trained range (it tops out around 5–6 Hz), or add an absolute
  rate term to the fit objective.
- Regularise the fit toward the target *rates*, not just the pattern, so PEAK stops saturating.
- More and more varied training music: your own tracks with section labels. With 8 synthetic tracks, the held-out
  test is only 2 tracks.
- Repeat the live comparisons over several runs; the counts above are small.

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

**3× the music (v2)** didn't help. 16 seed/tempo/key variations → 18 train + 6 held-out tracks. On the same 6 held-out
tracks:

| | SPACE | MIX | PEAK |
|---|---|---|---|
| v2 | −0.02 | +0.39 | +0.41 |
| v1 | **+0.21** | +0.37 | +0.41 |

v1 stays active. v2 is kept as `brains/trained_brain_v2.npz`.

**Live transfer fails (open problem).** In the app, 10 min of v1 with section sense read from the on-air side of the
brain:
- "breakdown sensed" was 0/34 correct (main 17, intro 11, build 6)
- PEAK-on was about chance (44% in main sections)

The offline skill doesn't carry into the live app. Leading hypotheses:
1. **Habituation.** In split-ear mode the on-air deck's ear is turned down over ~75 s. SPACE learned "less sound =
   breakdown", so a habituating ear looks like a breakdown.
2. **Two different tracks at once.** Live, each ear hears a different deck; training always had the same track in
   both.
3. **Ear mismatch.** The browser's AnalyserNode versus `flybrain/ears.py`.

**Next steps:**
- Finish the diagnostic started when the session ended: rerun `livetest` with "ears hear room mix" (no habituation,
  same sound in both ears).
- If sensing works there, train under live conditions: two tracks, one per ear, with habituation applied to the drive
  in `train.py`.
- Or remove habituation from the drive and move it into the DJ logic.
