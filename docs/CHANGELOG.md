# Changelog

Every version from the first line of code. Times are local (PDT), from 27 September to 5 October 2026. Each entry
names the commit, so `git show <id>` gives the full notes and diff. Versions with a `vX.Y` tag are the milestones of
the first night. The work after v1.11 is grouped by theme.

> In the public repository, the work after v1.12 is published as one commit per theme (tag v2.0.0). The
> commit ids named after v1.11 below are from the development history, which isn't published.

---

## v0.1 — whole-brain fly simulator · `1d3c4d1` · Sep 27 22:04
- Numba rewrite of the Shiu et al. 2024 leaky integrate-and-fire model on the FlyWire v783 connectome (138,639 neurons,
  15,091,983 connections), with the same equations and parameters as the paper.
- Exact exponential integration at dt = 0.25 ms, a delayed-synapse ring buffer, refractory periods, and Poisson
  drive whose per-neuron rate can change at any moment.
- **Validated** against the paper's sugar experiment: ~406 active neurons, ~20k spikes/s, feeding motor neurons firing.
- About 0.6 s of compute per simulated second.

`dc10e58` · 22:06 — Claude Code permission allowlist for read-only commands.

## v0.2 — senses and outputs · `25a3327` · 22:09
- Inputs chosen by real cell type from the FlyWire annotations: 12 Johnston's-organ (ear) subtypes per side, wind
  neurons, sugar and bitter taste neurons.
- Outputs: all 1,409 descending and brain motor neurons.
- Positions of every neuron, for the brain map.
- Measured along the way: loud sound → giant fiber (the escape neuron); the ears are strongly lateralized; smell input
  makes the brain run away.

## v0.3 — real-time server · `1adb815` · 22:10
- aiohttp + WebSocket server that runs the brain in 20 ms frames locked to wall-clock time.
- Runaway guard: resets the brain after 3 frames above 600k spikes/s.

## v0.4 — parallel kernel · `3774830` · 22:11
- Integration runs in parallel. 2.5× faster (about 4× faster than real time) and gives *identical* spikes.

## v0.5 — the Fly Brain DJ app · `9dff33c` · 23:46
- Two decks with EQ, filter, loop roll, echo, backspin and an equal-power crossfader.
- Fly ears: deck A → left Johnston's organ, deck B → right, with habituation.
- Fly synth: every descending/motor neuron is a key.
- Fly DJ: the crossfader follows left/right brain activity; named neurons trigger moves; bass-swap blends.
- Whole-brain spike map, output raster and event log.

`b7b5f83` · Sep 28 00:25 — demo tracks synthesized sample by sample: 76 s → under 1 s.
`9480108` · 00:28 — DJ pacing: warm-up, minimum time on air, calmer effects.
`cb80b82` · 00:40 — bitter drive capped at 100 Hz (it caused runaway); debug handle `window.flyDJ`.

## v1.0 — first complete version · `826d453` · 00:52
- `run.sh` launcher (downloads the data), README, requirements, `.gitignore`.
- Sugar makes the fly "sing".
- 4-minute soak test: 4 beat-matched transitions, no errors, half of real-time CPU.

`b507e04` · 00:57 — burst detectors tuned so effects fire every ~8–12 s around musical events.

## v1.1 — desi beats · `81fbfea` · 01:38
- Four synthesized desi tracks:
  - bhangra dhol *chaal*, 116 BPM, raag Kafi
  - tabla *keherwa* theka, 120 BPM, Yaman
  - dholak, 118 BPM, Bhairav
  - Bollywood disco, 124 BPM, Khamaj
- Karplus-Strong tumbi, sitar (with *meend* glides and *jawari* buzz) and tanpura; harmonium; dhol and tabla strokes.
- Raga scales; the fly plays **dhol with its motor neurons and sitar with its descending neurons** when a desi track is
  on air.
- Crate style selector (desi / club / both).

`660e1b7` · 01:45 — performance: Safari's drawing was eating ~10 cores and starving the brain. Drawing made lighter,
simulator moved to 4 threads.
`ead2b90` · 01:51 — the chimta removed; the tumbi hook softened, and it only plays half the time.

## v1.2 — epic DJ · `d987ff8` · 02:06
- Master FX rack: sweeps, trans gate, crush, flanger, reverb.
- Sampler: air horn, siren, laser, boom, riser, dhol roll.
- Scratching: baby, chirp, transformer, flare. Also tape stop, hot cues and beat jumps.
- Carl Cox style **cue build & drop**, drop swap, echo out, spin cut.
- The fly picks the transition style from its most excited neuron group; a whole-brain arousal surge triggers a build.
- Performance pads, keyboard shortcuts, epicness slider.

## v1.3 — tempo control · `841d083` · 02:09
- Master BPM that both decks follow, phase-locked.
- −/+ buttons and keys, tap tempo, reset.
- "Fly rides the tempo": arousal can push it up to ±6%.

`1362da8` · 02:12 — the fly waits 15 s before its first move; crate "next" label fixed; README lists every move.

## v1.4 — the fly chooses tracks · `745d59b` · 02:18
- The fly previews up to 3 candidates in its cue ear and scores each by descending-neuron spikes/s.
- The winner loads from its intro; tracks it has already played are marked down.

## v1.5 — adapting to new music · `cc47e0f` · 02:22
- Analysis of every new track: key (Camelot code), style, energy per bar.
- The fly's voice follows the key, and its move set follows the style.
- Breakdowns get space instead of chops; builds are timed to land on the track's real drop.
- Cuts instead of blends when tempos are far apart; tempo journeys; harmonic track picking.

`3aae162` · 02:26 — git switched on; local Claude settings ignored.
`87b2efb` · 02:27 — drum & bass no longer detected at half tempo; ½× / 2× fix buttons on each deck.
`b027f9b` · 02:27 — README: how the fly adapts to new music.

## Docs — this changelog, git explainer, project notes · `bd7939a` · 05:38
The history was rebuilt from the session transcript (see [GIT.md](GIT.md)), and the project notes, this changelog and
the git explainer were added.

## v1.6 — play like the big names · `7d9454b` · 06:01
- Research into 29 DJs, with sources in [DJ_RESEARCH.md](DJ_RESEARCH.md): Guetta, Garrix, Tiësto, Calvin Harris,
  Swedish House Mafia, DJ Snake, Skrillex, Diplo, Aoki, Armin, Alok, Nucleya, Fred again.., Carl Cox, Hawtin,
  de Witte, Lens, Peggy Gou, Black Coffee, Solomun, Four Tet, Jamie xx, Prydz, Fisher, John Summit, Kaytranada,
  Qbert, A-Trak, Jazzy Jeff.
- **"Play like…" styles.** The neurons decide when; the style decides which moves, transitions, builds, blend
  length, time on air, home tempo and hype. The brain itself is unchanged.
- **New moves:**
  - Fred again.. live chops, with the pattern written by spikes
  - Guetta's live 303, also written by spikes
  - sing-along drop-out
  - Fisher's 1-bar kill
  - double drop, mashup, Hawtin loop layering, dub throw and Model 1 resonant filter
  - Alok's sidechain pump and the Pryda snare fill
  - Skrillex stutter, reverse, bass tease, hard cut
  - Qbert's crab and orbit scratches
  - CO2 blast, snare-roll / stutter / filter builds, downlifter
  - mids-only reverb, as Swedish House Mafia do it
- A build-style selector and pads for everything.

## v1.7 — stems · `6226f87` · 06:18
- Every deck gets drums and music stems:
  - demo tracks are rendered as stems
  - dropped files are split by harmonic–percussive separation in a web worker (~5 s for 90 s of audio; the stems
    add back up to the original exactly)
- DRUMS / MUSIC mutes on each deck.
- New moves: *drums out* and *strip to drums*. Mashups, loop layers and live chops now use the stems.

## v1.8 — set planner · `801ce2d` · 06:34
- Energy arcs for a whole set: club night, warm-up, peak time, Guetta's yo-yo, Diplo's pop → heavy → pop,
  Kaytranada's beat tape, closing.
- While a set runs:
  - epicness follows the arc, and track picks match its intensity
  - the tempo leans with it
  - builds happen at peaks, breakdowns in dips
- Live graph of the plan and of what the fly actually did.

## v1.9 — the fly on the mic, set export · `4325865` · 06:40
- Speech-synthesis MC with per-style lines ("Balle balle!" for desi); the fly's spikes pick the phrase.
- Markdown set report: tracklist with how each track came in, move counts, full log.
- Builds default to the chosen style's build.

## v1.10 — key lock · `3097382` · 06:46
- AudioWorklet pitch shifter per deck, so tempo no longer changes pitch (440 Hz stays at 441 Hz at +12% / −10%).
- `40b8140`: with key lock on, styles can move the tempo up to 20% and blends can span 16%.
- `e476584` · 06:47: README, notes, changelog and research updated for stems, the set planner, the MC, set export and
  key lock.

## v1.11 — a clean key lock · `c1ef55d` · 06:58
Key lock is on by default and nearly everything plays slightly sped up or slowed down, so the shifter shapes all the
audio.
- The two-head shifter is replaced by **WSOLA**: grains are aligned by cross-correlation, so hits aren't doubled.
- Measured A/B:

  | | Kick tightness (52% unprocessed) | 440 Hz tone at 0.9–1.12× |
  |---|---|---|
  | Old | 45.7–48.5% | 440.8–441.4 Hz |
  | WSOLA | 50.6–53.5% | 440.1 Hz |
- `b57f4a4` · 07:04: latency compensation. Decks schedule everything that happens before the shifter 24 ms early, so
  key-locked decks land on the beat grid with rolls, scratches, the synth and the sampler. Deck-vs-grid offset:
  24.7 ms → 0.7 ms.

---

*Everything below is on `fork/steady-mix` (the training work started on its own branch, now
`fork/trained-3flies-gpu-visualiser`, which this line continues).*

## Training the fly (28–29 September)

### Trained synapses · `f5a443f` · Sep 28 20:00
- Four DJ intents, each on a real descending-neuron group: SPACE (breakdowns), MIX (intros and outros), PEAK (main
  sections), BUILD (build-ups).
- Only the 9,978 existing synapses onto those 25 neurons change. Signs are kept (Dale's law) and magnitudes bounded.
- Two methods in `flybrain/train.py`: an online three-factor rule (the error plays the role of dopamine) and a
  model-based fit.
- `flybrain/ears.py` ports the app's ears to Python, so training hears what the app hears.
  `tools/export_demo_tracks.mjs` renders the demo tracks with their section labels.
- Measured first: SPACE, MIX and PEAK can be read out of the sound; BUILD can't (r = 0.16), because a build-up sounds
  like the main section moment to moment.
- The server loads `brains/trained_brain.npz` by default; `--brain naive` runs the untouched connectome.

`09b4d74` · 22:02 — kept fit round 2, with the giant fiber's 962 synapses reset (training BUILD silenced the rolls).
On 2 held-out tracks: SPACE −0.23 → +0.21, MIX 0.00 → +0.38. Online fine-tuning made it worse and wasn't kept.
`train.py` gets `--init` and `--freeze`, and a MIX burst opens a 32-beat mixing window.
`e0a1a1e` · 23:44 — section sense from the trained neurons on the on-air side of the brain. Retrained on 3× the music
(seed / tempo / key variations): no better, so v1 stays.
`42a5967` · Sep 29 00:01 — TRAINING.md: session 2, including the failed live transfer.

### A readout, and split ears · `abcbf31` · 03:38, `2867c75` · 04:30
- Diagnostics ruled out habituation and the ears. Averaging whole neuron groups had diluted the signal.
- `brains/readout.json`: for each sense, the specific neurons and thresholds, picked on the training tracks. Held-out
  AUCs corrected to causal smoothing: SPACE 0.90, MIX 0.84, PEAK 0.79.
- Split-ear training (a different track in each ear, as the app then listened) didn't help. Kept on file; v1 stays.

## Three flies on the GPU (29 September)

### Three flies · `7918587` · 05:27
- Every test said the trained sense works when a fly hears one track in both ears. So each deck gets a listener fly
  that hears it in both ears, and a third, DJ fly hears the listeners: 12 descending-neuron types of each listener
  drive one of its ears. The DJ fly performs.
- `server.py --flies {1,2,3}`, default 3. `Brain.sibling()` shares the wiring between flies.

### In real time · `5e3ab71` · 17:55
- The first three-fly runs were slower than the music (load 1.81). Each fly now runs in its own process, and
  `brain.py` gains an event-driven kernel.
- The listeners hear each deck's raw track, before the fly's own EQ and filter sweeps.
- Each listener ranks its readout against its own last ~3 minutes, since live levels sit offset from offline ones.

### On the GPU · `baa3aec` · 20:57
- `flybrain/gpu.py`: the same model as MLX Metal kernels, all flies stepped together. The 7-step synaptic delay lets
  each 5-step window run without cross-talk.
- It matches the CPU on the sugar test. 3 flies take 0.33 s per brain-second, 18 flies 1.9 s.
- The default when MLX is present; `--cpu` turns it off. Live load 0.83, against 1.04–1.16 with CPU processes.

### The visualiser · `cae07d2` · 21:52, `7a65230` · 22:36
- `viz.html` in its own window: every fly's brain in 3D at real FlyWire positions, spikes lit as they fire, listener
  taps streaming into the DJ fly's ears, and a side panel of the moves with the neurons that fired them.
- A collect kernel brings every spike back from the GPU, and frames get faster (6.5 ms per 20 ms frame).
- Each move gets its own look, timed to the beat. Drag, zoom, hover, and click to stimulate a cell type (a new
  `poke` message).
- No more stale pages: Safari was running cached copies of the app. Pages are now generated with versioned script
  URLs.

`2afb644` · 23:54 — HANDOFF.md, and the session's test tools (`livetest`, `vizfx`, `gpucheck`) and readout builder
saved in the repo.

## A steadier mix (30 September)

### At least 45 s on each track · `640762f` · Sep 30 00:09
- The fly could leave as soon as its preference tipped, aversion could cut away at any moment, and the next track
  often went on air near its own end, forcing another mix soon after.
- Now there's a minimum time on air (45 s by default, a slider from 15 to 120 s). Before it, aversion only dips a
  low-pass. A blend can only reverse in its first 30%. The incoming track is cued back by whole phrases when it
  wouldn't have room to play.
- `tools/onairtest.mjs` measures time on air.

`7e334ef` · 00:26 — this line becomes `fork/steady-mix`.

## The whole male CNS · `f248899` · Oct 2 00:12
- `--connectome malecns`: Janelia male-cns v1.0 (165,122 neurons, 25.6M connections across the brain, optic lobes
  and nerve cord), downloaded on first use.
- Signs come from predicted transmitters, and synapse counts are scaled by 0.52 to match FlyWire's input per neuron.
  Driving the whole sugar channel at 200 Hz gives 263k spikes/s on both connectomes (a bigger stimulus than the
  paper's 21-neuron test).
- Leg and wing motor neurons join the outputs (2,129 in all). It runs untrained.
- `tools/cnscheck.py` runs the same stimuli on either connectome.

## Section sense and a benchmark (2 October)

`a08a9d9` · 01:00 — **Audit 1** (AUDIT.md): the trained neurons separate sections live, but the rank detector drops
that to about chance, and the decisions that matter most don't use them.

### Section sense v2 · `61f447d` · 01:32, `986b87e` · 02:43
- `flybrain/sections.py` and `web/js/sections.js`: per bar, the listener's output neurons pooled by cell type, a
  logistic classifier, and an online HMM over the order of sections.
- Fly-chosen transitions start in a sensed outro, or a breakdown when the fly wants to leave, never mid-song (with a
  3-minute cap). Blends and cuts cue the incoming track to its intro.
- New tools: `record_real.py` (the fly listens to real tracks on the GPU), `train_sections.py`,
  `analyze_tracks.mjs`, and `djbench.mjs`, a repeatable benchmark.
- Trained on 131 real tracks (only the weights are in git). Held out, against energy-based labels: accuracy 0.72,
  macro-F1 0.54.

`a160c0a` · 03:39 — a cut now restarts the time-on-air clock (the fly could cut again and again), and a deck cued back
restarts its section sense.
`f1e03a7` · 04:29, `3a24746` · 05:30 — the v2 results, then **Audit 2**: the energy labels favour the app's own
analysis, and the mixing gate leaks.

## DJ craft (2–3 October)

### Fair labels, phrase-timed moves · `f365cdd` · Oct 2 22:10
- Based on research: in real DJ mixes, transitions follow 32-beat phrases and tracks play about 4 minutes; effects
  belong on the phrase, with variety.
- Fair section labels from the All-In-One structure analyzer (`tools/label_allin1.py`): intro / verse / chorus /
  break / outro. The order of sections is learned from data.
- The mixing gate: a sensed outro, a confident late breakdown when the fly wants to leave, or 4 minutes on air.
  Every transition logs its reason.
- The fly's moves wait for the phrase, are swapped to suit the section, and rotate through each family's variants.
- `djbench.mjs` scores craft: where mixes and moves land, fit, variety, pace, time on air.

`2b79b40` · Oct 3 01:51 — **section sense v3**: the fly's neurons and the app's energy, fused, on All-In-One labels.
5-fold CV macro-F1 0.50, against 0.44 for song position alone. (Audit 4 later found this comparison isn't nested; the
fair one is in TRAINING.md.)
`c57d484` · 02:41 — results against the old version on 24 held-out tracks.

### Pace, and listeners that no longer go deaf · `737db99` · 06:29
- A moves-per-minute target (default 8, a slider from 2 to 20). The burst threshold adapts toward it; moves queue and
  play on bar lines.
- Loop rolls, scratches, tape stops and chops muted the deck ahead of the listener tap, so every such move fed the
  listeners silence, which reads as a breakdown. The tap now comes first.

`690ec6e` · 06:31 — **Audit 3**: a narrow move palette (more than half of it the echo family, no scratches), mixes
never via outros, and a pace control that under-counts.

## Analysed beats and structure (3–4 October)

### The song analysis, and fixes from the audits · `d0095fc` · Oct 3 08:21
- **Beats and structure:** the server finds a track's All-In-One analysis by the file's SHA-1, and analyses unknown
  dropped files in a background queue. The app fits its bar grid to the analysed downbeats and maps the sections onto
  it. The in-browser tracker had the tempo octave or bar phase wrong on about half of real songs.
- **No glitches:** a scheduled jump keeps the audio playing until its time, then crossfades. Beat jumps, hot cues and
  cue-backs used to leave up to a bar of silence, and builds up to 16. Overlapping moves share one mute schedule, and
  listeners hear each source before the stem mutes.
- **Mixes:** with analysed structure the fly mixes from the outro and lands the incoming track's first bar on the
  phrase line. Blends are capped at the time left. No auditions in a track's last 90 s.
- **Character:** the same burst bars and cooldowns for every group, fairness in the queue, scratches in verses and
  choruses, a big-move tier in choruses, and a pace control that counts every move.
- **Never stop:** the server loop survives frame errors, the GPU kernels warm up at start, and Safari gets a one-tap
  resume when audio is interrupted.
- djbench: analysed references, a dropout metric, Student-t intervals, pooled mixes with Wilson intervals, and a fresh
  test set. `tools/compare_sense.py`: the fair comparison of what section sense can be built from.

`6901364` · 18:06 — Demucs on the GPU through MLX for the song analysis: about 28 s a track instead of about 75 s.
djbench reports harmonic mixing.

### Planned exits · `0b07b18` · Oct 4 04:33
- The grid fit numbers downbeats by their spacing and refits without outliers (wrong-tempo fits on the library:
  37 → 2). Songs in 3 get the beat tempo; tracks that change tempo are fitted on their end. A *steady* flag marks the
  tracks that are safe to blend. (Rebuilt after Audit 4: see the grid fit below.)
- Each analysed track gets a planned exit: a blend across a long outro, an echo out of a short one, or a blend from
  about 12 bars before the end.
- The fly decides 4 bars ahead and starts each style by its lead, so cuts and drops land on the mix point. Unsteady
  tracks and short outros get cuts, echoes or spins. No new moves in the last 8 bars before the exit.
- Checked offline over every analysed track with decision delays of 0–8 bars: nothing started late or ran past the
  end. (Audit 4 later found that a double drop can still outlive the outgoing track; fixed in `bdb8302`.)

`7f994c9` · 05:26 — deck scheduling: jumps stack, superseded sources stop, and stems arriving keep the jumps still to
come. `tools/test_decks.mjs` plays the Deck offline and checks the audio; the previous `decks.js` fails 5 of its 7
tests.
`c8870ff` · 05:27 — aversion goes through the mixing gate (a low-pass dip now, a spinback exit at the next fitting
place); the crate pointer stays inside the crate.
`35301b8` · 05:29 — the analysis service: an index that can't be half-written, separate locks for indexing and
analysing, a 202 "indexing" answer while the library is hashed, files over 20 minutes skipped, a 15-minute timeout.
`6164c67` · 05:46 — the tempo holds from the plan to the landing, because the incoming cue is timed on it; steadiness
counts only downbeats a fixed grid can't explain (steady tracks 341 → 352 of 440); an overdue transition re-checks its
style against the room left; key lock on / off keeps a pending cue jump.
`4edaf57` · 05:49 — HANDOFF.md updated. `1167539` · 06:00 — djbench's summary survives a run with no transitions.

`b3aaaa6` · 06:38 — **Audit 4**, the whole project. Three audible bugs: the just-played track can come back,
half / double-time blends make the tempo slump and then double, and a double drop at the exit can outlive the
outgoing track. Also timing, server and app issues, and corrections: the 2–3 October intervals were 2.2–6.5× too
narrow, and "the fly's brain beats the energy analysis" doesn't survive the nested comparison. All of it is fixed
below, except retraining the section model on the analysed grid.

## Audit 4's fixes (4–5 October)

### The DJ and the audio · `bdb8302` · Oct 4 06:57
- **No replayed tracks.** A deck that leaves the air is marked spent and gets a new track before it can be cued
  again; it used to come back from its intro. `140ea8f`, `8969b97` · 07:01: the guard waits 10 s for a load (it may
  be decoding) before deciding the crate has nothing new.
- **Half and double time.** The fold is picked once per load, so glides and the tempo ride no longer halve or double
  a deck's rate in one step. The glide after a blend aims at the incoming track's tempo in the set's frame.
- **Double drops that fit:** they need room after landing and are sized to what the outgoing track has left (else a
  drop swap).
- **Moves that end before the exit:** builds shrink or skip, and phrase-long moves become a throw, unless they end
  4 bars before the planned exit. Time on air keeps counting through a mashup or a double drop.
- **The tempo holds** while any move has cuts or restores fixed on the audio clock, and the tempo fader stays put.
- Smaller: the spinback stays muted until the cut; beat FX run on the on-air deck's grid; filter and reverb moves
  continue from where they are; EQ kills on the audio clock; cuts ramp over ~5 ms; overlapping echo throws extend;
  slower delay retune; reverse and scratch copy a short window, not the whole track; a 2-bar cooldown floor; turning
  the autopilot off forgets a lined-up transition; a deck ending at the fader midpoint doesn't load a third track.

`8a8c110` · 06:59 — `tools/test_dj_logic.mjs`: the DJ's decisions in plain Node, on the app's own Mixer, Deck,
Performer and FlyDJ with a recording stand-in for Web Audio. On the code before the fixes all but the positive
control fail.

### The app · `a2b6573`, `3ff028a` · 07:00
- A restarted server with another brain is recognised by its hello: the visualiser reloads, and the DJ page stops
  driving the flies and shows a reload banner.
- **Crate memory:** only the decks' tracks, the audition and the next few candidates keep decoded audio; the rest are
  decoded again when needed. Stems are split when a track is loaded on a deck, and not over 12 minutes.
- Drops are deduplicated by SHA-1 and a batch keeps its order. ½× / 2× are greyed on analysed tracks.
- The analysis poll follows the server's answers (200 / 202 / 404 / 410), survives network errors and uploads one file
  at a time.
- The visualiser gets the move history after its hello and handles a lost WebGL context.
- The control loop ticks from a worker's timer: a hidden Safari page's own timers can drop to once a second.

### The server and the brain · `8a0ef8f` · 07:02
- Requests must name this machine (DNS rebinding). Each client gets a 4-frame queue, so one stalled page can't stall
  the brain. Failed analyses are final (410); uploads are streamed and hashed off the event loop and deleted after
  analysis. The drive is zeroed when the driving page goes, and resets happen between frames.
- **Poisson kicks respect the refractory period**, on the CPU and the GPU: a kick still adds to v, but can't fire a
  refractory neuron, and a kick spike starts a refractory period. Driven neurons had fired about 8–15% too fast.
- The GPU sums duplicate stimulus indices, as the CPU does. Downloads and connectome caches are written atomically.

`62f5d30` · 07:08, `d8e4440` · 07:10 — README, NOTES, TRAINING and CHANGELOG brought up to the three-fly GPU app.

### The grid fit · `5cc2bbc` · 07:17
- Each downbeat is numbered from the last one on the grid, not from its neighbour: a half-bar extra used to shift
  every later index. The first fit is on the longest run of downbeats.
- A tempo-changing track is fitted on its end when the whole-track line misses it. A line more than 1/8 bar out is no
  grid, and a track with no grid is marked unsteady.
- The bar must be a whole number of beats: 2 is a double-time grid, 8 a downbeat every other bar, and 5, 6 and 7 get
  the beat tempo with no blends.
- Over the 499 analyses: grids applied 492 → 493, steady 394 → 411.

### Benchmark v3 · `f6ea7fa` · 07:24, `071eaff` · 07:29
- `djbench` logs raw facts in track time: every move and transition with the on-air track and its position in
  seconds, who drove it, silences, the on-air track over time, and the load every second. `SET=random:<n>:<seed>`
  draws tracks never used.
- `tools/djscore.mjs` grades the runs offline against the raw All-In-One beats, downbeats and sections, so two versions
  are graded on the same reference. Split by driver, with a paired A/B mode. Older files are placed through their own
  version's grid fit (`FILE@1167539`, `FILE@6901364`).

`d200ad0` · 07:47 — AUDIT: the final benchmark of the 4 October fixes, graded on the All-In-One sections: planned
exits landing in an outro went from 1 of 4 to 9 of 10, and nothing measured got worse. Also Audit 4's fix status.

### A second review of the fixes · `cd6655e` · 07:46, `ea9e82d` · 07:51, `c44fbbc` · 12:42, `1fb7f0e` · Oct 5 20:16
- **Server:** an analyser killed by a signal no longer marks the track failed for good; Origin must be this machine
  or the very host the request went to, never just any IP; stale upload leftovers are swept at start.
- **App:** big drops are trimmed as they go; an audition waits for its track to decode; a load that finishes late
  never swaps a track mid-transition; a decode error under memory pressure sits out a minute; overlapping drops keep
  their order; download links live 10 minutes; the tempo keys work on the numpad.
- **DJ and audio:** the fader follows the audio clock, so a hidden page no longer sees the old deck on air after a
  cut; a quick fader nudge doesn't mark a deck played; idle effect parameters start from their resting value; a drop
  swap's tempo hold ends at its drop; your own tempo change ends any hold; double drops are whole 4-bar phrases.
  `test_dj_logic`: 27 checks.
- **Grid fit:** 4 or more half-bar downbeats in a row are the bar line moving, and a track whose bar line moves near
  the end is fitted after the move. Over the 499 analyses: 494 grids applied, 390 steady, and 0.919 of the exit
  downbeats on the app's bar lines (0.895 before).
- **Benchmark:** the crate is put in name order before the seeded shuffle. App versions add a drop in different
  orders, so the same seed had given two versions different crates. That, not the brain, was behind an apparent
  collapse of the listeners' section sense in the first runs of the merged code (AUDIT.md).

### The neurons decide more · `c763638` · Oct 9
- **When to leave:** on an analysed track, any section boundary in the second half is an exit the DJ fly may take,
  when its steering neurons have kept turning toward the other deck (held over ~8 s, decided 4 bars ahead, landing
  exactly on the boundary). It replaces the late-breakdown rule, which leaned on the browser's ear habituation.
- **Which track:** each auditioned candidate's listener response is kept as a pattern over descending cell types and
  compared with the on-air track's. An aroused DJ fly keeps the sound going, a calm one changes it up.
- **Which variant:** the cell type that led a burst picks the move's variant (echo / reverb / dub …).
- A *neurons decide more* toggle (on by default) brings back the designed rules; `djbench` takes `NEURONS=0/1`, and
  `djscore` counts neuron-chosen exits as their own driver. `test_dj_logic`: 34 checks.
- Not measured live yet: a same-seed `djbench` comparison with `NEURONS=1` against `NEURONS=0` is the next step.
