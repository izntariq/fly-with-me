# Audit: how good is the trained fly as a DJ, and how to make it better

*2 October 2026, branch `fork/steady-mix`.* This covers the whole chain: the training music, the training method,
the offline scores, how the app turns trained signals into decisions, the three-fly setup, and live results.
Every number comes from runs recorded in `docs/TRAINING.md`, the session logs, or the three-brain comparison of
2 October.

## Verdict

**The trained neurons learned something real, and it survives into the live app. The app then mostly throws it away.**

Live, the listener flies' trained neurons separate the sections consistently, run after run. PEAK neurons drop by
1–2 SD in breakdowns, and MIX neurons are highest in intros. But the detectors that turn those levels into on/off
decisions land at about chance, except one good run. And the decisions that matter most to a DJ (when to mix, which
move, where) mostly don't use the trained signals at all.

So the biggest gains are in the **decision layer**, not in more training. Training improvements come second, and the
largest of those is to train under the exact conditions the app runs in.

## How the trained fly works today

```
deck A raw cue -> ears -> listener fly A (trained synapses) --+-- trained readout neurons -> rank detector -> sense: SPACE / MIX / PEAK
deck B raw cue -> ears -> listener fly B (trained synapses) --+-- 12 DN taps -> DJ fly's ear bands
                                                                          |
                                       DJ fly (also trained synapses) -> DN bursts -> moves; L/R steering -> transitions
```

| Decision | What drives it | Trained? |
|---|---|---|
| Echo / reverb in breakdowns | the SPACE sense (listener readout) | yes |
| Mixing window (allows an early transition) | the MIX sense | yes |
| Flourishes such as scratches, allowed only when PEAK is on | the PEAK sense | yes |
| Which move, and when | bursts in fixed DN groups of the DJ fly (artistic mapping, ratio + cooldown) | no |
| Whether and where to transition | DJ fly L/R steering bias, ear habituation, track ending, minimum time on air | no |
| Transition style | which DN group is most excited | no |
| Build & drop | a surge across all descending neurons | no |
| Next track | the listener's DN response while previewing | no |

## Scorecard

| | Offline (2 held-out tracks, spiking brain) | Live (three-fly app, headless, 3 runs of 2.5–10 min) |
|---|---|---|
| SPACE (breakdowns) | AUC 0.90, F1 0.40 (precision 0.28, recall 0.70) | on in breakdowns 6% / 0% / 17% of its on-time (chance 3% / 4% / 8%); readout level is *lower* in breakdowns |
| MIX (intros / outros) | AUC 0.84, F1 0.29 (precision 0.59, recall 0.19) | 20% / 67% / 0% (chance 7% / 25% / 10%); readout level *is* highest in intros |
| PEAK (main sections) | AUC 0.79, F1 0.75 | 58% / 52% / 54% (chance 56% / 52% / 53%); readout −0.6 to −2.1 SD in breakdowns |
| Transitions started in intros / outros | – | 0 of 2 in the last run (earlier: mostly mid-track) |
| Track held on air | – | 46–80 s since the minimum-time fix |

## Findings

**1. The signal survives live; the detector loses it.** *(high impact)*
- Mean listener z by section, over the three live runs:
  - PEAK in breakdowns is −1.06 / −2.06 / −0.61, against +0.19 to +0.69 in main sections.
  - MIX is highest in intros every run (+0.09 / +0.16 / +0.45, against about −0.4 in main sections).
- The detector ranks the current value against the last ~3 minutes and fires above a fixed percentile (MIX top 20%,
  SPACE top 10%). That forces each sense to be on a fixed share of the time whatever the music, so on-rates and
  accuracy swing from run to run.
- It also needs 30 s of history before it works at all.
- The 3-minute window spans about two tracks, so one track's levels set the bar for the next.

**2. SPACE goes the wrong way live.**
- Trained to rise in breakdowns, the SPACE readout (DNp55) is *lower* in breakdowns in 2 of 3 live runs.
- The offline AUC of 0.90 doesn't transfer, likely because training used one fly hearing a whole track, while live
  the listener hears a raw cue that is beat-jumped and cued back.
- PEAK-low is the strong live breakdown cue, and it isn't used yet.

**3. The sense ignores the musical grid.**
- Sections change on 4- and 8-bar lines, and the app knows the beat grid exactly. The detector still decides every
  20 ms with smoothing of 0.5–1 s, so it flickers inside a section.
- No order is enforced either. Tracks go intro → build → main → break → main → outro, and the sense can jump
  anywhere.

**4. Only a thin slice of the DJ is trained.**
- Training changed the 9,978 input synapses of 25 neurons, for section *recognition*. Move choice, transition timing,
  transition style and track picking come from untrained burst detectors and steering.
- So training can't make the fly mix at the right moment or pick better moves.
- In the live A/B, the trained and untrained FlyWire flies made a similar number of moves (6 vs 7) and transitions
  (2 vs 1).

**5. The DJ fly is trained for the wrong input.**
- All three flies load the same trained synapses.
- The listeners hear music, as in training. The DJ fly hears the listeners' 12 DN taps mapped onto its ear bands,
  input it was never trained on. Its trained synapses are at best irrelevant, at worst noise.

**6. The training music is narrow.**
- 8 synthesized demo tracks plus 16 seed / tempo / key variants. They all share **one arrangement**:
  intro 8 · build 8 · main 16 · break 4 · main 8 · outro 4 bars.
- The held-out test is 2 tracks (6 with variants) on the same template.
- The fly may have learned "where in this template am I" from sound textures specific to the generator. Nothing has
  been tested on real music.

**7. Training and live conditions still differ.**
- Training used the Python ear model, one track per fly, with no cueing, beat jumps, EQ moves or tempo changes.
- Live, the raw cue is jumped by cue-backs, hot cues and loop rolls, and tempo follows the master.
- The rank detector was tuned on neither condition.

**8. Firing rates are mis-calibrated.**
- The fit method learned the patterns but not the levels: PEAK sits near 120 Hz, SPACE and MIX near 5 Hz.
- Low-rate neurons give noisy, Poisson-dominated estimates over a 0.5–1 s window, which is a direct cause of
  MIX's low recall (0.19).

**9. BUILD can't be learned from sound.**
- Measured before training: the best possible linear readout gets r = 0.16. A build-up sounds like the main section
  moment to moment, so knowing "a drop is coming" needs memory.
- The app already knows the drop positions from its track analysis but doesn't let the fly use them.

**10. The evaluation is too thin to steer by.**
- Single 2.5–10 minute runs give per-section counts in the single digits to tens, and results swing more between
  runs than between brains.
- There's no fixed benchmark, no repeated runs, no confidence intervals, and no real tracks.
- Headless Chrome runs at a different load than the user's Safari.

## Improvement plan

Ordered by expected impact for the effort. Each step says how to measure it.

### Now: the decision layer (hours, no retraining)

1. **A calibrated section classifier on the listener readouts.**
   - Record the three readout z-traces (SPACE, MIX, PEAK) from the live app over many runs, with the true section
     logged; `tools/livetest.mjs` already logs both.
   - Fit a small classifier (multinomial logistic) from [z_SPACE, z_MIX, z_PEAK, their 4-bar means and slopes] to the
     section.
   - It learns PEAK-low = breakdown (finding 2) and MIX-high = intro (finding 1) directly, with no hand-set
     percentiles (finding 1).
   - *Measure:* per-section precision / recall over 5 runs, against the current detector.
2. **Decide on the bar grid.** Accumulate evidence per bar and commit decisions on 4-bar lines, with a minimum
   section length of 4 bars (finding 3).
3. **An arrangement prior.**
   - An online HMM over intro → build → main → break → main → outro.
   - Transition probabilities come from bar counts. The classifier's per-bar likelihoods are the emissions.
   - Forward filtering gives the current section with a confidence that the app can gate on (finding 3).
4. **Wire the sense into the decisions that matter** (finding 4):
   - start transitions only in a sensed intro or outro (with the minimum on-air time as a floor)
   - save space moves for sensed breakdowns
   - allow scratches and builds in sensed main sections
   - *Measure:* the share of transitions starting in intros / outros (target: most), and moves by section.
5. **Let BUILD use time.** The HMM's position within a section is the memory that sound alone lacks (finding 9). A
   build is "the 8 bars before a predicted main".

### Next: training that matches the app (days)

6. **Record training data through the live pipeline.**
   - Run the GPU server headless with the real app, logging each listener fly's ear drive (exactly as the browser
     sends it) plus the true section.
   - Train on those drives, so the ear-model differences and cue manipulations are in the training set
     (findings 2 and 7).
7. **Give the DJ fly no trained synapses, or train it for its own job** (finding 5).
   - Load the untouched connectome into the DJ fly, and A/B its move placement.
   - Later, train its input synapses on recorded listener-tap drives.
8. **Calibrate the rates.**
   - Add an absolute-rate term to the fit objective: section on ≈ 30 Hz, off ≈ 5 Hz.
   - Train the six readout neurons directly instead of whole intent groups (finding 8).
9. **Vary the arrangement.**
   - Randomise section lengths and orders in the demo generator (no fixed 8/8/16/4/8/4 template).
   - Add real tracks with hand-labelled sections, and hold out whole tracks (finding 6).
10. **Train on the GPU.**
    - `flybrain/gpu.py` steps many flies at once (18 flies at 1.9 s per brain-second), so recording 18 tracks in
      parallel makes a training round minutes instead of hours.
    - That makes repeated fits, cross-validation and online-rule experiments practical.

### Later: learn the DJ skills themselves (research)

11. **Reward-modulated learning of moves.**
    - The three-factor rule, with a reward from DJ craft: a move that lands on a phrase line in the right section,
      a transition into an intro, no clash of key or tempo.
    - That trains the move groups' *timing*, not just the section sense.
12. **Learn transition style from the two listeners together.** Train the DJ fly to prefer drop-swaps when both
    decks are near a drop, and blends when both are in intros or outros. It already hears both listeners.

### Throughout: a benchmark

13. **`tools/djbench`:**
    - a fixed crate (demo plus labelled real tracks)
    - N = 5 runs × 10 min per brain, on a spare port
    - output: section-sense precision / recall, transitions starting in intros / outros, moves by section, time on
      air, load
    - mean ± 95% confidence interval, saved as JSON so every change is compared on equal terms (finding 10)

## The three most valuable changes

1. Replace the rank detector with the calibrated classifier + bar grid + arrangement prior (items 1–3). This is the
   cheapest change and uses signal that is already there.
2. Make transitions wait for a sensed intro or outro (item 4). That is the most audible DJ skill the fly lacks.
3. Build the benchmark (item 13) before any retraining, so improvements can be told from run-to-run noise.
