// "Play like" DJ styles, from research into how these DJs actually play live (sources: docs/DJ_RESEARCH.md).
//
// The fly's neurons still decide WHEN something happens and HOW EXCITED it is. A style decides WHAT that looks like:
//   moves        per neuron group, a list of moves from mild to wild (the burst's intensity picks one)
//   transitions  weights for: blend, echo (echo out), drop (drop swap), spin (spinback cut), cut (hard cut),
//                double (double drop), kill (Fisher's 1-bar kill)
//   build        kind: roll (cue roll) · snare (big-room snare roll) · stutter (bass) · filter (house/techno);
//                bars; horn at the drop; often = how keen on builds
//   blendBars    length of a full crossfade      onAir [min, max] seconds a track stays on before moving on
//   cool         how busy (multiplies cooldowns)  hype   samples fired when the fly gets excited
//   bpm          home tempo range (the master tempo drifts into it when you pick the style)
//   mc           what the fly shouts on the mic in this style ([] = this DJ doesn't talk on the mic)
//
// Neuron groups: escape (giant fiber) · echo (DNp02/06/11/55) · scratch (DNg24/29) · trans (DNb06/ge113/ge145)
//                flange (DNg99/p73/ge130) · wind (DNp18/pe017/be001)
//
// Move names: roll4 roll8 roll16 brake backspin echo reverb dub flanger trans crush lpf resfilter sweep pump
//             baby chirp flare transformer orbit crab chop stutter reverse tease layer mashup singalong fill acid
//             drumsout (drum stem drops out, slams back) melodyout (strip to drums)
//             horn siren laser boom riser dhol co2

export const STYLES = {
  fly: {
    name: 'The fly itself', tagline: 'No human style: each neuron group drives its own default move.',
    moves: null, transitions: {}, build: { kind: 'roll', bars: 4, horn: true }, blendBars: 8, hype: ['horn'],
  },

  // ---------------- mainstage / big room / bass ----------------
  guetta: {
    mc: ['Are you ready?', 'Put your hands up!', "Let's go!"], name: 'David Guetta', bpm: [126, 130],
    tagline: 'Future rave: acapellas over his own edits, a live TB-303, soft-then-hard "yo-yo" drops, snare-roll builds, mic-hype energy.',
    moves: { escape: ['roll8', 'stutter'], echo: ['echo', 'reverb'], scratch: ['mashup', 'chop'], trans: ['acid', 'pump'],
             flange: ['sweep', 'singalong'], wind: ['reverb', 'horn'] },
    transitions: { blend: 0.5, echo: 1, drop: 1.5, double: 1, cut: 0.8, spin: 0.2 },
    build: { kind: 'snare', bars: 4, horn: true, often: 1.5 }, blendBars: 8, hype: ['horn', 'co2'], onAir: [45, 150],
  },
  garrix: {
    mc: ['Jump!', 'Make some noise!', "Let's go!"], name: 'Martin Garrix', bpm: [126, 130],
    tagline: 'Big room: 8-bar snare-roll builds with pitch risers, a reverb-drenched breakdown, then a dry punchy drop.',
    moves: { escape: ['roll8', 'roll16', 'stutter'], echo: ['reverb', 'echo'], scratch: ['stutter'], trans: ['pump', 'crush'],
             flange: ['sweep'], wind: ['reverb', 'co2'] },
    transitions: { drop: 2, double: 1, cut: 0.8, blend: 0.3, echo: 0.6 },
    build: { kind: 'snare', bars: 8, horn: true, often: 2 }, blendBars: 8, hype: ['horn', 'co2'], onAir: [45, 150],
  },
  tiesto: {
    mc: ['Make some noise!', 'Hands up!'], name: 'Tiësto', bpm: [126, 130],
    tagline: 'Modern Tiësto: every track gets 1.5–2 minutes, genre hops across house, drum & bass and trance, big builds.',
    moves: { escape: ['roll8', 'stutter'], echo: ['echo', 'reverb'], scratch: ['mashup'], trans: ['pump'], flange: ['sweep'], wind: ['reverb'] },
    transitions: { cut: 1.2, drop: 1.2, echo: 1, blend: 0.5 },
    build: { kind: 'snare', bars: 4, horn: true }, blendBars: 8, hype: ['horn'], onAir: [60, 120],
  },
  calvin: {
    mc: ['Sing it!', 'Everybody!'], name: 'Calvin Harris', bpm: [124, 128],
    tagline: '"A selector, not a DJ": tight phrase-perfect swaps between hits, drums out so the crowd sings the hook.',
    moves: { escape: ['drumsout', 'singalong'], echo: ['echo'], scratch: ['mashup'], trans: ['pump'], flange: ['singalong'], wind: ['reverb'] },
    transitions: { cut: 1.5, blend: 0.8, drop: 0.6 },
    build: { kind: 'snare', bars: 4, horn: false }, blendBars: 4, hype: ['horn'], onAir: [60, 150],
  },
  shm: {
    mc: ['Sing it with us!', 'Hands up!'], name: 'Swedish House Mafia', bpm: [126, 128],
    tagline: 'Four decks: acapellas and FX on the outer two, hi-hat loops layered like building blocks, mids-only reverb, crowd-sung finales.',
    moves: { escape: ['fill', 'roll8'], echo: ['reverb'], scratch: ['mashup', 'layer'], trans: ['layer'], flange: ['drumsout', 'singalong'], wind: ['reverb', 'co2'] },
    transitions: { blend: 1, drop: 1.2, double: 0.8 },
    build: { kind: 'snare', bars: 8, horn: false }, blendBars: 8, hype: ['co2'],
  },
  djsnake: {
    mc: ['Make some noise!', 'Turn it up!'], name: 'DJ Snake', bpm: [100, 140],
    tagline: 'A genre arc from hip-hop to trap, about 2.5 minutes a track, home-made mashups and hard drops.',
    moves: { escape: ['stutter', 'roll16'], echo: ['echo', 'siren'], scratch: ['mashup', 'chop'], trans: ['tease', 'crush'], flange: ['sweep'], wind: ['horn'] },
    transitions: { cut: 2, drop: 1, spin: 0.8, blend: 0.2 },
    build: { kind: 'stutter', bars: 2, horn: true, often: 1.3 }, blendBars: 4, hype: ['horn', 'siren'], onAir: [45, 150],
  },
  skrillex: {
    mc: ["Let's go!"], name: 'Skrillex', bpm: [130, 175],
    tagline: 'Fast and frantic: intro-to-drop hard cuts, stutter edits, reverses, genre whiplash from garage to drum & bass.',
    moves: { escape: ['stutter', 'roll16', 'reverse'], echo: ['reverse', 'echo'], scratch: ['chop', 'stutter'], trans: ['crush', 'stutter'],
             flange: ['sweep', 'tease'], wind: ['laser'] },
    transitions: { cut: 2.5, drop: 1, double: 0.8, blend: 0.1, echo: 0.3 },
    build: { kind: 'stutter', bars: 2, horn: false, often: 1.5 }, blendBars: 2, hype: ['laser', 'boom'], cool: 0.8, onAir: [30, 90],
  },
  diplo: {
    mc: ['Get low!', 'Make some noise!'], name: 'Diplo', bpm: [100, 130],
    tagline: 'Mood-driven genre blending (dancehall, moombahton, baile funk, bass house), bootleg mashups, confetti on every drop.',
    moves: { escape: ['roll8', 'stutter'], echo: ['echo'], scratch: ['mashup', 'chop'], trans: ['tease', 'pump'], flange: ['sweep'], wind: ['horn', 'co2'] },
    transitions: { cut: 1.5, drop: 1, blend: 0.5 },
    build: { kind: 'snare', bars: 4, horn: true }, blendBars: 4, hype: ['horn', 'co2', 'siren'], onAir: [45, 150],
  },
  aoki: {
    mc: ['Cake time!', 'Make some noise!'], name: 'Steve Aoki', bpm: [126, 150],
    tagline: 'Fast electro / big-room / trap cuts, mashups, and a "cake moment" impact on every drop.',
    moves: { escape: ['stutter', 'roll16'], echo: ['echo'], scratch: ['mashup'], trans: ['crush'], flange: ['sweep'], wind: ['co2', 'horn'] },
    transitions: { cut: 1.5, drop: 1.5, double: 1, blend: 0.2 },
    build: { kind: 'snare', bars: 4, horn: true, often: 2 }, blendBars: 4, hype: ['co2', 'horn', 'boom'], cool: 0.8,
  },
  armin: {
    mc: [], name: 'Armin van Buuren', bpm: [132, 140],
    tagline: 'A trance journey: 32–64-bar blends with bass swaps, long breakdowns, then the kick blows back in.',
    moves: { escape: ['sweep'], echo: ['reverb', 'echo'], scratch: ['layer'], trans: ['layer'], flange: ['sweep', 'lpf'], wind: ['reverb'] },
    transitions: { blend: 3, echo: 0.3 },
    build: { kind: 'filter', bars: 8, horn: false }, blendBars: 32, hype: [], cool: 1.8,
  },
  alok: {
    mc: ['Brazil!', "Let's go!"], name: 'Alok', bpm: [120, 126],
    tagline: 'Brazilian bass: deep filtered basslines with tight sidechain pumping, classics taken somewhere new.',
    moves: { escape: ['pump', 'roll8'], echo: ['echo'], scratch: ['mashup'], trans: ['pump'], flange: ['lpf'], wind: ['reverb'] },
    transitions: { blend: 1, cut: 0.8, drop: 1 },
    build: { kind: 'snare', bars: 4, horn: false }, blendBars: 8, hype: ['horn'],
  },
  nucleya: {
    mc: ['Balle balle!', 'Oye hoye!', 'Make some noise!'], name: 'Nucleya', bpm: [100, 140],
    tagline: 'Desi bass: dhol and tumbi over trap and dubstep; the dhol drops out and comes back twice as hard.',
    moves: { escape: ['drumsout', 'stutter'], echo: ['echo', 'siren'], scratch: ['chop'], trans: ['tease', 'dhol'], flange: ['sweep'], wind: ['horn', 'siren'] },
    transitions: { cut: 1.5, drop: 1.2, blend: 0.4 },
    build: { kind: 'stutter', bars: 4, horn: true, often: 1.3 }, blendBars: 4, hype: ['horn', 'siren', 'dhol'],
  },

  // ---------------- live / house / techno ----------------
  fredagain: {
    mc: [], name: 'Fred again..', bpm: [120, 140],
    tagline: 'Live chops: slices of the playing track retriggered and pitched on pads, drops to near-silence for the crowd to sing, fast swaps.',
    moves: { escape: ['chop', 'stutter'], echo: ['reverb', 'dub'], scratch: ['chop'], trans: ['chop', 'trans'], flange: ['drumsout', 'singalong'], wind: ['reverb', 'singalong'] },
    transitions: { cut: 1.2, blend: 0.6, echo: 0.8, drop: 0.6, double: 0.3 },
    build: { kind: 'filter', bars: 4, horn: false, often: 0.7 }, blendBars: 4, hype: [], onAir: [40, 120],
  },
  carlcox: {
    mc: [], name: 'Carl Cox', bpm: [126, 134],
    tagline: 'Three decks, quick precise cuts on the phrase, cue-button builds, loops layered from another deck, spinbacks.',
    moves: { escape: ['roll4', 'roll8', 'backspin'], echo: ['echo', 'dub'], scratch: ['baby', 'chirp'], trans: ['layer', 'melodyout'], flange: ['flanger', 'lpf'], wind: ['reverb'] },
    transitions: { blend: 1.2, cut: 0.8, drop: 0.6, echo: 0.6 },
    build: { kind: 'roll', bars: 4, horn: false }, blendBars: 8, hype: [],
  },
  hawtin: {
    mc: [], name: 'Richie Hawtin', bpm: [125, 132],
    tagline: 'Loops as the instrument: layers from other decks kept rolling for phrases, Model 1 filter sweeps, a foot-pedal delay throw.',
    moves: { escape: ['layer', 'roll8'], echo: ['dub', 'echo'], scratch: ['melodyout', 'layer'], trans: ['trans', 'layer'], flange: ['resfilter', 'flanger'], wind: ['reverb', 'dub'] },
    transitions: { blend: 2, echo: 0.6, cut: 0.2, drop: 0.2, spin: 0 },
    build: { kind: 'filter', bars: 8, horn: false, often: 0.5 }, blendBars: 16, hype: [], cool: 0.9,
  },
  charlotte: {
    mc: [], name: 'Charlotte de Witte', bpm: [134, 140],
    tagline: 'Dark acid techno around 135+: filter-swept acid lines, trans-gated pads, smooth in-key transitions.',
    moves: { escape: ['roll8', 'trans'], echo: ['reverb', 'dub'], scratch: ['layer'], trans: ['trans', 'crush'], flange: ['resfilter', 'acid'], wind: ['reverb'] },
    transitions: { blend: 1.5, cut: 0.5, echo: 0.5 },
    build: { kind: 'filter', bars: 4, horn: false }, blendBars: 12, hype: [],
  },
  amelie: {
    mc: [], name: 'Amelie Lens', bpm: [138, 148],
    tagline: 'Fast, relentless techno (136–148) with sampler layers stacked over the peak.',
    moves: { escape: ['roll8', 'roll16'], echo: ['reverb', 'echo'], scratch: ['layer', 'chop'], trans: ['trans', 'pump'], flange: ['resfilter', 'sweep'], wind: ['reverb'] },
    transitions: { blend: 1, cut: 0.8, drop: 0.6 },
    build: { kind: 'roll', bars: 4, horn: false }, blendBars: 8, hype: [],
  },
  peggygou: {
    mc: [], name: 'Peggy Gou', bpm: [110, 130],
    tagline: 'Selector first: disco to techno, big genre and tempo jumps, reverb and delay for depth.',
    moves: { escape: ['lpf', 'echo'], echo: ['echo', 'reverb'], scratch: ['layer'], trans: ['lpf'], flange: ['flanger'], wind: ['reverb'] },
    transitions: { blend: 1.2, cut: 1, echo: 0.8 },
    build: { kind: 'filter', bars: 4, horn: false, often: 0.6 }, blendBars: 8, hype: [],
  },
  blackcoffee: {
    mc: [], name: 'Black Coffee', bpm: [118, 124],
    tagline: 'Afro house patience: long EQ blends where the percussion interlocks, heavy filters, restrained drops.',
    moves: { escape: ['lpf'], echo: ['echo', 'reverb'], scratch: ['layer'], trans: ['melodyout', 'lpf'], flange: ['sweep'], wind: ['reverb'] },
    transitions: { blend: 3, echo: 0.3, cut: 0, drop: 0, spin: 0 },
    build: { kind: 'filter', bars: 8, horn: false, often: 0.3 }, blendBars: 32, hype: [], cool: 2.2,
  },
  solomun: {
    mc: [], name: 'Solomun', bpm: [120, 126],
    tagline: 'Long narrative sets; reverb and delay on the outgoing track in every transition.',
    moves: { escape: ['reverb'], echo: ['echo', 'reverb'], scratch: ['layer'], trans: ['layer'], flange: ['flanger', 'lpf'], wind: ['reverb'] },
    transitions: { blend: 2, echo: 1 },
    build: { kind: 'filter', bars: 8, horn: false, often: 0.6 }, blendBars: 16, hype: [], cool: 1.5,
  },
  fourtet: {
    mc: [], name: 'Four Tet', bpm: [120, 135],
    tagline: 'Eclectic crate: garage, techno, ambient and his own edits, with fast, frantic swaps.',
    moves: { escape: ['chop', 'roll8'], echo: ['echo', 'dub'], scratch: ['chop'], trans: ['layer', 'chop'], flange: ['lpf', 'flanger'], wind: ['reverb'] },
    transitions: { cut: 1.2, blend: 1, echo: 0.6 },
    build: { kind: 'filter', bars: 4, horn: false }, blendBars: 8, hype: [], onAir: [45, 150],
  },
  jamiexx: {
    mc: [], name: 'Jamie xx', bpm: [124, 134],
    tagline: 'Crate-digger: loops and flips found records, UK garage nods, tape-echo throws.',
    moves: { escape: ['chop', 'roll8'], echo: ['dub', 'echo'], scratch: ['chop', 'baby'], trans: ['layer'], flange: ['lpf'], wind: ['reverb'] },
    transitions: { cut: 1, blend: 1, echo: 1 },
    build: { kind: 'filter', bars: 4, horn: false }, blendBars: 8, hype: [],
  },
  prydz: {
    mc: [], name: 'Eric Prydz', bpm: [124, 128],
    tagline: 'Epic long blends where one lead rides across tracks, the Pryda snare fill, huge 8-bar builds.',
    moves: { escape: ['fill', 'roll4'], echo: ['reverb', 'echo'], scratch: ['layer'], trans: ['layer'], flange: ['sweep', 'flanger'], wind: ['reverb'] },
    transitions: { blend: 3, echo: 0.3 },
    build: { kind: 'snare', bars: 8, horn: false, often: 0.8 }, blendBars: 32, hype: [], cool: 1.6,
  },
  fisher: {
    mc: ["Let's go!", 'Party time!'], name: 'Fisher', bpm: [124, 128],
    tagline: 'Tech-house party: the volume drops out a bar before the new phrase, then the next track hits its intro hard.',
    moves: { escape: ['tease', 'roll4'], echo: ['echo'], scratch: ['chop'], trans: ['drumsout', 'pump'], flange: ['lpf', 'sweep'], wind: ['reverb'] },
    transitions: { kill: 2.5, blend: 0.6, cut: 0.8 },
    build: { kind: 'filter', bars: 4, horn: false }, blendBars: 8, hype: ['horn'],
  },
  johnsummit: {
    mc: ["Let's go!"], name: 'John Summit', bpm: [124, 128],
    tagline: 'Vocal-led tech house: EQ and filter mixing, vocal hooks mashed over grooves.',
    moves: { escape: ['roll4', 'tease'], echo: ['echo', 'reverb'], scratch: ['mashup'], trans: ['pump'], flange: ['sweep'], wind: ['reverb'] },
    transitions: { blend: 1, cut: 0.8, kill: 0.6 },
    build: { kind: 'filter', bars: 4, horn: false }, blendBars: 8, hype: [],
  },
  kaytranada: {
    mc: [], name: 'Kaytranada', bpm: [100, 122],
    tagline: 'Beat-tape flow: a new groove about every 30 s, house into R&B into hip-hop, cut not blended, swung chops.',
    moves: { escape: ['chop', 'roll8'], echo: ['echo'], scratch: ['chop', 'baby'], trans: ['chop'], flange: ['lpf'], wind: ['reverb'] },
    transitions: { cut: 2, blend: 0.6 },
    build: { kind: 'filter', bars: 4, horn: false, often: 0.3 }, blendBars: 4, hype: [], onAir: [25, 60],
  },

  // ---------------- turntablists ----------------
  qbert: {
    mc: [], name: 'DJ Qbert', bpm: [88, 100],
    tagline: 'Turntablist: crab scratches (four-finger fader taps), orbits, flares and transformers everywhere.',
    moves: { escape: ['crab', 'transformer'], echo: ['orbit', 'flare'], scratch: ['crab', 'orbit', 'flare', 'transformer'], trans: ['chirp', 'baby'], flange: ['baby'], wind: ['echo'] },
    transitions: { cut: 1.5, spin: 1, blend: 0.3 },
    build: { kind: 'stutter', bars: 2, horn: false, often: 0.3 }, blendBars: 4, hype: ['laser'], cool: 0.7,
  },
  atrak: {
    mc: ['Scratch!'], name: 'A-Trak', bpm: [120, 130],
    tagline: 'DMC champion in party mode: scratches as flourishes inside fast electro and club swaps.',
    moves: { escape: ['roll8', 'stutter'], echo: ['echo'], scratch: ['chirp', 'transformer', 'flare'], trans: ['transformer'], flange: ['sweep'], wind: ['reverb'] },
    transitions: { cut: 1.5, drop: 1, blend: 0.4 },
    build: { kind: 'snare', bars: 4, horn: true }, blendBars: 4, hype: ['horn'],
  },
  jazzyjeff: {
    mc: ['Throw your hands up!'], name: 'DJ Jazzy Jeff', bpm: [90, 110],
    tagline: 'The transformer scratch, backspins and beat-juggling cuts.',
    moves: { escape: ['backspin', 'transformer'], echo: ['echo'], scratch: ['transformer', 'chirp', 'baby'], trans: ['transformer'], flange: ['lpf'], wind: ['reverb'] },
    transitions: { cut: 1.2, spin: 1.5, blend: 0.6 },
    build: { kind: 'roll', bars: 2, horn: false, often: 0.4 }, blendBars: 4, hype: [],
  },
};
for (const [k, v] of Object.entries(STYLES)) v.key = k;
