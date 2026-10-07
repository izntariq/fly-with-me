# Fly Brain DJ

A real fruit-fly brain makes music and DJs.

The complete adult *Drosophila* connectome (FlyWire v783: **138,639 neurons, 15,091,983 connections**) runs as a
spiking network in real time. Three copies of it play together: a listener fly on each deck, and a DJ fly that hears
the two listeners. Music goes into the flies' real auditory neurons. The DJ fly's real descending and motor neurons
play a synth and work a two-deck DJ mixer.

```bash
./run.sh            # starts the brain server and opens http://localhost:8765
```

Press **Start the fly**. A crate of 8 synthesized demo tracks (4 desi, 4 club techno) is ready right away. Drop
your own audio files anywhere on the page to add them to the crate. Tempo, key, style and an energy curve are
measured in the browser; the beat grid and song structure come from the song analysis service when it knows the track
(see [Where the fly is in a track](#where-the-fly-is-in-a-track)).

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/NOTES.md`](docs/NOTES.md) | Comprehensive project notes: how every part works, the neuroscience, measured findings, design decisions, limitations, testing, ideas |
| [`docs/TRAINING.md`](docs/TRAINING.md) | How some of the fly's synapses were trained, the section sense built on its neurons, and what the measurements say about both |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Four audits of the project (2–4 October): findings, fixes in order, corrections to earlier claims, and the review of Audit 4's fixes |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | The current state on one page: how to run it, what's running, open threads, how to test without disturbing a live session |
| [`docs/DJ_RESEARCH.md`](docs/DJ_RESEARCH.md) | How 29 big-name DJs play live (Guetta, Fred again.., Garrix, Carl Cox, Hawtin, Fisher, Qbert…), what each finding became in the app, and all sources |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Every version from the first line of code, and what changed |
| [`docs/GIT.md`](docs/GIT.md) | Git explainer: how this history is organised and how to browse, compare, run and restore any version |

## What's actually happening

```
 deck A track ──► listener fly A: both ears, 12 JO bands ──┐ 12 tapped descending-neuron types each
 deck B track ──► listener fly B: both ears, 12 JO bands ──┤
                                                           ▼
 🍬 / 🍋 / wind ──────────────────────────────────► DJ fly: left ear ◄ listener A, right ear ◄ listener B
                                                           │ 1,409 descending + motor neurons
            crossfader ◄── left vs right descending neurons (the fly "turns toward" a deck)
            beat roll  ◄── DNp01 giant fiber (the escape-jump neuron)
            echo throw ◄── DNp02 / DNp06 / DNp11 / DNp55
            aversion   ◄── bitter-driven DNp42 / DNpe007 / DNge067, MDN "moonwalker": a low-pass dip, then a spinback exit
            filters    ◄── DNp12 / DNb05 / DNg56 (low-frequency hearing pathway), per side
            fly synth  ◄── every DN/MN is a key; motor neurons play bass, DNs play lead
```

* **Three flies** (`--flies 3`, the default).
  * Each listener fly hears its deck's raw track (before the DJ's EQ, filters and effects) in both ears. That's how
    the trained synapses were trained: one track in both ears.
  * The DJ fly hears the listeners. Twelve descending-neuron types of listener A drive the 12 bands of its left ear,
    and listener B's drive its right ear (`LISTENER_TAPS` in `flybrain/server.py`; the first six are the section
    readout's neurons, five of them trained).
  * The DJ fly performs: moves, transitions, the synth. Taste and wind go to it too.
  * `--flies 1` runs a single fly with deck A in its left ear and deck B in its right; `--flies 2` runs the two
    listeners only, and the on-air deck's listener performs.
* **The brain** uses the same model and parameters as Shiu et al., *Nature* 2024
  ([repo](https://github.com/philshiu/Drosophila_brain_model)): leaky integrate-and-fire neurons, synaptic weight =
  synapse count × neurotransmitter sign × 0.275 mV, 1.8 ms delay, 2.2 ms refractory period, and Poisson drive for
  sensory input.
  * **On the GPU** (the default on Apple silicon): `flybrain/gpu.py` steps all three flies together with custom MLX
    Metal kernels. A 20 ms frame for 3 flies takes about 6.5 ms.
  * **On the CPU** (`--cpu`): `flybrain/brain.py`, a Numba rewrite with exact exponential integration, each fly in its
    own worker process. One fly on 12 threads runs about 4× faster than real time on an M3 Pro, instead of minutes
    per second in Brian2.
  * **Validation:** the paper's sugar-neuron experiment (21 sugar GRNs at 200 Hz; the paper reports about 400
    active neurons). On the CPU it gave 406 active neurons and 20.1k spikes in 1 s, with feeding motor neurons firing.
    That was before Audit 4's refractory fix; since the fix the GPU gives 386–392 active neurons and 18.8k–19.5k spikes
    (3 seeds). The CPU hasn't been re-measured.
* **Trained synapses.** By default (`--brain auto`) every fly loads `brains/trained_brain.npz`: 9,978 synapses onto
  25 descending neurons, trained so those neurons fire in particular parts of a track. Everything else is the FlyWire
  wiring. `--brain naive` runs the untouched connectome, without the section model or the readout (both exist only
  for the trained brain), so on tracks without an analysis the fly has no section sense. Measured fairly, the training
  doesn't measurably help the fly sense song sections: see [`docs/TRAINING.md`](docs/TRAINING.md).
* **Inputs and outputs** (`flybrain/mapping.py`) are picked by cell type from the FlyWire annotations
  (Schlegel et al. 2024). JO-B neurons respond to low-frequency sound and JO-A to higher frequencies. Spreading
  individual subtypes across 12 frequency bands is an artistic tonotopy, not a measured one.
* **Findings that shaped the design:**
  * Loud high-frequency sound drives JO-A, which fires the **giant fiber** (DNp01), the fly's escape command neuron.
    That's a real circuit, so it became the "beat roll" move.
  * The ears are strongly lateralized: right-ear drive gives ~30× more right-side DN spikes than left-side ones.
    So the DJ fly's left ear carries deck A, its right ear deck B, and it steers the crossfader toward the side it
    responds to more (phonotaxis).
  * **Olfactory input sends the model into self-sustaining runaway** (~800k spikes/s in the antennal lobe), so smell
    isn't wired in. The server auto-resets a fly if any input causes runaway.
* **Why the fly changes tracks.** It *wants* to leave when its left/right preference points to the other deck and its
  ear on the on-air deck has habituated (over ~75 s, tracked in `web/js/ears.js`). It stays on each track at least
  45 s (a slider). Then:
  * on an analysed track it mixes out at the planned exit (the outro, or about 12 bars before the end); earlier only
    from a breakdown in the last 40% of the track, if it wants to leave; and after 4 minutes on air at the latest
  * on other tracks it waits for an outro its listener fly senses or, if it wants to leave, a confident breakdown in
    the last 30% of the track; failing those, 4 minutes on air or the track ending
  * the off-air deck is restocked from the crate and beat-matched. A deck whose track was on air for 10 s or more gets a
    new one when it leaves the air, so the track just played can't be cued again

## Where the fly is in a track

**Analysed tracks.** The server looks up a track's beat grid and song structure by the audio file's SHA-1
(`GET /analysis/<sha1>`).
- A library of tracks is analysed offline by the All-In-One structure analyzer (Kim & Nam 2023, trained on the
  human-annotated Harmonix Set), with its Demucs stem separator running on the GPU through MLX (~28 s a track).
- An unknown dropped file is uploaded and analysed in the background, one at a time, if the analyzer's environment
  (`.venv-allin1`) is installed.
- The app fits a bar grid to the analysed downbeats and maps intro / verse / chorus / break / outro onto every bar
  (`applyAnalysis` in `web/js/tracks.js`). Hot cues go on real section starts. Each downbeat is numbered from the last
  one on the grid, so a stray or half-bar downbeat can't shift the rest. A track whose tempo or bar line moves is
  fitted on its end, where it's mixed out of. Over the library's 499 analyses the app applies 494 grids, 390 of them
  steady (measured in commit 1fb7f0e).
- It plans each track's exit (`mixBar`): a blend across an outro of 10+ bars, an echo out of a short outro as the last
  chorus ends, or a blend from about 12 bars before the end. Tracks without a steady 4/4 grid (the tempo or the bar
  line moves, or the bar isn't 4 beats) are cut, echoed or spun out of, never blended.

**Other tracks.** Each listener fly has a section sense (`web/js/sections.js`):
- Per bar, its 518 output-neuron types are pooled into rates, log-scaled and normalised against the track so far,
  plus the last 4 bars and the app's own per-bar energy.
- A logistic classifier turns those into intro / verse / chorus / break / outro, and an online HMM keeps the sections
  in order, weighted by how far into the track the deck is.
- The model (`brains/sections_trained.json`) was fitted on 107 of 131 recorded real tracks against All-In-One labels.

The structure comes from the analyzer or the classifier, not from the fly's judgement. The fly is the performer:
its neurons decide when to act, which move, which transition style, and which track comes next.

## DJ moves

Modelled on what headline DJs actually do: Carl Cox's cue builds (roll the same cue point with shrinking loop
lengths, then slam into the drop), Richie Hawtin's FX-as-an-instrument, turntablist scratches (Qbert, Jazzy Jeff,
A-Trak), and desi-set staples (air horn, dhol roll, siren). The fly fires them from neuron bursts; you can fire them
too with the pads or the keyboard. Everything is quantized to the beat.

| Group | Moves (key) |
|---|---|
| Beat FX | echo `Q`, reverb `W`, flanger `E`, trans gate `R`, bit-crush `T`, low-pass dip `Y`, high-pass sweep `U` (length: FX length buttons) |
| Rolls & scratch | loop roll ¼ `A` / ⅛ `S` / 1/16 `D`, baby `F`, chirp `G`, transformer `H`, flare `J`, orbit, crab (Qbert) |
| Moves | **build & drop** `space` (⇧ = 8 bars), drop swap `B`, echo out `O`, spinback cut `P`, tape stop `K`, spinback `L`, beat jump `,` `.` |
| Big-name moves | live chops `I` (Fred again..), double drop `[`, mashup `]`, loop layer `\` (Hawtin), stutter `;` (Skrillex), reverse `'`, bass tease `5`, hard cut `6`, 303 acid `` ` `` (Guetta), sing-along `/`, 1-bar kill (Fisher), pump (Alok), dub throw, resonant filter (Model 1), Pryda snare fill |
| Sampler | air horn `Z`, dub siren `X`, laser `C`, boom `V`, riser `N`, dhol roll `M`, CO2 blast |
| Hot cues | deck A `1`–`4`, deck B `7`–`0` (intro / build / drop / break: on an analysed track, the intro, 8 bars before the first chorus, the first chorus and the first break after it; on a demo track, its fixed arrangement; otherwise estimated from the energy) |
| Tempo | master BPM slider, `-` / `=` or the numpad's − / + (⇧ for 0.1), TAP, ↺ back to the track's tempo; both decks follow and stay phase-locked; **key lock** keeps the pitch |
| Stems | DRUMS / MUSIC mute per deck; drums out, strip to drums pads |
| Set | set plan + length + Start set; 🎤 fly MC; 📝 Export set |

**Play like…** Pick one of 29 DJ styles from the research, among them David Guetta, Martin Garrix, Tiësto, Calvin
Harris, Swedish House Mafia, DJ Snake, Skrillex, Diplo, Steve Aoki, Armin van Buuren, Alok, Nucleya, Fred again..,
Carl Cox, Richie Hawtin, Charlotte de Witte, Amelie Lens, Peggy Gou, Black Coffee, Solomun, Four Tet, Jamie xx,
Eric Prydz, Fisher, John Summit, Kaytranada, DJ Qbert, A-Trak and DJ Jazzy Jeff. The fly's neurons still decide *when*
and *how hard*; the style decides *what*: which moves each neuron group reaches for, which transitions (Fisher's 1-bar
kill, Skrillex's hard cuts, Black Coffee's 32-bar blends…), which build (snare roll, cue roll, stutter, filter), how
long a track stays on (Kaytranada 25–60 s, Tiësto 1–2 min), its home tempo and its crowd hype. The fly's own minimum
time on air (45 s by default) wins when it's longer than a style's. **Build style** can override the build. The
styles are interpretations of the research, not recordings of anyone's set; see
[`docs/DJ_RESEARCH.md`](docs/DJ_RESEARCH.md).

**Stems.** Every track has a drums stem and a music stem. The demo tracks are rendered that way. A file you drop in
is split when it's loaded on a deck (not when it's dropped), in a background worker, by harmonic–percussive separation.
That takes about 5 s for a 90 s track, and the two stems add back up to the original exactly. Tracks over 12 minutes
get no stems (the separation would need gigabytes). Each deck has **DRUMS** / **MUSIC** mutes. The fly uses them for
*drums out* (Nucleya's dhol drop-out, Calvin Harris and Fred again.. sing-alongs), *strip to drums* (Hawtin, Carl
Cox), acapella-style mashups (the other deck's music stem) and percussion layering.

**Set planner.** Pick an energy arc and a length: club night, warm-up, peak time, Guetta's festival yo-yo, Diplo's
pop → heavy → pop, Kaytranada's beat tape, or a closing set. Then press **Start set**. The fly's epicness follows the
arc, it picks tracks whose intensity matches where the arc is heading, the tempo leans with it, and it builds into
the peaks and breaks down in the dips. A graph shows the plan, where you are, and how hard the fly actually played.

**The fly on the mic.** With **🎤 fly MC** on, it shouts hype through the browser's speech voice: "Are you ready?"
in builds, a shout on the drop, "Balle balle!" on desi tracks, and each DJ style's own lines. Its spikes pick the
phrase. Styles whose DJs don't talk on the mic stay quiet. The MC is heard live but not captured by *Record set*.

**Export set.** **📝 Export set** (also automatic when a recording stops) downloads a markdown report: style, plan,
the tracklist with when and how each track came in, counts of what the fly did, and the full event log.

**Key lock.** Like a CDJ's *master tempo*: with **key lock** on, tempo changes don't change pitch. Each deck runs
through a real-time WSOLA pitch shifter (an AudioWorklet, the method behind SoundTouch). A 440 Hz tone stays at
440.1 Hz at +12% and at −10%, and drum hits stay as tight as unprocessed.
With key lock on, DJ styles can move the tempo up to 20% and the fly can blend tracks up to 16% apart.

**Track selection.** When the off-air deck needs a new record, the fly previews up to 3 candidates in its cue ear
(5 s each, from their drop, like a DJ in headphones). It scores each by how hard the descending neurons of that
deck's listener fly fire, discounts tracks it has already played, favours harmonic neighbours and close tempos, and
loads the winner. Scores show in the crate (🎧). It doesn't audition in the on-air track's last 90 s unless the other
deck is empty. A deck whose track was just on air is restocked anyway: auditioned if the on-air track has more than
30 s left, otherwise loaded straight from the crate. Turn autopilot off and it goes back to crate order.

**Adapting to new music.** Every track you drop in is analysed in the browser for tempo (with a double-time check
for drum & bass), key (Krumhansl profiles → Camelot code), style (club / hip-hop / drum & bass / chill / desi — desi
is recognised from the file name) and an energy curve per bar. When the song analysis knows the track, its beat grid
replaces the browser's. The fly then:
- plays its voice in the track's key (and switches to dhol + sitar for desi),
- changes its move set with the style: hip-hop → scratches instead of builds, chill → reverb/echo instead of chops,
  drum & bass → fast rolls,
- reaches for space (echo, reverb, flanger) in breakdowns and lets a drop breathe for 8 bars,
- times arousal builds so they land exactly on the track's own drop,
- cuts (echo out / spinback) instead of blending when tempos are far apart, and snaps or drifts the master tempo to
  each new track ("tempo follows each new track"),
- favours next tracks that are harmonic neighbours (Camelot ±1) and within 6% tempo.

For tracks without an analysis, tempo detection is a heuristic: if a deck shows half or double the real BPM, hit
**½×** / **2×** on the deck. They're greyed out on analysed tracks, whose grid, sections and exit come from the
analysis.

**The fly as DJ.**
- **Moves** come from bursts in named neuron groups (the table is in [`docs/NOTES.md`](docs/NOTES.md)). They wait in
  a short queue and go out on the bar grid: a slot every bar in verses and choruses, every 2 bars elsewhere, released
  so they land on the line.
- **Pace:** a moves-per-minute target (default 8) slowly adapts the burst threshold. The strongest bursts still pick
  the moves.
- **Fit:** moves are swapped for ones that suit the section (filters and space in intros and outros, space in
  breakdowns), and each family rotates its variants. With the default style, now and then a strong burst in a chorus
  plays a big move (live chops, bass tease or drums out, pump, acid, sing-along).
- **Transitions** land on 16-beat phrase lines, or on an analysed track's planned exit bar. Each style starts early by
  its own lead, so its cut or drop lands on the line. The style comes from whichever neuron group is most excited:
  giant fiber → drop swap, echo group → echo out, aversion → spinback cut, calm → a long EQ blend with bass swap.
  Blends and cuts bring the incoming track in from its first bar.
- **Builds:** a surge across all ~1,300 descending neurons triggers a cue build & drop.
- **Tempo:** with *fly rides the tempo* on, arousal moves the BPM by up to ±6%. The tempo holds still while a
  transition is lined up, and while a move has cuts or restores scheduled on the audio clock (builds, double drops,
  mashups, drums out…); the tempo fader and the glide wait too. Changing the tempo yourself ends any hold. With
  *tempo follows each new track*, a cut snaps the tempo to the new track on the beat it lands, by the audio clock.
- **Epicness** scales how often and how hard it plays.

## Controls

| Control | What it does |
|---|---|
| **fly autopilot** | Off = you DJ and the fly just sings. Touching any EQ/filter or the crossfader overrides the fly (double-click a knob to hand it back). |
| **moves per minute** | The pace the fly aims for (2–20, default 8). Every move is still triggered by its neurons, on bar lines. |
| **stay on a track at least** | The minimum time on air before the fly mixes out (15–120 s, default 45 s), unless the track runs out. |
| **ears hear room mix** | With `--flies 1`: the fly hears the master output instead of split cue, including its own synth (a feedback loop). With two or three flies the listeners always hear their own deck's raw track, and the toggle is disabled. |
| 🍬 Sugar / 🍋 Bitter | 3 s of taste stimulation. Sugar fires feeding motor neurons, so the fly "sings" louder. Bitter fires aversion neurons: the fly dips a low-pass filter and, once past its minimum time on air, wants off the track, which it leaves at the next fitting place with a spinback. |
| Wind | Drives the JO-C/E wind & gravity neurons. |
| Fly voice | Level, quantize-to-beat (off = raw spike timing), scale, **MIDI out** (lead on ch 1, bass on ch 2) to drive any hardware or DAW synth. |
| Record set | Records the master output to a `.webm` download. |

The whole brain view shows the performing fly as a frontal projection of every neuron: blue = sensory inputs,
magenta = outputs, orange = everything in between. The raster shows all 1,409 output neurons over the last 4 s.

## The whole CNS: male brain + nerve cord

```bash
./run.sh --connectome malecns      # downloads ~1.1 GB on first use
```

This swaps in the male central nervous system connectome (Janelia male-cns v1.0, 2026, CC-BY 4.0): 165,122 neurons
and 25.6M connections across the brain, optic lobes and ventral nerve cord. The descending neurons now reach the
fly's real leg, wing and haltere motor neurons (708 of them), and those motor neurons join the outputs.

It runs the same model. Signs come from each neuron's predicted transmitter (GABA and glutamate inhibit), and synapse
counts are scaled by 0.52 to match FlyWire's input per neuron. Driving the whole sugar channel at 200 Hz
(`tools/cnscheck.py`; a much bigger stimulus than the paper's 21 neurons), both connectomes gave 263k spikes/s and
about 10.2k (FlyWire) and 10.3k (male CNS) active neurons, and the male CNS fires the feeding motor neurons (MN9). That
was measured before the refractory fix. Cell types share FlyWire's names, so the ears, the DJ moves and the listener
taps carry over.

The brain runs untrained: the learned synapses, the section readout and the section model exist only for FlyWire. It
costs about 40% more GPU time than FlyWire (server load 0.44 vs 0.31 for three flies, measured side by side when it
was added, commit f248899). See `flybrain/malecns.py`.

## Visualiser

**🧠 Visualiser** (top right of the app) opens `viz.html` in its own window, so you can put it on a second screen. It
shows each fly's whole brain in 3D, at the real FlyWire position of every neuron and coloured by class. Every spike lights
up as it happens (up to 2,400 a frame across the flies; above that, a random sample).

With three flies, the two listener flies sit on top, each with its MIX / SPACE / PEAK sense meters. Their tapped descending
neurons stream into the DJ fly's left and right ears. These are the same taps the server wires into its ear bands.

A small panel on the side shows:
- the move being made, and the neurons whose burst fired it (they ring in the brain, with a line from the card)
- the transition queued for the next phrase, with a countdown
- the countdown to a drop
- the recent moves and the decks

The background flashes each move's colour, and each move has its own look, timed to the beat. Transitions and drops
send a shockwave through the brain. Drag turns the brains, the wheel zooms, hovering an output neuron names it, and
clicking it stimulates that cell type in that fly for 0.9 s. Keys: **H** hides the panel, **F** goes full screen.

Brain activity comes straight from the brain server. The moves, decks and beat come from the DJ app over a
`BroadcastChannel`, so open the visualiser from the app, in the same browser. If the server comes back with another
brain (other flies, the other connectome), the visualiser reloads and the DJ page shows a reload banner. If the GPU
drops the visualiser's WebGL context, it waits and reloads when the context comes back.

## Layout

```
flybrain/brain.py     the Shiu et al. LIF model on the CPU (Numba): dense and event-driven kernels
flybrain/gpu.py       the same model on the GPU (Apple silicon, MLX Metal kernels), all flies stepped together
flybrain/mapping.py   sensory inputs / DN+MN outputs from FlyWire annotations; neuron positions
flybrain/malecns.py   the whole male CNS connectome (brain + nerve cord) as an alternative to FlyWire
flybrain/server.py    aiohttp server: runs the flies in real time, streams spikes over WebSocket, serves song analyses
flybrain/ears.py      Python port of the app's ears, for training and recording
flybrain/train.py     synapse training (fit / online methods, split-ear option)
flybrain/sections.py  section sense: reference labels, per-bar features, classifier, learned arrangement
web/index.html        the DJ app;  web/viz.html  the visualiser
web/js/main.js        wiring: connection, crate, song analysis, control loop, UI, keyboard, tempo, visualiser feed
web/js/visualiser.js  viz.html: 3D brains (WebGL2), spikes, listener → DJ fly streams, move effects
web/js/decks.js       two decks: EQ, filter, rolls, scratching, brake, hot cues, scheduled jumps; crossfader; master bus
web/js/fx.js          master FX rack (sweeps, trans, crush, flanger, reverb) + sampler (horn, siren, boom…)
web/js/perform.js     DJ moves shared by fly and human: cue build & drop, drop swap, echo out, spin cut…
web/js/flydj.js       neurons → DJ decisions: moves, pace, transitions, exits, track picking, listener senses
web/js/sections.js    section sense in the browser, one per listener fly
web/js/djstyles.js    29 "play like" DJ styles from the research
web/js/setplan.js     energy arcs for a whole set, track intensity
web/js/mc.js          the fly on the mic (speech synthesis)
web/js/stems-worker.js drums / music separation for dropped tracks (web worker)
web/js/keylock-worklet.js key-lock pitch shifter (AudioWorklet)
web/js/ears.js        audio spectrum → Johnston's organ drive, per deck for the listener flies; habituation
web/js/synth.js       neurons → notes (club synth, or dhol + sitar) + MIDI out
web/js/tracks.js      club demo tracks, BPM/beat detection, hot cues; the analysed grid, sections and exit plan
web/js/desi.js        desi demo tracks: dhol, tabla, dholak, tumbi, sitar, tanpura, harmonium
web/js/analysis.js    key / Camelot, style and energy analysis of new music
web/js/viz.js         brain map, raster, ears, waveforms
brains/               trained synapses (trained_brain.npz and alternatives), section readout, section model, training logs
experiments/readout.py how brains/readout.json was built
tools/                benchmarks and tests (djbench, livetest, test_decks, gpucheck…), recording, section training,
                      song analysis (All-In-One, Demucs on MLX)
docs/                 notes, training, audits, handoff, research, changelog, git explainer
vendor/               Shiu et al. model + FlyWire v783 connectivity (cloned by run.sh)
data/                 annotations, caches, real tracks and their analyses (downloaded / generated, not in git)
```

Requirements: Python 3.10+ with `numpy pandas pyarrow numba aiohttp`, plus `mlx` on Apple silicon for the GPU (see
`requirements.txt`; `run.sh` uses `.venv` when it exists). Without MLX the flies run on the CPU. The song analysis
needs its own environment (`.venv-allin1`, with all-in-one-infer and demucs-mlx); without it, dropped tracks keep the
browser's grid and the listener flies' section sense. The browser tools in `tools/` need Node and `playwright-core`
(`tools/package.json`). The app is used in Safari and tested in headless Chrome. The first start takes about 10 s
longer, to build the connectome cache.

Data: FlyWire connectome (Dorkenwald et al. 2024, Schlegel et al. 2024, *Nature*). Model: Shiu et al. 2024, *Nature*.
Song structure: All-In-One (Kim & Nam 2023).
