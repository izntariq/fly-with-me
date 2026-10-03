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

## Results: section sense v2 (2 October)

Items 1–4 and 13 are built:
- `flybrain/sections.py` and `web/js/sections.js`: the classifier, bar grid and arrangement prior
- `flydj.js`: mixing gated on the sensed section; the incoming track cued to its intro
- `tools/djbench.mjs`: the benchmark

The model was trained on **131 of the user's own real tracks** (pop, house, techno, indie). The fly listened to every
track on the GPU (`tools/record_real.py`), and reference sections came from each track's energy profile
(`label_track`).

**Offline**, on 37 held-out tracks (4,419 bars):

| | Accuracy | Macro-F1 | Breakdown P / R | Outro P / R |
|---|---|---|---|---|
| Always "main" | 0.66 | 0.20 | – | – |
| Song order + position only (no fly) | 0.69 | 0.31 | – | – |
| The fly's neurons only | 0.49 | 0.41 | 0.34 / 0.53 | 0.27 / 0.37 |
| **Fly + song order (v2)** | **0.72** | **0.54** | 0.49 / 0.47 | 0.87 / 0.28 |

**Live**: the full app, headless, 3 runs × 8 min per sense on the held-out tracks, mean ± 95% CI.

| | v1 (rank detector) | **v2** |
|---|---|---|
| Mixing-window sense, precision | 0.14 ± 0.04 | **0.77 ± 0.29** |
| Mixing-window sense, recall | **0.37 ± 0.30** | 0.05 ± 0.02 |
| Breakdown sense, precision / recall | 0.32 / 0.15 | 0.32 / **0.31** |
| Main sense, precision / recall | 0.74 / 0.94 | 0.76 / 0.89 |
| Transitions started in an intro / outro | 0.04 ± 0.08 | **0.21 ± 0.12** |
| Transitions started mid-main | 0.71 ± 0.22 | 0.74 ± 0.10 |
| Echo / space moves in a breakdown | 0.27 ± 0.04 | 0.20 ± 0.08 |
| Time on air per track | 52 s | **74 s** |
| Moves in 8 min | 58 | 26 |
| Load | 0.78 | 0.72 |

**What it means:**
- v2 is much more precise about mixing windows: when it says intro or outro, it's right about 77% of the time,
  against 14%. It finds twice as many breakdowns, and the fly is steadier and calmer.
- It mixes from an intro or outro 5× as often (21% against 4%), but most transitions still start mid-main. The gate
  leans on the breakdown sense (precision about 0.32) and on the 3-minute cap, because live the outro is rarely
  called (recall 0.05).
- Next: calibrate the decision thresholds per section on the training tracks instead of a flat 0.55 posterior, which
  is too strict for outros. Open the mixing gate in the last third of a track when the sense isn't "main", which is
  how a DJ reads the deck's remaining time. Then re-run the benchmark.

Two bugs found by the benchmark and fixed:
- a cut didn't restart the time-on-air clock, so the fly could cut repeatedly
- a deck cued back to its intro kept its old section state

## Audit 2: section sense v2 and the benchmark (2 October)

**1. The reference labels favour the app's own analysis.**
- Sections are labelled from each track's energy profile. A 2-feature detector on the app's own per-bar energy, with
  the same model and prior, beats the fly's neurons on the held-out tracks: macro-F1 **0.62 against 0.54**, outro
  recall 0.45 against 0.24.
- Fly + energy combined scores 0.57 overall, and best on breakdowns (P 0.54 / R 0.59, against 0.49 / 0.47 for the
  fly alone).
- As measured, the fly adds some skill on breakdowns and is otherwise a noisier sensor of what the app already
  computes. A fair test needs labels that aren't defined by energy: hand-marked sections on 20–30 of the user's
  tracks.

**2. The mixing gate leaks.**
- An instrumented 10-minute run gave 4 mixes, 3 of them mid-main:
  - 2 came from false breakdown senses (posterior 0.56 and 0.69; live breakdown precision is about 0.32), and 0.55
    is too low a bar to act on
  - 1 came with the sense at main / 0.99, the track not ending and under 3 minutes on air. None of the gate's
    conditions explain it, so the decision code needs a reason trace
- Only 1 of the 4 was a correct breakdown mix.

**3. The live mixing-window recall (0.05) is mostly a measurement artefact.**
- The on-air deck's intro plays mostly during the blend, before that deck counts as on air.
- After cue-to-intro the sense restarts, with 4 warm-up bars at z = 0.
- The fly mixes out before outros come.
- The benchmark should score the sense on both decks (each listener senses its deck all the time), not just the
  on-air one.

**4. A lower cutoff won't rescue outros.** Offline, the outro posterior rarely rises: dropping the cutoff from 0.55 to
0.2 only lifts recall from 0.24 to 0.32 (precision stays 0.97). Intros improve more (0.23 → 0.42 at precision 0.78).
Breakdowns trade precision for recall almost one for one.

**5. The benchmark is too thin to diagnose with.**
- 5–8 transitions per 8-minute run, so the confidence intervals are wide.
- Saved results keep only summaries (no raw events).
- Transitions are labelled when scheduled, not when they happen.
- The "space moves in breakdowns" metric mixes sense-driven moves with untrained echo-group bursts.
- Moves halved with v2 (58 → 26), and nothing recorded says which.

**6. Still open from the first audit:**
- the DJ fly still carries synapses trained for music, though it hears the listener taps
- no naive-brain version of v2 exists to show whether the synapse training helps at all
- the offline score is one fixed 25% split, with no cross-validation or confidence interval

**Checked and fine:**
- train / live feature definitions match: rates pooled by type, log, causal z with a 4-bar warm-up, 4-bar context,
  and the same HMM
- loop rolls and backspins play on a separate source and don't move the playhead, so they don't reset the sense

### Fixes, in order
1. **Gate:**
   - mix from a breakdown only at posterior ≥ 0.85, held for 2 bars, in the second half of the track
   - keep outro-gated mixing
   - log a reason with every scheduled transition
2. **Fuse the app's energy analysis into the sense** (fly + energy features, energy properly weighted). The fly's
   neurons then add where they help, at breakdowns.
3. **Fair ground truth:** hand-mark sections on 20–30 tracks, and rerun both the offline evaluation and the
   benchmark against them.
4. **Benchmark v2:**
   - save raw events
   - label transitions when they happen
   - score both decks' sense
   - separate sense-driven moves from burst moves
   - 5 runs
   - 5-fold cross-validation offline
5. **Record a naive listener and train v2 on it**, to answer whether the trained synapses help. Load the untouched
   connectome into the DJ fly.

## The approach chosen after research, and its results (3 October)

**Research.**
- Real DJ mixes (Kim et al., ISMIR 2020, 1,557 mixes):
  - transitions follow 32-beat phrases
  - cue points follow song structure, consistently across DJs
  - about 4 minutes per track
- DJ practice: effects with a purpose, on the phrase, one at a time, with variety. Overuse and repeating the same
  trick are the classic mistakes.

So "fewer moves" is the wrong target. The benchmark now scores craft: where moves land, whether they fit the
section, variety, pace, where mixes happen, and time on air.

**Fair labels.** The All-In-One structure analyzer (Kim & Nam 2023, trained on the human-annotated Harmonix Set)
labelled all 131 tracks: intro / verse / chorus / break / outro.

5-fold CV macro-F1:

| Features | Macro-F1 |
|---|---|
| Song position / order alone | 0.44 |
| The app's energy analysis | 0.48 ± 0.02 |
| **The fly's neurons** | **0.50 ± 0.02** |
| **Fused** | **0.50 ± 0.02**, kept |

Judged against human-style structure, the fly's brain edges out the energy analysis.

**Benchmark.** The full app, 24 held-out tracks the model never saw, 3 runs × 8 min each, mean ± 95% CI.

| DJ craft | Old | **New** |
|---|---|---|
| Mixes from an outro / breakdown / intro | 0.16 ± 0.06 | **0.69 ± 0.38** |
| Mixes mid-song | 0.84 | **0.31** |
| Moves starting on a 4-bar line | 0.08 ± 0.02 | **0.86 ± 0.05** |
| Moves that suit their section | 0.52 ± 0.07 | **0.66 ± 0.03** |
| Variety (normalised entropy) | 0.89 | **0.92** |
| Same move back to back | 0.20 | **0.02** |
| Moves per minute | 9.7 ± 2.7 | **4.0 ± 0.6** |
| Time on air per track | 54 s | **130 s** |
| Intro / outro sense, precision / recall (both decks) | 0.14 / 0.35 | **0.45 / 0.75** |
| Breakdown sense, precision / recall | 0.04 / 0.47 | **0.18 / 0.79** |
| Chorus sense, precision / recall | 0.53 / 0.83 | 0.70 / 0.47 |
| Load | 0.76 | 0.77 |

**Still short of a professional:**
- Pace: 4 moves a minute is still busier than the "not every 30 seconds" guidance.
- Tracks get about 2 minutes on air, against about 4 in real mixes.
- Breakdowns are sensed with low precision.
- Mixing metrics rest on few transitions per run, hence the wide intervals.

Next: a phrase-level move budget (about one move per 8–16 bars, more in choruses), a longer default minimum time on
air, and more runs.

### Pace: a moves-per-minute target, and a listening bug fixed (3 October)

4 moves a minute felt too low for a showcase DJ, and that count excludes builds, horns and filter rides.

- **A target pace** ("moves per minute" slider, default 8). The burst threshold adapts slowly (homeostasis) until
  the fly's moves reach the target. Moves are still fired by its strongest neuron bursts, queued up to 3, and played
  on bar lines: every bar in choruses / main sections, every 2 bars elsewhere.
- **The listener flies went deaf during moves.** Loop rolls, scratches, tape stops and chops mute the deck's main
  signal while the track slips underneath, and the listener tap sat after that mute. Every such move fed the
  listeners silence, which reads as a breakdown. The tap now comes before the slip mute.

2 runs × 6 min on the 24 held-out tracks, target 8 a minute:

| | 4 / min (previous) | 9.5 / min, deaf bug | **9.5 / min, fixed** |
|---|---|---|---|
| Moves per minute | 4.0 | 9.5 | **9.5 ± 0.3** |
| Section accuracy (both decks) | 0.50 | 0.37 | **0.50** |
| Breakdown sense precision | 0.18 | 0.11 | **0.38** |
| Mixes from outro / breakdown / intro | 0.69 | 0.29 | **0.58 ± 0.16** |
| Moves fitting their section | 0.66 | 0.54 | **0.65** |
| Variety / back-to-back repeats | 0.92 / 0.02 | 0.86 / 0.04 | 0.83 / 0.07 |
| Time on air | 130 s | 82 s | **126 s** |

## Audit 3: pace, palette and mixing, from the raw benchmark events (3 October)

**1. The move palette is narrow; the variety score flatters it.**
- In the latest runs (114 moves), the echo family (echo / dub / reverb) makes up 55% and loop rolls 26%. Trans gates,
  filters and wind make up the rest.
- **Scratches: zero.** None of the bigger moves (chops, stutters, drums out, acid, tease, pump) appear either.
- The variety score (0.83) counts echo, dub and reverb as different moves. At the level of move families it's low.
- Cause: the adaptive threshold lowers every group's bar equally, so the group that bursts most (the echo group,
  DNp02 / 06 / 11 / 55) wins most slots. Scratches are gated on a confident chorus, and in verses they're remapped
  to trans gates. The big moves only come from a DJ style's own move lists, and the default style has none.

**2. Mixes never come from a sensed outro.**
- Every scripted mix in the new runs (12 of 13) went through "wants to leave + senses a breakdown"; the other one was
  "track ending".
- The outro route never fired. The fly leaves earlier, on breakdown senses, about 40% of which land in a verse or
  chorus, even at posterior ≥ 0.85 held for 2 bars.
- So "mixes from calm sections" rests on the weakest sense (breakdown precision 0.38). Meanwhile the outro is sensed
  well offline (P 0.63 / R 0.81).
- This is also why tracks get about 2 minutes on air instead of about 4.

**3. The pace control under-counts.** It counts only queued neuron moves, not sense-driven ones, so it overshoots
(9.5 a minute against a target of 8). At the threshold floor (0.25), cooldowns shrink to a quarter, which lets one
group repeat within a bar or two.

**4. Benchmark caveats:**
- The reference sections are All-In-One predictions (state of the art, but not human labels of these songs).
- The "fits its section" table is my own and overlaps the fly's SECTION_FIT table, so it partly grades itself.
- Only 2–3 runs, with about 2–4 mixes per run. Mixing metrics have wide intervals.

**5. Still open:**
- Does the synapse training help v3? (No naive-brain v3 yet.)
- The DJ fly still carries synapses trained for music.
- The new features haven't been tried in Safari.
- No section model for the male CNS.

**Checked and fine:**
- the slip-mute fix covers every move that ducks the deck
- moves fire on the last beat before their bar line, as designed
- a cut restarts the time-on-air clock
- the queue drops stale moves
- the visualiser still sees every move (they all go through the Performer)

### Fixes, in order
1. **Mix outro-first.**
   - When the fly wants to leave early, it waits for its sensed outro, or the end of the last chorus (a chorus
     ending in the last third).
   - The breakdown route only applies in the last quarter, at ≥ 0.9.
   - Expected: more mixes in outros, and time on air nearer the ~4-minute norm.
2. **Real variety.**
   - Per-group fairness in the adaptive threshold: groups that fired a lot recently need a bigger burst.
   - Scratches allowed in choruses and verses.
   - The big-move vocabulary (chops, stutter, drums out, tease, pump, acid) as phrase-level moves on 8 / 16-bar lines,
     where they fit.
   - The benchmark scores variety by move family.
3. **The pace counts every move,** with a cooldown floor of 2 bars per group.
4. **Benchmark:** 5 runs × 12 min, family-level variety, mix reasons in the summary.
5. **Then the open questions:** naive vs trained v3, the DJ fly's synapses, Safari.
