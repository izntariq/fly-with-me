# Fly Brain DJ

A real fruit-fly brain makes music and DJs.

The complete adult *Drosophila* connectome (FlyWire v783: **138,639 neurons, 15,091,983 connections**) runs as a
spiking network in real time. Music goes into the fly's real auditory neurons. Its real descending and motor neurons
play a synth and work a two-deck DJ mixer.

```bash
./run.sh            # starts the brain server and opens http://localhost:8765
```

Press **Start the fly**. Two built-in demo tracks load right away. Drop your own audio files anywhere on the page to
add them to the crate; tempo and beat grid are detected automatically.

## What's actually happening

```
 deck A ──► left  Johnston's organ (12 JO-A/JO-B subtypes, 1 band each) ─┐
 deck B ──► right Johnston's organ                                        │   138,639-neuron
 🍬 / 🍋 ──► sugar / bitter gustatory neurons                              ├─► LIF brain model ──► 1,409 descending +
 wind   ──► JO-C/E wind & gravity neurons                                 ┘   (20 ms frames)       motor neurons
                                                                                                   │
            crossfader ◄── left vs right descending neurons (the fly "turns toward" a deck) ◄──────┤
            beat roll  ◄── DNp01 giant fiber (the escape-jump neuron)                              │
            echo throw ◄── DNp02 / DNp06 / DNp11 / DNp55                                           │
            backspin   ◄── bitter-driven DNp42 / DNpe007 / DNge067, MDN "moonwalker"              │
            filters    ◄── DNp12 / DNb05 / DNg56 (low-frequency hearing pathway), per side         │
            fly synth  ◄── every DN/MN is a key; motor neurons play bass, DNs play lead ◄──────────┘
```

* **The brain** (`flybrain/brain.py`) uses the same model and parameters as Shiu et al., *Nature* 2024
  ([repo](https://github.com/philshiu/Drosophila_brain_model)): leaky integrate-and-fire neurons, synaptic weight =
  synapse count × neurotransmitter sign × 0.275 mV, 1.8 ms delay, 2.2 ms refractory period, and Poisson drive for
  sensory input. I rewrote it in Numba with exact exponential integration, parallelized over CPU cores, so it runs
  about 4× faster than real time on an M3 Pro instead of minutes per second in Brian2.
  **Validation:** the paper's sugar-neuron experiment (21 sugar GRNs at 200 Hz) gives ~400 active neurons and
  ~20k spikes/s with feeding motor neurons firing, which matches the published result.
* **Inputs and outputs** (`flybrain/mapping.py`) are picked by cell type from the FlyWire annotations
  (Schlegel et al. 2024). JO-B neurons respond to low-frequency sound and JO-A to higher frequencies. Spreading
  individual subtypes across 12 frequency bands is an artistic tonotopy, not a measured one.
* **Findings that shaped the design:**
  * Loud high-frequency sound drives JO-A, which fires the **giant fiber** (DNp01), the fly's escape command neuron.
    That's a real circuit, so it became the "beat roll" move.
  * The ears are strongly lateralized: right-ear drive gives ~30× more right-side DN spikes than left-side ones.
    So left ear = deck A and right ear = deck B, and the fly steers the crossfader toward the ear it responds to
    more (phonotaxis).
  * **Olfactory input sends the model into self-sustaining runaway** (~800k spikes/s in the antennal lobe), so smell
    isn't wired in. The server auto-resets the brain if any input causes runaway.
* **Why the fly changes tracks.** The ear on the on-air deck habituates over ~75 s and a newly loaded track is novel,
  so preference drifts to the other deck. Mid-transition the DJ commits and does a bass swap. The off-air deck is
  restocked from the crate and beat-matched on the next bar. Without adaptation a static brain would stay on one deck
  forever. The adaptation lives in the browser (`web/js/ears.js`), not in the connectome model.

## DJ moves

Modelled on what headline DJs actually do: Carl Cox's cue builds (roll the same cue point with shrinking loop
lengths, then slam into the drop), Richie Hawtin's FX-as-an-instrument, turntablist scratches (Qbert, Jazzy Jeff,
A-Trak), and desi-set staples (air horn, dhol roll, siren). The fly fires them from neuron bursts; you can fire them
too with the pads or the keyboard. Everything is quantized to the beat.

| Group | Moves (key) |
|---|---|
| Beat FX | echo `Q`, reverb `W`, flanger `E`, trans gate `R`, bit-crush `T`, low-pass dip `Y`, high-pass sweep `U` (length: FX length buttons) |
| Rolls & scratch | loop roll ¼ `A` / ⅛ `S` / 1/16 `D`, baby `F`, chirp `G`, transformer `H`, flare `J` |
| Moves | **build & drop** `space` (⇧ = 8 bars), drop swap `B`, echo out `O`, spinback cut `P`, tape stop `K`, spinback `L`, beat jump `,` `.` |
| Sampler | air horn `Z`, dub siren `X`, laser `C`, boom `V`, riser `N`, dhol roll `M` |
| Hot cues | deck A `1`–`4`, deck B `7`–`0` (intro / build / drop / break; estimated from energy for your own tracks) |
| Tempo | master BPM slider, `-` / `=` (⇧ for 0.1), TAP, ↺ back to the track's tempo; both decks follow and stay phase-locked. Pitch moves with tempo (no key-lock). |

**Track selection.** When the off-air deck needs a new record, the fly previews up to 3 candidates in its cue ear
(about 4 s each, from their drop, like a DJ in headphones). It scores each by how hard that side's descending neurons
fire, discounts tracks it has already played, and loads the winner from the intro. Scores show in the crate (🎧).
Turn autopilot off and it goes back to crate order.

**Adapting to new music.** Every track you drop in is analysed for tempo (with a double-time check for drum &
bass), key (Krumhansl profiles → Camelot code), style (club / hip-hop / drum & bass / chill / desi — desi is
recognised from the file name) and an energy curve per bar. The fly then:
- plays its voice in the track's key (and switches to dhol + sitar for desi),
- changes its move set with the style: hip-hop → scratches instead of builds, chill → reverb/echo instead of chops,
  drum & bass → fast rolls,
- reaches for space (echo, reverb, flanger) in breakdowns and lets a drop breathe for 8 bars,
- times arousal builds so they land exactly on the track's own drop,
- cuts (echo out / spinback) instead of blending when tempos are far apart, and snaps or drifts the master tempo to
  each new track ("tempo follows each new track"),
- favours next tracks that are harmonic neighbours (Camelot ±1) and within 6% tempo.

Tempo detection is a heuristic: if a deck shows half or double the real BPM, hit **½×** / **2×** on the deck.

**The fly as DJ.** Transitions start on 16-beat phrase lines, and the style is picked by whichever neuron group is most
excited at that moment: giant fiber → drop swap, echo group → echo out, aversion neurons → spinback cut, calm → long
EQ blend with bass swap. A surge across all ~1,300 descending neurons triggers a cue build & drop. With *fly rides the
tempo* on, arousal pushes the BPM up by as much as 6%. **Epicness** scales how often and how hard it plays.

## Controls

| Control | What it does |
|---|---|
| **fly autopilot** | Off = you DJ and the fly just sings. Touching any EQ/filter or the crossfader overrides the fly (double-click a knob to hand it back). |
| **ears hear room mix** | The fly hears the master output instead of split cue, including its own synth (a feedback loop). |
| 🍬 Sugar / 🍋 Bitter | 3 s of taste stimulation. Sugar fires feeding motor neurons, so the fly "sings" louder. Bitter fires aversion neurons, so the fly rejects the playing track (backspin and cut). |
| Wind | Drives the JO-C/E wind & gravity neurons. |
| Fly voice | Level, quantize-to-beat (off = raw spike timing), scale, **MIDI out** (lead on ch 1, bass on ch 2) to drive any hardware or DAW synth. |
| Record set | Records the master output to a `.webm` download. |

The whole brain view is a frontal projection of every neuron: blue = sensory inputs, magenta = outputs, orange =
everything in between. The raster shows all 1,409 output neurons over the last 4 s.

## Layout

```
flybrain/brain.py     Numba LIF simulator (Shiu et al. model)
flybrain/mapping.py   sensory inputs / DN+MN outputs from FlyWire annotations
flybrain/server.py    aiohttp server: runs the brain in real time, streams spikes over WebSocket
web/js/decks.js       two decks, EQ, filter, loop roll, echo, backspin, crossfader
web/js/ears.js        audio spectrum → Johnston's organ drive, habituation
web/js/flydj.js       neurons → DJ moves
web/js/synth.js       neurons → notes (+ MIDI)
web/js/tracks.js      demo tracks (synthesized), BPM/beat detection
web/js/viz.js         brain map, raster, meters
vendor/               Shiu et al. model + FlyWire v783 connectivity (cloned by run.sh)
data/                 FlyWire annotations + caches (downloaded/generated)
```

Requirements: Python 3.10+ with `numpy pandas pyarrow numba aiohttp` (see `requirements.txt`) and a Chromium-based
browser or Firefox. First start takes ~10 s to build the connectome cache; after that it takes ~1 s.

Data: FlyWire connectome (Dorkenwald et al. 2024, Schlegel et al. 2024, *Nature*). Model: Shiu et al. 2024, *Nature*.
