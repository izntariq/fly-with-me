# Changelog

Every version from the first line of code. Times are local (PDT), all on 27–28 September 2026. Each entry names the
commit, so `git show <id>` gives the full notes and diff. Versions with a `vX.Y` tag are the milestones.

> In the public repository, the work after v1.12 is published as one commit per theme (tag v2.0.0). The
> commit ids named after v1.11 below are from the development history, which isn't published.

---

## v0.1 — whole-brain fly simulator · `1d3c4d1` · Sep 27 22:04

`dc10e58` · 22:06 — Claude Code permission allowlist for read-only commands (from `/fewer-permission-prompts`).

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

`b7b5f83` · Sep 28 00:25 — demo tracks synthesized sample by sample: 76 s → under 1 s.
`9480108` · 00:28 — DJ pacing: warm-up, minimum time on air, calmer effects.
`cb80b82` · 00:40 — bitter drive capped at 100 Hz (it caused runaway); debug handle `window.flyDJ`.

## v1.0 — first complete version · `826d453` · 00:52
- `run.sh` launcher (downloads the data), README, requirements, `.gitignore`.
- Sugar makes the fly "sing".
- 4-minute soak test: 4 beat-matched transitions, no errors, half of real-time CPU.

`b507e04` · 00:57 — burst detectors tuned so effects fire every ~8–12 s around musical events.

## v1.1 — desi beats · `81fbfea` · 01:38

`660e1b7` · 01:45 — performance: Safari's drawing was eating ~10 cores and starving the brain. Drawing made lighter,
simulator moved to 4 threads.
`ead2b90` · 01:51 — **asked:** remove "the repeating tinny sound". Chimta removed; tumbi hook softened and only plays
half the time.

## v1.2 — epic DJ · `d987ff8` · 02:06

## v1.3 — tempo control · `841d083` · 02:09

`1362da8` · 02:12 — the fly waits 15 s before its first move; crate "next" label fixed; README lists every move.

## v1.4 — the fly chooses tracks · `745d59b` · 02:18

## v1.5 — adapting to new music · `cc47e0f` · 02:22

`3aae162` · 02:26 — git switched on; local Claude settings ignored.
`87b2efb` · 02:27 — drum & bass no longer detected at half tempo; ½× / 2× fix buttons on each deck.
`b027f9b` · 02:27 — README: how the fly adapts to new music.

## Docs — this changelog, git explainer, project notes · `bd7939a`

## v1.6 — play like the big names · `7d9454b`

## v1.7 — stems · `6226f87`

## v1.8 — set planner · `801ce2d`
- Energy arcs for a whole set: club night, warm-up, peak time, Guetta's yo-yo, Diplo's pop → heavy → pop,
  Kaytranada's beat tape, closing.
- While a set runs:
  - epicness follows the arc, and track picks match its intensity
  - the tempo leans with it
  - builds happen at peaks, breakdowns in dips
- Live graph of the plan and of what the fly actually did.

## v1.9 — the fly on the mic, set export · `4325865`
- Speech-synthesis MC with per-style lines ("Balle balle!" for desi); the fly's spikes pick the phrase.
- Markdown set report: tracklist with how each track came in, move counts, full log.
- Builds default to the chosen style's build.

## v1.10 — key lock · `3097382`
- AudioWorklet pitch shifter per deck, so tempo no longer changes pitch (440 Hz stays at 441 Hz at +12% / −10%).
- `40b8140`: with key lock on, styles can move the tempo up to 20% and blends can span 16%.

## v1.11 — a clean key lock

  | | Kick tightness (52% unprocessed) | 440 Hz tone at 0.9–1.12× |
  |---|---|---|
  | Old | 45.7–48.5% | 440.8–441.4 Hz |
  | WSOLA | 50.6–53.5% | 440.1 Hz |
- Latency compensation: decks schedule everything that happens before the shifter 24 ms early, so key-locked decks
  land on the beat grid with rolls, scratches, the synth and the sampler. Deck-vs-grid offset: 24.7 ms → 0.7 ms.
