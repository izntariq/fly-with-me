# Project notes

Comprehensive notes on how Fly Brain DJ works, what's real biology and what's artistic design, what was measured, and
why things are the way they are. For the version-by-version story see [CHANGELOG.md](CHANGELOG.md); for the trained
synapses and the section sense see [TRAINING.md](TRAINING.md); for findings and corrections see [AUDIT.md](AUDIT.md);
for git see [GIT.md](GIT.md).

---

## 1. Goal

Make music with a real fly brain, then make it DJ. Here *real fly brain* means the complete wiring diagram of an
adult fruit fly (*Drosophila melanogaster*) brain, reconstructed synapse by synapse from electron microscopy by the
FlyWire consortium, and simulated as a spiking network. It does not mean a living fly.

## 2. Architecture

```
Python (flybrain/)                                       Browser (web/)
  server.py   20 ms frames locked to wall-clock time       decks A/B ─► EQ/filter ─► crossfader ─► FX rack ─► limiter ─► 🔊
              runaway guard; song analyses by SHA-1          │ raw taps (each track before EQ, filters and FX)
  gpu.py      all flies in one batch (MLX Metal)             ▼
  brain.py    the same model on the CPU (Numba)            ears.js      FFT → 12 bands → drive 0..1 for each listener fly
  mapping.py  ears / taste / outputs by cell type          sections.js  where each deck is in its track (unanalysed tracks)
                                                           flydj.js     the DJ fly's spikes → moves, transitions, track picks
  fly 1 (listener A) ─┐                                    synth.js     spikes → notes (club synth / dhol + sitar)
  fly 2 (listener B) ─┴─ 12 DN taps ─► fly 3 (DJ fly)      perform.js / fx.js / decks.js   the DJ toolkit

          ◄── drive levels for each fly, pokes, reset ────────────────────────────────────
          ─── hello once; then every 20 ms: each fly's output spikes, a sample for the brain views, load ──►   (WebSocket)
```

**Timing.**
- The browser sends drive levels about 40 times a second.
- Every 20 ms of brain time the server steps every fly 80 integration steps of 0.25 ms.
- With three flies it then sets the DJ fly's ear drive for the next frame from the listeners: the mean rate of each
  tapped cell type, smoothed over 100 ms, where 40 Hz drives a band fully.
- It sends back each fly's output-neuron spikes (with their times inside the frame), a sample of spikes for the brain
  views (up to 2,400 a frame, split between the flies), and the load (compute time ÷ frame time).
- Brain time is locked to wall-clock time. If it falls more than 250 ms behind, it resynchronizes instead of trying to
  catch up. With no client connected the loop idles.

**WebSocket protocol.**
- Browser → server:
  - `{type: "drive", levels: {channel: 0..1}, levels2: {…}, levels3: {…}}`: one set of levels per fly (listener A,
    listener B, the DJ fly). The DJ fly's ear channels are ignored, because its ears are wired to the listeners.
  - `{type: "poke", fly, idx: [neuron…], hz, ms}`: extra Poisson drive on up to 64 neurons of one fly (the
    visualiser's click), capped at 300 Hz, 3 s and 16 live pokes per fly.
  - `{type: "reset"}`.
- Server → browser, on every connection: `{type: "hello", trained, flies, connectome, sections, dj_taps,
  dj_tap_types, n_neurons, n_connections, frame_ms, inputs, outputs, in_idx, out_idx}`. `trained` carries the section
  readout; `sections` is the section model for the listener flies.
- Server → browser, every frame: `{type: "frame", t, n, out, outs, viz, vizs, load, reset}`. `outs` holds one
  `[[slot, ms]…]` list per fly and `vizs` one sample of neuron indices per fly; `out` and `viz` are fly 1's.
- **A changed brain.** Both pages fingerprint the hello (flies, connectome, neurons, connections, inputs, outputs,
  learned synapses). A reconnect to the same brain carries on. A different one (a restart with `--flies 2`, the male
  CNS, another trained brain) makes the visualiser reload, and the DJ page stop driving the flies and show a reload
  banner (before the start it just reloads).
- **Each client** gets its own 4-frame queue and sender task. A page that stops reading (a paused tab, a debugger)
  loses its oldest frames instead of stalling the brain for everyone.
- When the page that drives the flies disconnects (or the last client goes), every fly's drive is set to zero, so the
  flies don't keep hearing the last spectrum while the visualiser stays connected. A reset a page asks for is applied
  by the frame loop between frames.

**HTTP.**
- `/` and `/viz.html` are generated per request, with every script and stylesheet URL stamped with its file's
  modification time (and an import map that does the same for every module), sent with `no-store`. Everything else
  gets `no-cache`. Safari once kept running stale copies of the app; this stops that.
- `/brain_xy.bin`, `/brain_xyz.bin`: 2D and 3D positions of every neuron, for the brain views.
- `GET /analysis/<sha1>`: 200 the track's beat grid and sections; 202 `{status: "queued" | "indexing"}` while it's
  queued or the server is still hashing the library; 404 unknown; 410 `{status: "failed"}`, terminal, when its
  analysis failed. A run whose analyser was killed by a signal (Ctrl-C on the server reaches it too; macOS kills under
  memory pressure) isn't marked failed, so the track can be tried again.
- `POST /analysis/<sha1>` uploads an unknown file for background analysis (§10): 202 queued; the GET answer when no
  upload is needed (known, queued, indexing or failed); 400 if the file doesn't hash to the sha; 413 over 400 MB; 503
  when no analyser is installed. Uploads are streamed to disk and hashed a few MB at a time in a worker thread, off the
  event loop.
- **Who may connect.** Every request must name this machine in its Host header: `localhost`, `127.0.0.1`, `::1` or the
  `--host` name. Bound to every interface (`--host 0.0.0.0` or `::`), any IP address is allowed too, so a phone can
  use `http://<the Mac's IP>:8765`; reaching it by a name (`mymac.local`) needs `--host <that name>`. A page's Origin,
  when it sends one, must be this machine by name or the very host the request went to. That stops DNS rebinding,
  and stops a page served from another address opening the websocket (websockets have no CORS).

**The DJ page** (`main.js`).
- The control loop (drive levels, the DJ's decisions, the tempo) runs 40 times a second on a worker's timer: WebKit
  can slow a hidden page's own timers to once a second, even while it plays audio.
- **Crate memory.** Decoded audio is big (a 4-minute track: about 90 MB, about 270 MB with stems). Only the decks'
  tracks (with their stems), the fly's audition and the next few candidates keep it. The rest are released and decoded
  again from their File ahead of time, or on load. A big drop is trimmed every 4 files. A track that decoded before
  but fails to decode again (memory pressure) sits out a minute; a file that can't be read any more leaves the crate.
- **Drops.** A file whose SHA-1 is already in the crate or on a deck is skipped. Each drop keeps its own order, even
  when two drops overlap.
- A load that finishes decoding after its deck came on air, or while a transition is lined up, is dropped rather than
  swapping the track mid-transition.
- With two or three flies the "ears hear room mix" toggle is disabled: each listener hears its own deck.
- The tempo keys work on the numpad and on other keyboard layouts, and ⇧ gives the fine step. Download links (a
  recording, an exported set) stay valid for 10 minutes, since Safari may ask before saving.
- The visualiser asks for the move history again once its hello is in, and waits out a lost WebGL context (Safari
  drops them under GPU memory pressure), reloading when it comes back.

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

**What's different from the original.** The paper uses Brian2, where one simulated second takes minutes. Here:
- Integration is exact over each step: the membrane/conductance pair is linear, so there's a closed-form update
  (`k_gv = τ/(τ−τ_m) · (e^{−dt/τ} − e^{−dt/τ_m})`).
- Delays and refractory periods are rounded to the 0.25 ms grid (7 and 9 steps).
- Sensory drive is a per-neuron Poisson rate that can change every frame. The paper uses a fixed rate.
- Poisson kicks follow Brian's PoissonInput, on both the CPU and GPU paths. A kick still adds to v while the neuron
  is refractory, but the threshold isn't checked then. A spike caused by a kick starts a refractory period like any
  other spike.
  - Before Audit 4 (item 14), kicks could fire a neuron while it was refractory, and they didn't start one. Strongly
    driven input neurons then fired about 8–15% faster than in the paper.

**On the CPU** (`flybrain/brain.py`, Numba; the server's `--cpu`):
- The dense kernel integrates in parallel over 64 blocks of neurons, with serial spike propagation. Neurons at rest
  with no input are skipped.
- The event-driven kernel (`_run_active`) updates only neurons on an active list (those that got input and aren't
  back at rest). On one thread it takes 0.23 s per brain-second against 0.59 s for the dense kernel. On the sugar
  test (before the refractory fix) it gave 19,724 spikes and 389 active neurons against 20,145 and 406; the
  difference is float ordering near threshold. `FLYBRAIN_KERNEL=dense|event` picks one.
- With two or three flies, each fly runs in its own worker process (`--serial` steps them in turn in one process).
- Speed: on an M3 Pro, 1 s of one brain takes about 0.24 s with 12 threads and 0.44 s with 4 threads while the
  browser is busy. A brain in the server's own process (one fly, or `--serial`) uses up to 4 threads, because every
  step has a barrier across threads and one thread descheduled by a busy browser stalls all of them. With two or
  three flies each worker process gets 3 threads with the dense kernel (the default there; it measured best live,
  load about 1.04 against 1.16 event-driven), or 1 with the event-driven one. `FLYBRAIN_THREADS` overrides the
  single-process count.

**On the GPU** (`flybrain/gpu.py`, MLX custom Metal kernels; the default on Apple silicon):
- All flies share the wiring and step together.
- The trick is the synaptic delay. A spike reaches its targets 7 steps later, so within a window of 5 steps no neuron
  can affect another. Each window is two kernel launches:
  1. *integrate:* one GPU thread per (fly, neuron) advances it 5 steps and records which steps it spiked in
  2. *propagate:* one thread per spiking neuron adds its synaptic weights (atomic adds) into the next window's
     arrival slots
- At the end of each frame a third kernel (*collect*) compacts every spike of every fly into a short list on the GPU.
  Per-fly spike counts stay exact even if that list overflows.
- Random numbers come from a stateless hash per (fly, neuron, step).
- A neuron listed twice in the stimulus (two channels, or a channel and a poke) gets the sum of its rates, as on the
  CPU.
- Speed per brain-second (`tools/gpucheck.py`): 1 fly 0.15 s, 3 flies 0.33 s, 18 flies 1.9 s. In the server, a 20 ms
  frame for 3 flies takes about 6.5 ms (load 0.33) since the collect kernel (cae07d2), against a load of 0.39 before.
  Measured again beside the male CNS (f248899) it was 0.31.
- MLX GPU streams belong to the thread that made them, so the server sends every MLX call through one dedicated
  thread.

**Validation.** The paper's example experiment stimulates 21 right-side sugar gustatory neurons at 200 Hz. The paper
reports about 400 active neurons.
- On the CPU it gave 20,145 spikes in 1 s, ~406 active neurons, and feeding motor neurons firing. The serial and
  parallel CPU kernels give exactly the same spike count. These figures predate the refractory fix (Audit 4) and
  haven't been re-measured.
- On the GPU (`tools/gpucheck.py`), since the fix: 18.8k–19.5k spikes and 386–392 active neurons over 3 seeds, and
  34.1k spikes with 509 active neurons for the music-like drive. Before the fix the GPU gave 19.6k–20.5k spikes and
  390–413 active neurons.

## 4. Senses and outputs (FlyWire annotations, Schlegel et al. 2024)

| Input channel | Neurons | Max drive |
|---|---|---|
| Left ear, 12 JO subtypes (JO-B1_a … JO-A5) | 1–77 each, 204 in total | 200 Hz |
| Right ear, 12 JO subtypes | 1–28 each, 154 in total | 200 Hz |
| Wind: JO-C/E | 433 | 120 Hz |
| Sugar: LB3 sugar/water gustatory neurons | 122 | 80 Hz |
| Bitter gustatory neurons | 65 | 100 Hz |

JO-B neurons really do respond to low-frequency sound (courtship song) and JO-A neurons to higher frequencies.
**Assigning each subtype to one frequency band (40 Hz – 12 kHz) is an artistic tonotopy, not a measured one.**

**Who hears what:**

| Fly | Left ear | Right ear | Taste and wind |
|---|---|---|---|
| Listener A (fly 1) | deck A's raw track | deck A's raw track | – |
| Listener B (fly 2) | deck B's raw track | deck B's raw track | – |
| DJ fly (fly 3) | listener A's 12 tapped DN types | listener B's 12 tapped DN types | 🍬 🍋 wind |
| Single fly (`--flies 1`) | deck A cue (or the room's left channel) | deck B cue (or the room's right channel) | 🍬 🍋 wind |

The tapped types, one per ear band (`LISTENER_TAPS`): DNp55, DNge145, DNge113, DNp12, DNg24, DNg29 (the section
readout's neurons; all but DNp12 are trained), then DNp01, DNp02, DNg84, DNp11, DNg99, DNb05. Each type's rate is
pooled over both sides.

**Outputs:** all 1,299 descending neurons (brain → body commands) and 110 brain motor neurons. With the male CNS
(`--connectome malecns`), its 708 leg and wing motor neurons join them.

### Measured in this model (and what it changed)

| Finding | Numbers | Consequence |
|---|---|---|
| High-frequency ear input fires the **giant fiber** DNp01, the escape-jump neuron | JO-A at 150 Hz → DNp01 at ~50 Hz | became the beat roll |
| Ears are strongly **lateralized** | right JO-A: 245 right-side vs 7 left-side DN spikes/s | left ear = deck A, right ear = deck B; crossfader = steering |
| JO-B (low-frequency) pathway | DNp12, DNb05, DNg56, DNg29 | per-side filter control |
| JO-C/E (wind) pathway | DNp18, DNpe017, DNbe001, DNb06 | reverb wash and siren |
| Bitter → aversion DNs | DNpe007, DNge067, DNp42 | the fly wants off the track |
| Sugar → brain motor neurons | CB0700, MNx01, CB0248 … | the fly "sings" and hits the air horn |
| **Smell input runs away** | 68 DM1 neurons at 50 Hz → ~830k spikes/s, and it keeps going after the input stops | smell isn't wired in; the server auto-resets a fly on runaway |
| Bitter at 150 Hz plus music also ran away | — | bitter capped at 100 Hz |
| Visual photoreceptors (R7/R8) don't reach descending neurons within 1 s | 0 DN spikes | vision not used |
| One fly splitting its ears between two decks loses the trained section signal | see TRAINING.md | one listener fly per deck, each hearing one track in both ears |

## 5. What's biology and what's design

This matters for claims about the project.

**Real (from the connectome model):**
- which neurons fire, when, and how hard, for a given sensory input
- the pathways: ear → giant fiber, ear laterality, bitter → aversion neurons, sugar → motor neurons

**Changed by training** (this branch): 9,978 synapses onto 25 descending neurons, about 0.07% of the
connections (TRAINING.md). The server loads them by default (`--brain auto`); `--brain naive` runs the untouched
FlyWire wiring. The section model (`brains/sections_trained.json`) and the readout load only with the trained brain
(there's no `sections_naive.json`), so a naive run has neither: on tracks without an analysis the fly has no section
sense. Every fly gets the same trained synapses, the DJ fly included, although it hears listener taps rather than
music. The training made those neurons fire more in their target sections, but on 131 real tracks a section
model built on the trained brain's outputs scores no better than one built on the untrained brain's, or on the fly's
own ear input.

**Designed (by me, in the browser and the tools):**
- which neuron groups trigger which DJ move (the giant fiber could just as well have been mapped to echo)
- burst detection (fast rate above slow baseline), cooldowns, the pace target, epicness
- ear habituation. The simulation has **no adaptation or learning while it plays**; the habituation that makes the
  fly want the other deck is computed in the browser.
- the chain of three flies and which listener neurons feed the DJ fly's ears
- the section model: a logistic classifier and an arrangement prior fitted on top of the listener flies' neurons
- the DJ craft: phrase alignment, planned exits, bass swaps, build structure, harmonic mixing, tempo journeys
- the musical mapping of neurons to notes (cell-type name hash → scale degree)

**Not from the fly:** the beat grid and song structure of analysed tracks come from the All-In-One analyzer (§10).

**Where the fly comes in:** it's the performer and the source of taste. Its bursts time the moves, its most excited
group picks the transition style, its steering says when it wants the other deck, and its listener's response picks
the next track.
The DJ techniques are hand-coded moves and 29 "play like" styles, based on research into how big-name DJs play live
([DJ_RESEARCH.md](DJ_RESEARCH.md)). The fly's spikes decide *when* and *how intense*; the chosen style decides
*what*.

## 6. Audio engine (`decks.js`, `fx.js`)

```
deck: sources (full mix, or drums + music stems with their own mutes) ─► input ─► slip gain ─► [key lock] ─┐
      FX sources (rolls, scratches, brake, backspin) ─► fxIn ──────────────────────────────────────────────┤
      ┌────────────────────────────────────────────────────────────────────────────────────────────────────┘
      └─► low shelf ─► peak ─► high shelf ─► LPF ─► HPF ─► tap ─► xf gain ─► master
                                                            └─► echo send ─► echo bus
      each source also feeds rawTap directly (before stem mutes, the slip mute, EQ and FX): what listener flies hear
master ─► FX rack in ─► HPF ─► LPF ─┬─► trans gate ─► crush ─► flanger ─► out ─► limiter ─► speakers
                                    └─► reverb send ─► convolver ────────────────┘     (reverb sits before the gate, so its tail rings through drop gaps)
sampler (horn, siren, laser, boom, riser, dhol roll) ─► limiter
```

- **Slip mode.** Rolls, scratches, brakes and backspins play from separate sources while the main track keeps running
  silently underneath, so the track always comes back in on the grid. Overlapping moves share one slip-mute schedule.
- **Scheduled jumps.** Beat jumps, hot cues and cue-backs are scheduled on the grid. The current audio keeps playing
  until the jump's time, then crossfades over 5 ms. A deck keeps a list of scheduled jumps, so they can stack, and a
  later jump, a stop or a load also stops the sources a jump took over from. `tools/test_decks.mjs` checks this from
  rendered audio.
- **Scratches.** Grains move back and forth over the hit under the needle with a triangle hand-speed curve, shaped by
  crossfader patterns: *baby* (open), *chirp* (fader closes at the end of each stroke), *transformer* (1/16 chops),
  *flare* (one click per stroke). Backward strokes, and the reverse move, play a reversed copy of only the short
  stretch they need (`reversedWindow`), not of the whole track.
- **Cue build & drop** (Carl Cox style):
  1. Roll the same cue point at ½ → ¼ → ⅛ → 1/16 beat, with the last bar rising in pitch.
  2. At the same time: high-pass sweep, reverb wash, noise riser, and a dhol roll on desi tracks.
  3. One silent beat where only the reverb tail rings.
  4. The drop: boom and air horn, jumping to the track's drop cue if it's within 16 bars.
- **Tempo.** One master BPM drives every deck's playback rate. All decks change at the same instant, so they stay
  phase-locked. Half and double time are folded (×½ when the master is over 1.4× the track's tempo, ×2 under 0.7×).
  The fold is picked once per load, and again after a tempo correction (`Mixer.rateFor`), so a glide or the tempo
  ride can't halve or double a deck's rate in one step. `Mixer.tempoOf` gives a track's tempo in the set's frame.
- **Timing of moves.**
  - Beat FX run on the on-air deck's beat, which is half or double the master on a folded track.
  - Filter and reverb moves continue from wherever the parameter is (`holdAt`, using `cancelAndHoldAtTime`) instead
    of snapping back; on an idle parameter they start from its resting value.
  - EQ kills (double drops, mashups, teases) are scheduled on the audio clock. Hard cuts ramp over about 5 ms, so a
    sustained bass doesn't click.
  - Overlapping echo throws extend each other. The echo's delay time retunes slowly to a new tempo, so a ringing
    echo-out tail doesn't bend in pitch.
  - A spinback keeps the deck muted until the cut lands.
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
  (`finishStems`). A dropped file is split when it's loaded on a deck, not when it's dropped, and only deck tracks keep
  their stems (crate memory, §2). Tracks over 12 minutes get none (`STEM_MAX_S`: the worker holds the whole
  spectrogram). The split is harmonic–percussive separation in `stems-worker.js` (Fitzgerald 2010):
  1. STFT (2048 samples / hop 512).
  2. Median filter across 17 frames (sustained, harmonic sound) and across 17 frequency bins (hits, percussive).
  3. Soft Wiener masks split each frame; drums are rebuilt by overlap-add, and music = original − drums, so the
     stems add back up to the original exactly.
  4. A 90 s track takes ~5 s. The deck plays the full mix until the stems are ready, then switches on a bar line. A
     deck playing a track with stems runs two synced sources with their own mute gains.

## 7. The fly's ears (`ears.js`)

- A 2048-point FFT gives the energy in each Johnston's-organ band. Each band's drive is its level within a 36 dB
  window below a slowly decaying peak, plus an onset bonus.
- **Listener flies (two or three flies):** each deck's raw track, taken straight from its sources before stem mutes,
  the slip mute, EQ, filters and FX, drives both ears of that deck's listener fly. Otherwise the fly's own filter
  sweeps, bass kills and loop rolls would rewrite what it hears, a feedback loop that never existed in training.
- **Single fly:** *split mode* sends deck A's cue to the left ear and deck B's to the right. *Room mode* sends the
  left and right channels of the master mix, so the fly hears itself too.
- **Habituation:** the on-air deck tunes out over ~75 s and recovers over ~30 s when off air; a new track resets it.
  With a single fly in split mode it turns that ear's drive down (to 25%). With listener flies it's only tracked: it
  tells the DJ logic how long the fly has been listening, and isn't applied to the drive.

## 8. The fly's voice (`synth.js`)

- Each output neuron has a fixed pitch: hash of its cell-type name → scale degree; right side plays an octave up; motor
  neurons play bass.
- Quantized mode: on every 16th note, the most active neurons since the last step play (up to 5, at most one of them
  a bass note).
  Free mode plays each spike at its own time.
- **Club:** FM pluck lead with a square-wave bass. **Desi:** motor neurons play dhol strokes (dagga or tilli) and
  descending neurons play a Karplus-Strong sitar with *meend* (a glide into the note).
- The scale follows the on-air track's key or raga. MIDI out: lead on channel 1, bass on channel 2.
- The performing fly plays: the DJ fly with three flies.

## 9. The fly as DJ (`flydj.js`, `perform.js`)

**Moves from neuron bursts.** A burst is a group's fast rate (0.3 s) beating its slow baseline (10 s) by a ratio plus
a minimum. Both are scaled by the pace threshold (below). Cooldowns are scaled by epicness, the DJ style and the
track's style, but a group's cooldown never drops below 2 bars. There's a 15 s warm-up and at least 2 beats between
any two bursts (4 with phrase timing off), also scaled.

| Group (neurons) | Move |
|---|---|
| All 1,299 descending neurons surging together | cue build & drop, timed to the track's own drop when one is 5–24 bars ahead |
| Giant fiber DNp01 (2) | loop roll ¼ or ⅛; tape stop on a very big burst |
| DNp02 · DNp06 · DNp11 · DNp55 (8) | echo, reverb or dub throw |
| DNg24 · DNg29 (4) | scratch: baby → chirp → flare → transformer as intensity rises |
| DNb06 · DNge113 · DNge145 (11) | trans gate, crush or stutter |
| DNg99 · DNp73 · DNge130 (6) | flanger, low-pass dip or resonant filter |
| DNp18 · DNpe017 · DNbe001 (6) | reverb wash or sweep, plus a siren on a big burst |
| DNp42 · DNpe007 · DNge067 · MDN (10) | a low-pass dip; past the minimum time on air the fly also wants off the track |
| DNp12 · DNb05 · DNg56, per side (3 + 3) | continuous high-pass on that side's deck |
| Brain motor neurons (110) | voice swell and air horn |
| DNa01 · DNa02 steering (4, ×8 weight) + all left/right DNs | crossfader preference |

**On the phrase.**
- Bursts don't play at once. Each group keeps one waiting move (the stronger burst wins), at most 3 in all, and a move
  older than 8 bars is dropped. Aversion bursts skip the queue.
- The on-air deck's bar grid has a slot every bar in verses, choruses and main sections, and every 2 bars elsewhere.
  The move is released on the last beat before the line, so it lands on it (the Performer plays from the next beat).
- Each slot plays the strongest burst, discounted by how often its group played in the last 2 minutes.
- No new moves while a transition is lined up, or in the 8 bars before an analysed track's planned exit.
- **Moves end before the exit.** A move must be over 4 bars before an analysed track's `mixBar` (`exitRoom`). Phrase-
  long moves (mashup, loop layer, strip to drums, drums out, sing-along, acid, chops) that wouldn't be become an echo
  throw, and builds are halved (down to 2 bars) or skipped (`buildBars`).

**Pace.** A moves-per-minute target (default 8, slider 2–20, divided by the style's and the track style's cooldown
multipliers) slowly nudges a burst threshold between 0.25 and 2, over about half a minute, and only while the fly is
free to play. The strongest bursts still pick the moves.

**Fit and variety.**
- When the on-air section is known with confidence above 0.55 (always, on an analysed track), moves are swapped for
  ones that suit it: filter-type moves in intros, echo and filters in outros, echo, reverb wash and filters in
  breakdowns.
- Scratches only play in choruses and verses (or when the PEAK sense is on).
- Each family rotates its variants (echo / reverb / dub, trans / crush / stutter, flanger / low-pass / resonant
  filter), never the same one twice in a row.
- **Big moves:** with the default style, a strong burst (intensity ≥ 1.8) released on a 4-bar line in a chorus plays a
  big move instead, at most once every 32 bars (scaled by epicness): live chops (giant fiber or scratch group), bass
  tease or drums out (echo group), pump (trans), acid (flange), sing-along (wind).
- **Breakdown onset:** when the on-air deck enters a breakdown, the fly throws an echo, a reverb or (30% of the time,
  with stems) drums out, at most once every 16 beats.

**Leaving a track.**
- *Preference* is right-minus-left descending-neuron activity, with the fixed wiring asymmetry removed by a slow
  running average. With three flies, the DJ fly's left side hears listener A and its right side listener B.
- *Time on air* counts while a track is the on-air deck, through mashups and double drops (which move the fader off
  the end stop); only a blend in progress pauses it. A new deck or track on air restarts it.
- The fly *wants* to leave when its preference points to the other deck (> 0.12) and its ear on the on-air deck has
  habituated (≥ 0.3), after its minimum time on air (45 s by default, or the style's minimum if that's longer). It
  also wants to leave past the style's maximum, after its aversion neurons fired, or (trained brain) while a mixing
  window is sensed and its ear has started to habituate (≥ 0.1).
- **The mixing gate** decides whether it may:

  | Track | Mixes out |
  |---|---|
  | Analysed | at the planned exit (`mixBar`), decided 4 bars ahead once the minimum time on air has passed; earlier only if it wants to leave and the deck is in a breakdown in the last 40% of the track; after 4 minutes on air in any case |
  | Section sense | in a sensed outro (confidence > 0.6) after the minimum time; if it wants to leave, in a breakdown sensed at ≥ 0.85 for 2 bars in the last 30% of the track; after 4 minutes; or as the track ends |
  | Neither | when it wants to, or as the track ends |

**Transitions.**
- **Style:** the most excited group picks it: giant fiber → drop swap, echo group → echo out, aversion → spinback cut,
  calm → an EQ blend with bass swap. DJ styles weight these and add hard cuts, double drops and Fisher's 1-bar kill.
- **What's allowed:** beat-matched blends and double drops need a steady 4/4 grid on both decks. Tracks that aren't
  steady, and planned exits with a short outro, get cuts, echoes, spins, kills or drop swaps. Late for an exit, only
  the styles that still finish before the end are allowed. At an analysed exit a double drop needs 36 beats of the
  outgoing track after it lands.
- **Double drops** are sized when they fire to what the outgoing track has left: whole 4-bar phrases, up to 16 bars.
  Under 4 bars it becomes a drop swap.
- **Tempo gap:** if the two tracks' tempos (after the fold) are more than 8% apart (16% with key lock), and not half or
  double within 6%, it always cuts, echoes or spins out instead of blending.
- **Landing:** each transition lands on the analysed exit bar if that is within reach, otherwise on the next 16-beat
  phrase line, or the next bar line when a phrase line would leave no room before the end. It starts early by its
  style's lead (blend 0 beats, echo / spin / cut 4, kill 8, drop swap and double drop 12), so its cut or drop lands
  on the line.
- **Blend length:** the style's (8 bars by default), but never more than 85% of the time left in the outgoing track.
  A blend can only reverse in its first 30%.
- **The incoming track:** with analysed sections or section sense, blends and cuts cue it so its first bar lands on the
  landing line. Otherwise, if it wouldn't have room for the minimum time on air, it's cued back by whole 16-beat
  phrases while still off air, which keeps it in phase.
- **Tempo:** the incoming cue is a jump timed on the current tempo, so the master tempo holds still from the plan
  until the landing.
- An overdue transition (held by a lock) is re-planned with its lead, re-checked against the room left, and the
  incoming deck re-cued.
- Turning the autopilot off forgets a lined-up transition.

**DJ styles** (`djstyles.js`, research in [DJ_RESEARCH.md](DJ_RESEARCH.md)).
- **Moves:** each style maps each neuron group to a list of moves, mild → wild. The burst's intensity
  ((fast/slow − 1.2) / 2.5) picks one.
- **Transitions:** weights for blend, echo out, drop swap, spinback cut, hard cut, double drop and Fisher's 1-bar kill.
  They multiply how excited the matching neuron group is.
- **Builds:** each style picks its build (cue roll, snare roll, stutter, filter), its length, whether there's a horn,
  and how keen it is on building at all.
- **Timing and tempo:** blend length; minimum and maximum seconds a track stays on; a cooldown multiplier; the
  samples it hypes with; a home BPM range. The master tempo only moves there if that needs less than an 8% pitch
  change (20% with key lock).
- **Spike-written parts:** the Fred again.. chops and the Guetta 303 take their 16-step patterns straight from the
  last 16 brain frames. Busy frames play, quiet frames rest.

**Set planner** (`setplan.js`).
- **Arcs:** points of (fraction of the set, energy). While a set runs, epicness = 0.1 + 0.9 × energy.
- **Track picks:** multiplied by 1.5 − |track intensity − energy one minute ahead|. Track intensity = 0.45 × tempo
  + 0.3 × mean bar energy + 0.25 × style heat.
- **Tempo:** leans up to ±2.5%.
- **Peaks and dips:** crossing up through 0.9 triggers a build of up to 8 bars in the current style (shorter, or
  none, near an analysed track's exit); crossing down through 0.45 triggers drums out (or a sing-along without stems).
  A crossing that lands mid-move waits until the fly is free.

**MC** (`mc.js`). Web Speech API.
- The phrase is picked by the latest spike count; there are per-style lines, and quiet styles say nothing.
- At most one shout per 20 s, except on drops.
- It can't be recorded, because speech synthesis has no audio node to capture.

**Track picking.**
1. The off-air deck needs a record: it's empty or stopped, its track is within 45 s of its end, or it has just left
   the air. The fly doesn't audition in the on-air track's last 90 s unless that deck is empty or stopped.
   - A deck whose track was on air for 10 s or more is marked played when it leaves the air (a quick fader nudge
     doesn't count), and gets a new track before it can be cued again, whatever is left of the old one. No transition
     is lined up while the off-air deck still holds it. It's auditioned if the on-air track has more than 30 s left,
     otherwise loaded straight from the crate.
   - If nothing new has loaded 10 s after asking (a tiny crate), and no load is still decoding, the guard lifts.
2. Up to 3 candidates (in style, not on a deck, least-played first) play from their drop in the cue, 5 s each. A
   candidate that had to be decoded again gets its 5 s from when it actually plays; one that can't be decoded is
   skipped.
3. Each is scored by the descending-neuron spikes/s of that deck's listener fly (with one fly, that side of its brain),
   counted from 1.2 s in.
4. The score is divided by (1 + 0.35 × plays), with a ×1.15 bonus for Camelot neighbours, ×1.1 for tempos within 6%,
   and the set plan's intensity fit.
5. The winner loads.

Honest caveat: the ears normalize loudness, so scores for similar tracks are close. For demo tracks it's close to a
coin toss.

**Adapting to the style of what's playing.**

| Style | Cooldowns | Builds | Moves swapped |
|---|---|---|---|
| club, desi | ×1 | yes | — |
| hip-hop | ×1 | rare (×0.25) | rolls and trans → scratches |
| drum & bass | ×0.8 | yes | scratches → rolls |
| chill | ×2 | rare (×0.2) | rolls/trans/scratch → echo, reverb |

In breakdowns (bar energy < 0.4, or a breakdown sensed), rolls, scratches and gates become echo, reverb wash and
flanger. For the first 8 bars after a drop, only echoes are allowed.

**Tempo.** Arousal pushes the master tempo by up to ±6% ("rides the tempo"). With *tempo follows each new track*, the
tempo goes to the new track's tempo in the set's frame (`Mixer.tempoOf`; a half-time track counts double), moved into
the style's home range when that's close enough (`styleTempo`). After a blend it drifts there over about 20 s; after a
cut it jumps on the landing beat, by the audio clock.
- **Holds.** The tempo stays put while a transition is lined up (`holdTempoUntil`) and while any move has cuts,
  booms or restores scheduled on the audio clock (`Performer._hold`), since a rate change would move the bar lines
  away from them. A drop swap's hold ends at its drop. The tempo fader and the glide wait too, so they go on from
  there afterwards instead of jumping.
- Changing the tempo yourself ends any hold (the scheduled moves may then land off the beat).

## 10. Where the fly is in a track

**Analysed tracks.**
- **The library.** Tracks are analysed offline by the All-In-One structure analyzer (Kim & Nam 2023, trained on the
  human-annotated Harmonix Set; the NATTEN-free fork all-in-one-infer, in its own `.venv-allin1`).
  `tools/label_queue.py` works through a queue one track at a time, with Demucs on the GPU through MLX
  (`tools/mlx_stems.py`, demucs-mlx with the official HTDemucs weights). That takes about 28 s a track, against about
  75 s before. Files over 20 minutes are skipped.
- **Lookup.** At startup the server hashes the library's files into an index (written atomically). The app asks for
  each track by the audio file's SHA-1.
- **Dropped files** the server doesn't know are uploaded (the hash is checked) and analysed in the background by
  `tools/label_one.py`, one at a time at `nice 12`, with a 15-minute limit. After each run the uploaded audio and
  All-In-One's stem and spectrogram leftovers are deleted; at start, upload leftovers over 6 h old are swept.
- **Polling.** The page asks again every 30 s (every 3 s while the server is still indexing), uploads one file at a
  time, and gives up after 20 failed requests in a row. It uploads a track again only if the server lost it in a
  restart. A 410 is final: the in-browser grid stays. The analysis is applied when no deck is playing that track.
- **The grid** (`applyAnalysis` and `barGrid` in `tracks.js`):
  - An analysis with fewer than 8 downbeats, or whose length differs from the file by more than 3 s, is rejected.
  - **Numbering.** Each downbeat is numbered from the last one that sat on the grid, not from its neighbour, so a
    half-bar extra or a missed downbeat can't shift every later index. An off-grid downbeat followed by a whole bar
    starts a new run (the bar line really moved). The first line is fitted on the longest run, then refitted twice
    without the downbeats over 1/4 bar off it.
  - **Half bars.** A single downbeat at a half bar (the tracker adds those) costs nothing. Four or more in a row with
    none on the line count as off the grid: that's the bar line itself moving (a bar of 2 beats).
  - **A grid** needs at least 8 bars on the line, at most 10% of the downbeats off it, and an rms error of at most
    1/8 bar.
  - **Which part.** The whole track, its last half, its last 30%, and the stretch after its last bar-line move are
    fitted. The fit moves to a later part when the earlier line misses that part by more than 1/32 bar (60 ms at
    most) and by over 3× that part's own error: the tempo changes, so the end is fitted, where the mix-out happens.
  - A track with no grid at all keeps the browser's grid and is marked not steady (the app's one-tempo grid won't fit
    it either).
  - **Meter.** The bar over All-In-One's beat must be a whole number of beats (within 0.2). 4 is the app's bar. 3
    (waltzes, 6/8 ballads) gets the beat tempo. 2 is a double-time downbeat grid: the bar is two downbeats long, on the
    line that carries more of them. 8 is a downbeat every other bar. 5, 6 and 7 (5/4, 6/8 in eighths, 7/8) get the
    beat tempo (6 and 8 are halved when they'd put it at 220 BPM or more). A bar that isn't a whole number of beats
    gets the beat tempo.
  - A track is *steady* if the whole track fits, the bar is 4 beats (or a 2 / 8 grid rescaled to 4), the grid drifts
    by at most 1/16 bar (a quarter beat), and at most 5% of the downbeats are off the grid.
  - Over the library's 499 analyses (commit 1fb7f0e): 494 grids applied, 390 of them steady, and 0.919 of the exit
    downbeats on the app's bar lines.
- **Sections:** each bar takes the label at its midpoint: intro, verse, chorus (also inst and solo), break (also
  bridge), outro (also end).
- **Hot cues:** the intro, 8 bars before the first chorus, the first chorus, and the first break after it.
- **The exit plan** (`mixBar`, `exit`), so the mix finishes before the track does:
  - an outro of 10+ bars after the last verse or chorus: blend across it from its first bar
  - a short outro (pop songs): echo out as the last verse or chorus ends
  - no outro: blend from the 4-bar line about 12 bars before the end

**Section sense v3** (`web/js/sections.js`, `flybrain/sections.py`, model in `brains/sections_trained.json`). For
tracks without an analysis, each listener fly says where its deck is:
1. Every bar of the deck's grid, the listener's output spikes are pooled by cell type (518 types) into rates, then
   log-scaled.
2. Each is normalised against the track so far (causal, after a 4-bar warm-up), plus the mean of the previous 4 bars.
   The app's own per-bar energy is added the same way.
3. A multinomial logistic classifier gives intro / verse / chorus / break / outro.
4. An online HMM keeps the sections in order: transition and start probabilities and a song-position prior learned
   from labelled tracks.
5. The result is a section with a confidence, updated every bar. A deck that jumps back 2 bars or more (cued to its
   intro, a hot cue) starts its sense over.

It was trained on 107 of 131 recorded real tracks against All-In-One labels; the other 24 are the benchmark's held-out
set. How much the fly's neurons add is in TRAINING.md: not much over the fly's own ear input.

**Older senses.** The listener flies' readout (`brains/readout.json`: a few descending neurons of the trained brain per
sense, z-scored) still runs. With three flies it's a relative detector: MIX is on in its top 20% of the last ~3 minutes,
SPACE in its top 10%, PEAK off in its bottom 25%. It drives the visualiser's sense meters, and the DJ uses it only when
no section model is loaded.

**Which one counts:** the analysed structure when the track has one, then section sense v3, then the readout.

## 11. Music

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
- An early version had a chimta. It was taken out, and the tumbi hook now plays 4 bars and rests 4.

**Analysis of new tracks** (`tracks.js`, `analysis.js`), in the browser:
- **BPM:** onset comb filter on a 160 Hz low-passed copy, searched from 85–175 BPM. If full-band hits land on the
  off-beats about as hard as on the beats, the tempo is doubled (drum & bass). ½×/2× buttons correct it by hand. An
  analysed grid (§10) replaces this, and the buttons are greyed on analysed tracks.
- **Key:** chroma from 48 FFT frames (80 Hz – 2 kHz), matched against Krumhansl-Kessler profiles, then converted to a
  Camelot code.
- **Style:**
  - desi if the file name matches words like bhangra, dhol, punjabi, bollywood, tabla…
  - ≥ 155 BPM → drum & bass
  - few onsets or low energy → chill
  - < 108 BPM → hip-hop
  - otherwise club
- **Energy:** RMS per bar, normalized. **Hot cues** without an analysis: the biggest 4-bar energy jump is the drop,
  and the quietest stretch after it is the break. (Demo tracks use their fixed arrangement, `DEMO_CUES`.)

## 12. Performance lessons

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
- **Three flies on the CPU** first ran at a load of 1.81 (stepped in turn), slower than the music. One process per
  fly brought live runs to 1.04–1.16. On the GPU the first live test ran at 0.83, and the server's own share is now
  about 0.31–0.33 (§3). With the browser, the saved headless benchmark runs report 0.61–0.83 before benchmark v3 (a
  snapshot of the last moment of each run; one run read 0.41) and run means of 0.75–0.79 since.
- Headless Chrome has no GPU, and its software canvas starved the brains, so the test tools switch drawing off.
- Safari kept running cached copies of old pages, because the server sent no cache headers. Pages are now generated
  with versioned script URLs (§2).

## 13. Testing

Automated. The browser tests run the app in headless Chrome through `playwright-core` (`tools/`).

**Don't test against a server someone is using.** Their pages reconnect on their own, so a test page's drive would
mix with theirs. Start a second server (`.venv/bin/python -m flybrain.server --port 8766`) and point the tools at it
with `PORT=8766`.

| Tool | What it checks |
|---|---|
| `tools/djbench.mjs` | Benchmark v3: the whole app on real tracks, repeated seeded runs (`RUNS`, `MIN`). `SET=heldout`, `fresh`, or `random:<n>:<seed>`: n analysed tracks drawn by the seed from those never in `held_out.json`, `test_fresh.json`, the first 80 of `label_queue.txt` or the section model's recordings. It logs raw facts in track time: every move and transition with the on-air track and its position in seconds (as scheduled and as it played) and who drove it; transitions from lined up to fully in; master silences every 100 ms; the on-air track over time; the brain's load every second. The crate is put in name order, then shuffled by the seed (Fisher-Yates), so two app versions get the same crate. Runs go to `data/bench/`, scored by djscore. |
| `tools/djscore.mjs` | Grades bench files offline against the raw All-In-One beats, downbeats and sections, not either version's grid: section at the landing or move, on a bar / 4-bar / 8-bar line, fit, variety, silences judged against what each move means to be silent, time on air, load (a run mean), the listeners' sense. Split by driver (planned exit, sense, 4-minute cap, track ending; bursts, sense, set plan). Mean ± Student-t 95% CI over runs, pooled Wilson intervals, and a paired A/B (`A.json B.json`). A file from before v3 scores what it can; `FILE@1167539` or `FILE@6901364` places its transitions through that version's grid fit. `--selftest` checks the scorer. |
| `tools/test_dj_logic.mjs` | The DJ's decisions in plain Node, with no browser, server or brain: the app's own Mixer, Deck, Performer and FlyDJ on a stand-in for Web Audio that records every AudioParam call. 27 checks: replayed tracks, folds, double drops, moves before the exit, tempo holds, the fader on the audio clock… |
| `tools/test_decks.mjs` | The app's Deck in an OfflineAudioContext with a ramp track, so the rendered output shows which position played when: single, stacked and earlier jumps, stop while a jump is pending, stems respawn, the next bar after a jump back, duck merging |
| `tools/livetest.mjs` | A live run: how often each listener sense is on in its section against chance, listener z by section, load |
| `tools/onairtest.mjs` | How long each track stays fully on air |
| `tools/vizfx.mjs` | Fires pad moves and screenshots each visualiser effect, then hovers and pokes a neuron |
| `tools/gpucheck.py` | GPU spike statistics (the sugar experiment over 3 seeds, a music-like drive), printed beside fixed CPU reference figures from before the refractory fix, and speed for 1 / 3 / 18 flies |
| `tools/cnscheck.py` | The same stimuli (silence, the whole sugar channel, music-like ear drive) on either connectome |
| `tools/compare_sense.py` | Offline, nested: what a section model can be built from (TRAINING.md) |

Earlier checks, from the first versions:
- **End-to-end runs of 30 s – 4 min:** beat-matched transitions, deck-phase checks, audio levels, no page errors.
- **Every pad and key pressed:** tempo nudges and tap; both decks' beat positions stayed an exact multiple of 4 apart.
- **BPM detection:** synthetic tracks at 131, 90 (hip-hop, E minor) and 172 (drum & bass, F major) BPM were all
  detected correctly, including both keys.
- **Brain model:** the paper's sugar experiment reproduced; the serial and parallel kernels give identical spikes.

**Limits of the measurements** (AUDIT.md, Audit 4):
- On analysed tracks the planner exits by the same All-In-One sections djscore grades against, so the section scores
  mostly measure whether the planner follows the analysis, not the fly's ear or taste. That's why djscore splits them
  by driver. Dropouts, time on air, pace, harmonic mixing and load don't depend on the labels.
- Intervals reported before commit d0095fc used 1.96 instead of Student t: 2.2× too narrow at 3 runs, 6.5× at 2.
- The same seed gives the same crate, but only the first two tracks are paired: after them the fly's picks depend on
  real-time audio.
- The held-out set has been the development set for 10+ runs, and the fresh set isn't fully untouched (Audit 4,
  finding 5). `SET=random:<n>:<seed>` draws tracks never used.
- **Not verified:** how any of it sounds. Automated tests measure levels and timing, not listening quality.

## 14. Ideas and next steps

- **Teach the DJ skills themselves:** a reward-modulated (three-factor) rule whose reward is DJ craft, so training
  shapes the move groups' timing, not just section recognition (AUDIT.md, plan items 11–12).
- **Retrain the section model on the analysed grid.** It was trained on the browser beat tracker's bars but runs on
  the All-In-One grid (AUDIT.md, Audit 4).
- **Breakdown sense from PEAK-low:** live, the listeners' PEAK neurons drop 1–2 SD in breakdowns, a cue that isn't used
  yet.
- **Train on the GPU.** `train.py` still records on the CPU; `gpu.py` can run 18 flies at once.
- Vocal stems for playback (Demucs runs only for the song analysis), true acapella mashups and key-shifted acapellas;
  a third and fourth deck (Carl Cox, SHM); swing (Kaytranada).
- A section model for the male CNS.
- More senses: vision (photoreceptors reaching the central brain needs longer runs), and smell once there's a stable
  way to drive the antennal lobe.

## 15. References

- Shiu P.K. et al. (2024) *A Drosophila computational brain model reveals sensorimotor processing.* Nature.
  [github.com/philshiu/Drosophila_brain_model](https://github.com/philshiu/Drosophila_brain_model)
- Dorkenwald S. et al. (2024) *Neuronal wiring diagram of an adult brain.* Nature (FlyWire).
- Schlegel P. et al. (2024) *Whole-brain annotation and multi-connectome cell typing of Drosophila.* Nature.
  [github.com/flyconnectome/flywire_annotations](https://github.com/flyconnectome/flywire_annotations)
- Kim T. & Nam J. (2023): the All-In-One music structure analyzer (beats, downbeats and sections; trained on the
  human-annotated Harmonix Set). Run here through the all-in-one-infer fork.
- Kim T. et al. (2020), ISMIR: an analysis of 1,557 real DJ mixes (transitions on 32-beat phrases, cue points that
  follow song structure, about 4 minutes per track).
- Krumhansl C.L. (1990) *Cognitive Foundations of Musical Pitch* (key profiles).
- DJ technique research: [Carl Cox's techniques](https://wearecrossfader.co.uk/blog/carl-cox-mixing-techniques/),
  [Richie Hawtin: Technology Fuels Techno (Ableton)](https://www.ableton.com/en/pages/artists/richie_hawtin/),
  [QBert on turntablism (RBMA)](https://daily.redbullmusicacademy.com/2019/01/qbert-interview/),
  [Turntablism (Wikipedia)](https://en.wikipedia.org/wiki/Turntablism),
  [How to DJ Bhangra & Indian music (DJ Gym)](https://www.djgym.co.uk/post/how-to-dj-bhangra-indian-music)
