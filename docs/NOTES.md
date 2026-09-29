# Project notes

Comprehensive notes on how Fly With Me (the Fly Brain DJ) works, what's real biology and what's artistic design, what was measured, and
why things are the way they are. For the version-by-version story see [CHANGELOG.md](CHANGELOG.md); for git see
[GIT.md](GIT.md).

---

## 1. Goal

Use an actual fly brain to make music, then to DJ with it. Here *actual fly brain* means the complete wiring
diagram of an adult fruit fly (*Drosophila melanogaster*) brain, reconstructed synapse by synapse from electron
microscopy by the FlyWire consortium, and simulated as a spiking network. It does not mean a living fly.

## 2. Architecture

```
┌──────────────── Python (flybrain/) ────────────────┐        ┌──────────────── Browser (web/) ────────────────────────┐
│                                                     │  drive │  decks A/B ──► EQ/filter ──► crossfader ──► FX rack ──►│
│  brain.py   138,639 LIF neurons, 15.1M connections  │ ◄───── │     │ cue taps                                limiter ─► 🔊
│             Numba, dt 0.25 ms, 4 threads             │ levels │     ▼                                                  │
│  mapping.py which neurons are ears / taste / outputs│        │  ears.js  FFT → 12 bands per ear → firing drive 0..1   │
│  server.py  20 ms frames, locked to wall-clock time  │ ─────► │  flydj.js spikes → moves, transitions, track picks     │
│             runaway guard                            │ spikes │  synth.js spikes → notes (club synth / dhol + sitar)   │
└─────────────────────────────────────────────────────┘  (WS)  │  perform.js / fx.js / decks.js  the DJ toolkit          │
                                                                └────────────────────────────────────────────────────────┘
```

**Timing.** The browser sends drive levels about 40 times a second. Every 20 ms of brain time the server runs 80
integration steps and sends back each output-neuron spike (with its time inside the frame), a sample of up to 1,500
spikes for the brain map, and the CPU load. Brain time is locked to wall-clock time; if it falls more than 250 ms
behind, it resynchronizes instead of trying to catch up.

**WebSocket protocol.**
- Browser → server: `{type: "drive", levels: {channel: 0..1}}` and `{type: "reset"}`.
- Server → browser, once: `{type: "hello", inputs, outputs, in_idx, out_idx, frame_ms}`.
- Server → browser, every frame: `{type: "frame", t, n, out: [[slot, ms]…], viz: [idx…], load, reset}`.

## 3. The brain model

Same model as **Shiu et al., *Nature* 2024** ("A Drosophila computational brain model reveals sensorimotor
processing", [repo](https://github.com/philshiu/Drosophila_brain_model)), running on the **FlyWire v783** public
connectome.

```
dv/dt = (v₀ − v + g) / τ_m      (frozen while refractory)
dg/dt = −g / τ                   (frozen while refractory)
v > v_th  →  spike, v = v_rst, g = 0, refractory 2.2 ms
presynaptic spike  →  g_post += w, 1.8 ms later
w = (synapse count × transmitter sign) × 0.275 mV
```

| Parameter | Value | Source (as cited by the paper) |
|---|---|---|
| v₀ = v_rst | −52 mV | Kakaria & de Bivort 2017 |
| v_th | −45 mV | " |
| τ_m | 20 ms | " |
| τ (synaptic) | 5 ms | Jürgensen et al. 2021 |
| refractory | 2.2 ms | Lazar et al. 2021 |
| delay | 1.8 ms | Paul et al. 2015 |
| w_syn | 0.275 mV | free parameter, fitted in the paper |
| Poisson kick | w_syn × 250 | enough to make the target spike |

**What's different from the original.** The paper uses Brian2, where one simulated second takes minutes. This
version is a Numba rewrite:
- Integration is exact over each step: the membrane/conductance pair is linear, so there's a closed-form update
  (`k_gv = τ/(τ−τ_m) · (e^{−dt/τ} − e^{−dt/τ_m})`).
- Delays and refractory periods are rounded to the 0.25 ms grid (7 and 9 steps).
- Neurons at rest with no input are skipped.
- Integration runs in parallel over 64 blocks of neurons; spike propagation is serial.
- Sensory drive is a per-neuron Poisson rate that can change every frame. The paper uses a fixed rate.

**Speed.** On an M3 Pro, 1 s of brain takes about 0.24 s with 12 threads and 0.44 s with 4 threads while the browser
is busy. It uses **4 threads** because every step has a barrier across threads, and one thread descheduled by a busy
browser stalls all of them. You can override this with `FLYBRAIN_THREADS`.

**Validation.** The paper's example experiment stimulates 21 right-side sugar gustatory neurons at 200 Hz. Here that
gives 20,145 spikes in 1 s, ~406 active neurons, and feeding motor neurons firing. The paper reports about 400 active
neurons. The serial and parallel kernels give exactly the same spike count.

## 4. Senses and outputs (FlyWire annotations, Schlegel et al. 2024)

| Input channel | Neurons | Max drive | Driven by |
|---|---|---|---|
| Left ear, 12 JO subtypes (JO-B1_a … JO-A5) | 3–77 each, 204 in total | 200 Hz | deck A cue (or room left channel) |
| Right ear, 12 JO subtypes | 1–28 each, 154 in total | 200 Hz | deck B cue (or room right channel) |
| Wind: JO-C/E | 433 | 120 Hz | Wind slider |
| Sugar: LB3 sugar/water gustatory neurons | 122 | 80 Hz | 🍬 button (3 s) |
| Bitter gustatory neurons | 65 | 100 Hz | 🍋 button (3 s) |

JO-B neurons really do respond to low-frequency sound (courtship song) and JO-A neurons to higher frequencies.
**Assigning each subtype to one frequency band (40 Hz – 12 kHz) is an artistic tonotopy, not a measured one.**

**Outputs:** all 1,299 descending neurons (brain → body commands) and 110 brain motor neurons.

### Measured in this model (and what it changed)

| Finding | Numbers | Consequence |
|---|---|---|
| High-frequency ear input fires the **giant fiber** DNp01, the escape-jump neuron | JO-A at 150 Hz → DNp01 at ~50 Hz | became the beat roll |
| Ears are strongly **lateralized** | right JO-A: 245 right-side vs 7 left-side DN spikes/s | left ear = deck A, right ear = deck B; crossfader = steering |
| JO-B (low-frequency) pathway | DNp12, DNb05, DNg56, DNg29 | per-side filter control |
| JO-C/E (wind) pathway | DNp18, DNpe017, DNbe001, DNb06 | reverb wash and siren |
| Bitter → aversion DNs | DNpe007, DNge067, DNp42 | backspin and cut ("reject the track") |
| Sugar → brain motor neurons | CB0700, MNx01, CB0248 … | the fly "sings" and hits the air horn |
| **Smell input runs away** | 68 DM1 neurons at 50 Hz → ~830k spikes/s, and it keeps going after the input stops | smell isn't wired in; server auto-resets on runaway |
| Bitter at 150 Hz plus music also ran away | — | bitter capped at 100 Hz |
| Visual photoreceptors (R7/R8) don't reach descending neurons within 1 s | 0 DN spikes | vision not used |

## 5. What's biology and what's design

This matters for claims about the project.

**Real (from the connectome model):**
- which neurons fire, when, and how hard, for a given sensory input
- the pathways: ear → giant fiber, ear laterality, bitter → aversion neurons, sugar → motor neurons

**Designed (by me, in the browser):**
- which neuron groups trigger which DJ move (the giant fiber could just as well have been mapped to echo)
- burst detection (fast rate above slow baseline), cooldowns, epicness
- ear habituation. The connectome model has **no adaptation or learning**; without the browser-side habituation a
  static brain would stay on one deck forever.
- the DJ craft: phrase alignment, bass swaps, build structure, harmonic mixing, tempo journeys
- the musical mapping of neurons to notes (cell-type name hash → scale degree)

**Not trained.** The fly brain is **not trained** on DJ sets or on anything else (and, by choice, won't be). Its synaptic weights are the FlyWire
wiring and never change. The DJ techniques are hand-coded moves and 29 "play like" styles, based on research into how big-name DJs play
live ([DJ_RESEARCH.md](DJ_RESEARCH.md)). The fly's spikes decide *when* and *how intense*; the chosen style decides
*what*. See §13 for how learning could be added.

## 6. Audio engine (`decks.js`, `fx.js`)

```
deck: source ─► input(slip gain) ─┐
      FX sources (rolls, scratches, brake, backspin) ─► fxIn ─┤─► low shelf ─► peak ─► high shelf ─► LPF ─► HPF ─► tap ─► xf gain ─► master
                                                                                                                  └─► echo send ─► echo bus
master ─► FX rack in ─► HPF ─► LPF ─┬─► trans gate ─► crush ─► flanger ─► out ─► limiter ─► speakers
                                    └─► reverb send ─► convolver ────────────────┘     (reverb sits before the gate, so its tail rings through drop gaps)
sampler (horn, siren, laser, boom, riser, dhol roll) ─► limiter
```

- **Slip mode.** Rolls, scratches, brakes and backspins play from separate sources while the main track keeps running
  silently underneath, so the track always comes back in on the grid.
- **Scratches.** Grains move back and forth over the hit under the needle with a triangle hand-speed curve (a
  reversed copy of the track handles the backward strokes), shaped by crossfader patterns: *baby* (open), *chirp*
  (fader closes at the end of each stroke), *transformer* (1/16 chops), *flare* (one click per stroke).
- **Cue build & drop** (Carl Cox style):
  1. Roll the same cue point at ½ → ¼ → ⅛ → 1/16 beat, with the last bar rising in pitch.
  2. At the same time: high-pass sweep, reverb wash, noise riser, and a dhol roll on desi tracks.
  3. One silent beat where only the reverb tail rings.
  4. The drop: boom and air horn, jumping to the track's drop cue if it's within 16 bars.
- **Tempo.** One master BPM drives every deck's playback rate (half and double time are folded). All decks change at
  the same instant, so they stay phase-locked.
- **Key lock** (`keylock-worklet.js`). Each deck passes through an AudioWorklet pitch shifter set to 1/rate.
  - **Method:** WSOLA (waveform-similarity overlap-add, as in SoundTouch). Hann grains of about 23 ms at 50% overlap
    read the input at `pitch` speed. Each new grain's read position is searched within ±5.8 ms for the best
    normalized cross-correlation with the grain already playing.
  - **Latency:** fixed, about 24 ms. Decks compensate by starting their sources and scheduling their mutes and ducks
    that much earlier, so what you hear is on the beat grid. Measured deck click minus grid: 24.7 ms before
    compensation, 0.7 ms after. Rolls, scratches, the fly's synth and the sampler bypass the shifter and are already
    on the grid.
  - **A/B against the v1.10 two-head shifter:** kick "tightness" (share of a hit's energy in its best 10 ms) is 52%
    unprocessed; the old shifter gave 45.7–48.5%, WSOLA gives 50.6–53.5%. A 440 Hz tone comes out at 440.1 Hz at
    every rate tested, versus 440.8–441.4 Hz before.
- **Stems.** Demo tracks are synthesized into separate drums and music buffers with identical mastering
  (`finishStems`). Dropped files go through harmonic–percussive separation in `stems-worker.js` (Fitzgerald 2010):
  1. STFT (2048 samples / hop 512).
  2. Median filter across 17 frames (sustained, harmonic sound) and across 17 frequency bins (hits, percussive).
  3. Soft Wiener masks split each frame; drums are rebuilt by overlap-add, and music = original − drums, so the
     stems add back up to the original exactly.
  4. A 90 s track takes ~5 s. A deck playing a track with stems runs two synced sources with their own mute gains.

## 7. The fly's ears (`ears.js`)

- A 2048-point FFT per ear gives the energy in each Johnston's-organ band. Each band's drive is its level within a
  36 dB window below a slowly decaying peak, plus an onset bonus.
- **Split mode:** left ear = deck A cue, right ear = deck B cue. **Room mode:** left and right channels of the master
  mix, so the fly hears itself too.
- **Habituation:** the ear on the on-air deck tunes out over ~75 s (gain down to 25%) and recovers over ~30 s when off
  air. A new track resets it (novelty).

## 8. The fly's voice (`synth.js`)

- Each output neuron has a fixed pitch: hash of its cell-type name → scale degree; right side plays an octave up; motor
  neurons play bass.
- Quantized mode: on every 16th note, the most active neurons since the last step play (up to 3, with one bass).
  Free mode plays each spike at its own time.
- **Club:** FM pluck lead with a square-wave bass. **Desi:** motor neurons play dhol strokes (dagga or tilli) and
  descending neurons play a Karplus-Strong sitar with *meend* (a glide into the note).
- The scale follows the on-air track's key or raga. MIDI out: lead on channel 1, bass on channel 2.

## 9. The fly as DJ (`flydj.js`, `perform.js`)

**Moves from neuron bursts.** A move fires when a group's fast rate (0.3 s) beats its slow baseline (10 s) by a ratio
plus a minimum, with cooldowns scaled by epicness and by style. There's also a 15 s warm-up and at least 4 beats
between any two moves.

| Group (neurons) | Move |
|---|---|
| All 1,299 descending neurons surging together | cue build & drop, timed to the track's own drop when one is 5–24 bars ahead |
| Giant fiber DNp01 (2) | loop roll ¼ or ⅛; tape stop on a very big burst |
| DNp02 · DNp06 · DNp11 · DNp55 (8) | echo or reverb throw |
| DNg24 · DNg29 (4) | scratch: baby → chirp → flare → transformer as intensity rises |
| DNb06 · DNge113 · DNge145 (11) | trans gate; crush on a big burst |
| DNg99 · DNp73 · DNge130 (6) | flanger or low-pass dip |
| DNp18 · DNpe017 · DNbe001 (6) | reverb wash, plus a siren on a big burst |
| DNp42 · DNpe007 · DNge067 · MDN (10) | spinback cut to the other deck |
| DNp12 · DNb05 · DNg56, per side (3 + 3) | continuous high-pass on that side's deck |
| Brain motor neurons (110) | voice swell and air horn |
| DNa01 · DNa02 steering (4, ×8 weight) + all left/right DNs | crossfader preference |

**Transitions.**
- *Preference* is right-minus-left descending-neuron activity, with the fixed wiring asymmetry removed by a slow
  running average.
- The fly leaves a track when its preference points to the other deck and its ear on the current deck has habituated
  (≥ 0.3), or when the track is about to end.
- Transitions start on the next **16-beat phrase line**. The style comes from the most excited group: giant fiber →
  drop swap, echo group → echo out, aversion → spinback cut, calm → a 16 s EQ blend with bass swap.
- If the two tracks' tempos are more than 8% apart (and not half or double), it always cuts instead of blending.

**DJ styles** (`djstyles.js`, research in [DJ_RESEARCH.md](DJ_RESEARCH.md)).
- **Moves:** each style maps each neuron group to a list of moves, mild → wild. The burst's intensity
  ((fast/slow − 1.2) / 2.5) picks one.
- **Transitions:** weights for blend, echo out, drop swap, spinback cut, hard cut, double drop and Fisher's 1-bar kill.
  They multiply how excited the matching neuron group is.
- **Builds:** each style picks its build (cue roll, snare roll, stutter, filter), its length, whether there's a horn,
  and how keen it is on building at all.
- **Timing and tempo:** blend length; minimum and maximum seconds a track stays on; a cooldown multiplier; the
  samples it hypes with; a home BPM range. The master tempo only drifts there if that needs less than an 8% pitch
  change.
- **Spike-written parts:** the Fred again.. chops and the Guetta 303 take their 16-step patterns straight from the
  last 16 brain frames. Busy frames play, quiet frames rest.

**Set planner** (`setplan.js`).
- **Arcs:** points of (fraction of the set, energy). While a set runs, epicness = 0.1 + 0.9 × energy.
- **Track picks:** multiplied by 1.5 − |track intensity − energy one minute ahead|. Track intensity = 0.45 × tempo
  + 0.3 × mean bar energy + 0.25 × style heat.
- **Tempo:** leans up to ±2.5%.
- **Peaks and dips:** crossing up through 0.9 triggers an 8-bar build in the current style; crossing down through
  0.45 triggers drums out (or a sing-along without stems). A crossing that lands mid-move waits until the fly is free.

**MC** (`mc.js`). Web Speech API.
- The phrase is picked by the latest spike count; there are per-style lines, and quiet styles say nothing.
- At most one shout per 20 s, except on drops.
- It can't be recorded, because speech synthesis has no audio node to capture.

**Track picking.**
1. The off-air deck needs a record.
2. Up to 3 unplayed or least-played candidates play from their drop in the cue ear, about 4 s each.
3. Each is scored by that side's descending-neuron spikes/s.
4. The score is divided by (1 + 0.35 × plays), with a ×1.15 bonus for Camelot neighbours and ×1.1 for tempos within 6%.
5. The winner loads from its intro.

Honest caveat: the ears normalize loudness, so scores for similar tracks are close. For demo tracks it's close to a
coin toss.

**Adapting to the style of what's playing.**

| Style | Cooldowns | Builds | Moves swapped |
|---|---|---|---|
| club, desi | ×1 | yes | — |
| hip-hop | ×1 | rare (×0.25) | rolls and trans → scratches |
| drum & bass | ×0.8 | yes | scratches → rolls |
| chill | ×2 | rare (×0.2) | rolls/trans/scratch → echo, reverb |

In breakdowns (bar energy < 0.4), chops become echo, reverb and flanger. For the first 8 bars after a drop, only
echoes are allowed.

**Tempo.** Arousal pushes the master tempo by up to ±6% ("rides the tempo"). After a blend, the tempo drifts to the
new track's own BPM over about 20 s; after a cut, it jumps on the landing beat.

## 10. Music

**Club demo tracks** (`tracks.js`): four techno tracks, 122–128 BPM, with kick, hats, clap, filtered saw bass, detuned
chord stabs and an FM arpeggio. Arrangement: intro 8 · build 8 · main 16 · break 4 · main 8 · outro 4 bars. Hot cues
at intro, build (bar 8), drop (bar 16), break (bar 32) and drop 2 (bar 36).

**Desi demo tracks** (`desi.js`), all synthesized sample by sample:

| Track | BPM | Raga | Groove | Lead |
|---|---|---|---|---|
| Dhol Descending Neuron | 116 | Kafi | dhol *chaal* (triplet swing, "dhin-ka") | tumbi hook |
| Tabla Theka Connectome | 120 | Yaman | tabla *keherwa*: Dha Ge Na Ti · Na Ka Dhi Na | sitar |
| Bhairav in the Mushroom Body | 118 | Bhairav | dholak, half-time | sitar |
| Proboscis Dhamaal | 124 | Khamaj | dhol chaal + four-on-the-floor | tumbi + harmonium |

The instruments:
- **Dhol:** dagga (bass side) is a pitched thump that drops plus a slap; tilli (treble side) is a stick crack.
- **Tabla:** dayan has harmonic partials (f, 2f, 3f, 4f); bayan "ghe" bends up in pitch.
- **Strings:** tumbi, sitar and tanpura use Karplus-Strong with a rectified "jawari" buzz.
- **Harmonium:** reed partials with bellows tremolo.
- The chimta was removed: its metallic ching on every offbeat was too tinny.

**Analysis of new tracks** (`tracks.js`, `analysis.js`):
- **BPM:** onset comb filter on a 160 Hz low-passed copy, searched from 85–175 BPM. If full-band hits land on the
  off-beats about as hard as on the beats, the tempo is doubled (drum & bass). ½×/2× buttons correct it by hand.
- **Key:** chroma from 48 FFT frames (80 Hz – 2 kHz), matched against Krumhansl-Kessler profiles, then converted to a
  Camelot code.
- **Style:**
  - desi if the file name matches words like bhangra, dhol, punjabi, bollywood, tabla…
  - ≥ 155 BPM → drum & bass
  - few onsets or low energy → chill
  - < 108 BPM → hip-hop
  - otherwise club
- **Energy:** RMS per bar, normalized. **Hot cues:** the biggest 4-bar energy jump is the drop, and the quietest
  stretch after it is the break.

## 11. Performance lessons

- Scheduling thousands of Web Audio nodes in an OfflineAudioContext took 76 s for two demo tracks. Direct synthesis
  into Float32Arrays takes under 1 s.
- Safari's drawing was using about 10 CPU cores, starving the simulator (up to 7× slower than real time). The fixes:
  - brain-map trails made by blending the base image instead of `lighter` compositing
  - cached waveform images
  - drawing capped at 30 fps
  - page updated only when a value changes
  - spike buffers bounded while the tab is hidden
  - the simulator on 4 threads
- Numba gotcha: mixing uint64 and int64 turns into float64, which broke a hand-rolled xorshift. The code uses
  Numba's `np.random` instead.

## 12. Testing

All testing was automated, with headless Chrome through `playwright-core`:
- **End-to-end runs of 30 s – 4 min:** beat-matched transitions, deck-phase checks, audio levels, no page errors.
- **Every pad and key pressed:** tempo nudges and tap; both decks' beat positions stayed an exact multiple of 4 apart.
- **BPM detection:** synthetic tracks at 131, 90 (hip-hop, E minor) and 172 (drum & bass, F major) BPM were all
  detected correctly, including both keys.
- **Brain model:** the paper's sugar experiment reproduced; the serial and parallel kernels give identical spikes.
- **Not verified:** how any of it sounds. Automated tests measured levels, not listening quality.

## 13. Ideas and next steps

- **Actually train the fly.** Some options, most biological first:
  - *Dopamine-gated plasticity:* the fly's own learning rule, where dopamine neurons driven by sugar (reward) or
    bitter (punishment) change the synapses of whatever was active. Press 🍬 when the fly does something you like and
    its wiring shifts toward doing it again.
  - *Learned readout:* keep the connectome fixed but learn which neuron groups should drive which move, from your
    feedback or from real DJ sets.
  - *Imitation from recordings:* analyse sets by great DJs (transition timing, effect use, phrase structure) and fit
    the readout to reproduce their choices.
- A cleaner key lock (phase vocoder / WSOLA) to remove the drum smear of the current shifter.
- Vocal-only stems (a small source-separation model), a third and fourth deck.
- More senses: vision (photoreceptors reaching the central brain needs longer runs), and smell once there's a stable
  way to drive the antennal lobe.
- Stems or vocal isolation for true acapella mashups and drum-outs; a third and fourth deck (Carl Cox, SHM);
  key-shifting acapellas; half-time/double-time switches; energy-arc scheduling for a whole set (Diplo, Guetta's
  yo-yo); swing (Kaytranada); recording the set with the neuron log.

## 14. References

- Shiu P.K. et al. (2024) *A Drosophila computational brain model reveals sensorimotor processing.* Nature.
  [github.com/philshiu/Drosophila_brain_model](https://github.com/philshiu/Drosophila_brain_model)
- Dorkenwald S. et al. (2024) *Neuronal wiring diagram of an adult brain.* Nature (FlyWire).
- Schlegel P. et al. (2024) *Whole-brain annotation and multi-connectome cell typing of Drosophila.* Nature.
  [github.com/flyconnectome/flywire_annotations](https://github.com/flyconnectome/flywire_annotations)
- Krumhansl C.L. (1990) *Cognitive Foundations of Musical Pitch* (key profiles).
- DJ technique research: [Carl Cox's techniques](https://wearecrossfader.co.uk/blog/carl-cox-mixing-techniques/),
  [Richie Hawtin: Technology Fuels Techno (Ableton)](https://www.ableton.com/en/pages/artists/richie_hawtin/),
  [QBert on turntablism (RBMA)](https://daily.redbullmusicacademy.com/2019/01/qbert-interview/),
  [Turntablism (Wikipedia)](https://en.wikipedia.org/wiki/Turntablism),
  [How to DJ Bhangra & Indian music (DJ Gym)](https://www.djgym.co.uk/post/how-to-dj-bhangra-indian-music)
