# Changelog

Every version from the first line of code. Times are local (PDT), all on 27–28 September 2026. Milestones are tagged, so
`git show v1.1` (for example) gives the full notes and diff. Versions with a `vX.Y` tag are the milestones.

---

## v0.1 — whole-brain fly simulator · Sep 27 22:04
- Numba rewrite of the Shiu et al. 2024 leaky integrate-and-fire model on the FlyWire v783 connectome (138,639 neurons,
  15,091,983 connections), with the same equations and parameters as the paper.
- Exact exponential integration at dt = 0.25 ms, a delayed-synapse ring buffer, refractory periods, and Poisson
  drive whose per-neuron rate can change at any moment.
- **Validated** against the paper's sugar experiment: ~406 active neurons, ~20k spikes/s, feeding motor neurons firing.
- About 0.6 s of compute per simulated second.

22:06 — Claude Code permission allowlist for read-only commands (from `/fewer-permission-prompts`).

## v0.2 — senses and outputs · 22:09
- Inputs chosen by real cell type from the FlyWire annotations: 12 Johnston's-organ (ear) subtypes per side, wind
  neurons, sugar and bitter taste neurons.
- Outputs: all 1,409 descending and brain motor neurons.
- Positions of every neuron, for the brain map.
- Measured along the way: loud sound → giant fiber (the escape neuron); the ears are strongly lateralized; smell input
  makes the brain run away.

## v0.3 — real-time server · 22:10
- aiohttp + WebSocket server that runs the brain in 20 ms frames locked to wall-clock time.
- Runaway guard: resets the brain after 3 frames above 600k spikes/s.

## v0.4 — parallel kernel · 22:11
- Integration runs in parallel. 2.5× faster (about 4× faster than real time) and gives *identical* spikes.

## v0.5 — the Fly Brain DJ app · 23:46
- Two decks with EQ, filter, loop roll, echo, backspin and an equal-power crossfader.
- Fly ears: deck A → left Johnston's organ, deck B → right, with habituation.
- Fly synth: every descending/motor neuron is a key.
- Fly DJ: the crossfader follows left/right brain activity; named neurons trigger moves; bass-swap blends.
- Whole-brain spike map, output raster and event log.

Sep 28 00:25 — demo tracks synthesized sample by sample: 76 s → under 1 s.
00:28 — DJ pacing: warm-up, minimum time on air, calmer effects.
00:40 — bitter drive capped at 100 Hz (it caused runaway); debug handle `window.flyDJ`.

## v1.0 — first complete version · 00:52
- `run.sh` launcher (downloads the data), README, requirements, `.gitignore`.
- Sugar makes the fly "sing".
- 4-minute soak test: 4 beat-matched transitions, no errors, half of real-time CPU.

00:57 — burst detectors tuned so effects fire every ~8–12 s around musical events.

## v1.1 — desi beats · 01:38
- Four synthesized desi tracks:
  - bhangra dhol *chaal*, 116 BPM, raag Kafi
  - tabla *keherwa* theka, 120 BPM, Yaman
  - dholak, 118 BPM, Bhairav
  - Bollywood disco, 124 BPM, Khamaj
- Karplus-Strong tumbi, sitar (with *meend* glides and *jawari* buzz) and tanpura; harmonium; dhol and tabla strokes.
- Raga scales; the fly plays **dhol with its motor neurons and sitar with its descending neurons** when a desi track is
  on air.
- Crate style selector (desi / club / both).

01:45 — performance: Safari's drawing was eating ~10 cores and starving the brain. Drawing made lighter,
simulator moved to 4 threads.
01:51 — Chimta removed; tumbi hook softened and only plays
half the time.

## v1.2 — epic DJ · 02:06
- Master FX rack: sweeps, trans gate, crush, flanger, reverb.
- Sampler: air horn, siren, laser, boom, riser, dhol roll.
- Scratching: baby, chirp, transformer, flare. Also tape stop, hot cues and beat jumps.
- Carl Cox style **cue build & drop**, drop swap, echo out, spin cut.
- The fly picks the transition style from its most excited neuron group; a whole-brain arousal surge triggers a build.
- Performance pads, keyboard shortcuts, epicness slider.

## v1.3 — tempo control · 02:09
- Master BPM that both decks follow, phase-locked.
- −/+ buttons and keys, tap tempo, reset.
- "Fly rides the tempo": arousal can push it up to ±6%.

02:12 — the fly waits 15 s before its first move; crate "next" label fixed; README lists every move.

## v1.4 — the fly chooses tracks · 02:18
- The winner loads from its intro; tracks it has already played are marked down.

## v1.5 — adapting to new music · 02:22
- Analysis of every new track: key (Camelot code), style, energy per bar.
- The fly's voice follows the key, and its move set follows the style.
- Breakdowns get space instead of chops; builds are timed to land on the track's real drop.
- Cuts instead of blends when tempos are far apart; tempo journeys; harmonic track picking.

02:26 — git switched on; local Claude settings ignored.
02:27 — drum & bass no longer detected at half tempo; ½× / 2× fix buttons on each deck.
02:27 — README: how the fly adapts to new music.

## Docs — this changelog, git explainer, project notes
The history was rebuilt from the session transcript (see [GIT.md](GIT.md)) and the documentation added.

## v1.6 — play like the big names
- Research into 29 DJs, with sources in [DJ_RESEARCH.md](DJ_RESEARCH.md): Guetta, Garrix, Tiësto, Calvin Harris,
  Swedish House Mafia, DJ Snake, Skrillex, Diplo, Aoki, Armin, Alok, Nucleya, Fred again.., Carl Cox, Hawtin,
  de Witte, Lens, Peggy Gou, Black Coffee, Solomun, Four Tet, Jamie xx, Prydz, Fisher, John Summit, Kaytranada,
  Qbert, A-Trak, Jazzy Jeff.
- **"Play like…" styles.** The neurons decide when; the style decides which moves, transitions, builds, blend
  length, time on air, home tempo and hype.
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
