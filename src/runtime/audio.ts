// Audio edge: the game's sound, driven entirely off the pure sim. Every combat
// event the sim already emits as a `Burst` becomes a sound — the loud, rare
// hits (explosion, EMP, …) play pre-baked OGG samples for body; the dense cheap
// ones (muzzle, impact) are synthesised live so a firefight never thrashes the
// sample voices. Underneath, a three-scene synthwave soundtrack crossfades
// between menu / battle / arcade and seam-crossfades its own loop.
//
// Everything hangs off one AudioContext, suspended until the first user gesture
// (autoplay policy). The mixer UI drives per-bus levels + mute (also `M`); every
// choice persists to localStorage.
import {
  BURST_ARC,
  BURST_COUNTER,
  BURST_DETONATION,
  BURST_EMP,
  BURST_EXPLOSION,
  BURST_IMPACT,
  BURST_MUZZLE,
  BURST_SHIELD,
  type World,
} from "../world";

const MUTE_KEY = "ganymede.muted";
const SFX_DIR = "assets/audio/sfx";
const MUSIC_DIR = "assets/audio/music";
// Per-frame voice budgets: muzzle fire is dense, so cap it hard and let the
// louder, rarer events through — stops a big firefight melting into noise.
const MUZZLE_PER_FRAME = 2;
const OTHER_PER_FRAME = 6;

export type Scene = "menu" | "battle" | "arcade";
export type Bus = "master" | "music" | "sfx";

// User-facing 0..1 fader per bus. `master` doubles as the pre-limiter ceiling;
// music sits under SFX by default.
export interface Levels {
  master: number;
  music: number;
  sfx: number;
}
const DEFAULT_LEVELS: Levels = { master: 0.6, music: 0.42, sfx: 1 };
const LEVEL_KEY = (b: Bus) => `ganymede.vol.${b}`;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const loadLevels = (): Levels => {
  const read = (b: Bus): number => {
    const raw = localStorage.getItem(LEVEL_KEY(b));
    if (raw === null) return DEFAULT_LEVELS[b];
    const v = Number(raw);
    return Number.isFinite(v) ? clamp01(v) : DEFAULT_LEVELS[b];
  };
  return { master: read("master"), music: read("music"), sfx: read("sfx") };
};

export interface Audio {
  resume(): void;
  frame(world: World, now: number): void;
  setScene(scene: Scene): void;
  toggleMute(): void;
  setLevel(bus: Bus, v: number): void;
  getLevels(): Levels & { muted: boolean };
  skip(): void;
}

// Which burst kinds play a baked sample, and its relative mix level.
const SAMPLE: Record<number, { file: string; gain: number }> = {
  [BURST_EXPLOSION]: { file: "explosion", gain: 0.9 },
  [BURST_DETONATION]: { file: "detonation", gain: 1 },
  [BURST_EMP]: { file: "emp", gain: 0.75 },
  [BURST_SHIELD]: { file: "shield", gain: 0.6 },
  [BURST_ARC]: { file: "arc", gain: 0.6 },
  [BURST_COUNTER]: { file: "counter", gain: 0.6 },
};

const fetchDecode = async (
  ctx: AudioContext,
  url: string,
): Promise<AudioBuffer> => {
  const res = await fetch(url);
  return ctx.decodeAudioData(await res.arrayBuffer());
};

interface Kit {
  ctx: AudioContext;
  bus: GainNode;
}

// A one-shot filtered noise burst — the live-synth body for muzzle/impact and
// the fallback for a marquee hit whose sample hasn't finished loading.
const noiseHit = (
  k: Kit,
  dur: number,
  gain: number,
  cutoff: number,
  type: BiquadFilterType,
) => {
  const t = k.ctx.currentTime;
  const n = Math.floor(dur * k.ctx.sampleRate);
  const buf = k.ctx.createBuffer(1, n, k.ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = k.ctx.createBufferSource();
  const bq = k.ctx.createBiquadFilter();
  const g = k.ctx.createGain();
  src.buffer = buf;
  bq.type = type;
  bq.frequency.value = cutoff * (0.9 + Math.random() * 0.2);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bq).connect(g).connect(k.bus);
  src.start(t);
};

// Fire a baked sample one-shot with a little pitch jitter so repeats stay alive.
const playSample = (k: Kit, buf: AudioBuffer, gain: number) => {
  const src = k.ctx.createBufferSource();
  const g = k.ctx.createGain();
  src.buffer = buf;
  src.playbackRate.value = 0.94 + Math.random() * 0.12;
  g.gain.value = gain;
  src.connect(g).connect(k.bus);
  src.start(k.ctx.currentTime);
};

const SCENES: Scene[] = ["menu", "battle", "arcade"];
const SCENE_XFADE = 1.4; // seconds to crossfade between scenes
const LOOP_XFADE = 2.5; // seconds to crossfade one track into the next
const LOOKAHEAD = 0.4; // schedule the seam this far ahead of the playhead
// How many variations each scene ships (`<scene>-<n>.ogg`, n = 1..count). The
// runtime round-robins through them so a long stay in one scene keeps evolving.
const VARIATIONS: Record<Scene, number> = { menu: 4, battle: 4, arcade: 4 };

// Equal-power fade curves (cos/sin): summed across a crossfade they hold power
// constant, so two decorrelated tracks meet with no dip — unlike a linear ramp.
const CURVE_STEPS = 64;
const EQ_IN = new Float32Array(CURVE_STEPS);
const EQ_OUT = new Float32Array(CURVE_STEPS);
for (let i = 0; i < CURVE_STEPS; i++) {
  const t = (i / (CURVE_STEPS - 1)) * (Math.PI / 2);
  EQ_IN[i] = Math.sin(t);
  EQ_OUT[i] = Math.cos(t);
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
  dur: number;
  seamPassed: boolean; // has the next voice already been scheduled off this one
}

// Start a buffer at `at` with an equal-power fade-in; it stops at its own end.
const startVoice = (
  ctx: AudioContext,
  buf: AudioBuffer,
  dest: GainNode,
  at: number,
  xf: number,
): Voice => {
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  src.buffer = buf;
  src.connect(gain).connect(dest);
  gain.gain.setValueCurveAtTime(EQ_IN, at, xf);
  src.start(at);
  src.stop(at + buf.duration + 0.1);
  return { src, gain, startedAt: at, dur: buf.duration, seamPassed: false };
};

// Equal-power fade a voice out over `xf` from `at`, then stop it early.
const fadeOutVoice = (v: Voice, at: number, xf: number) => {
  v.gain.gain.cancelScheduledValues(at);
  v.gain.gain.setValueCurveAtTime(EQ_OUT, at, xf);
  v.src.stop(at + xf + 0.1);
};

// A scene's own gain (fed by the scene crossfade) with its variation buffers
// loading in the background.
const initSceneBus = (
  ctx: AudioContext,
  s: Scene,
  out: GainNode,
  bufs: Record<Scene, AudioBuffer[]>,
): GainNode => {
  const g = ctx.createGain();
  g.gain.value = 0;
  g.connect(out);
  for (let i = 1; i <= VARIATIONS[s]; i++)
    void fetchDecode(ctx, `${MUSIC_DIR}/${s}-${i}.ogg`)
      .then((b) => bufs[s].push(b))
      .catch(() => {}); // tolerate a missing variation
  return g;
};

// The soundtrack: one persistent gain per scene (scene crossfade) feeding the
// music bus. Each scene round-robins its variations, crossfading (equal-power)
// at every loop seam — or on demand via `skip`.
const createMusic = (ctx: AudioContext, out: GainNode) => {
  const gains = {} as Record<Scene, GainNode>;
  const bufs = { menu: [], battle: [], arcade: [] } as Record<
    Scene,
    AudioBuffer[]
  >;
  const idx = { menu: 0, battle: 0, arcade: 0 } as Record<Scene, number>;
  const voices = {} as Record<Scene, Voice | null>;
  let active: Scene | null = null;
  for (const s of SCENES) gains[s] = initSceneBus(ctx, s, out, bufs);

  // Crossfade the active scene's current variation into the next one at `at`.
  const advance = (s: Scene, at: number) => {
    const list = bufs[s];
    if (!list.length) return;
    const xf = Math.min(LOOP_XFADE, list[0].duration / 2);
    const prev = voices[s];
    if (prev) fadeOutVoice(prev, at, xf);
    voices[s] = startVoice(ctx, list[idx[s]++ % list.length], gains[s], at, xf);
  };

  const setScene = (s: Scene) => {
    if (active === s) return;
    active = s;
    const t = ctx.currentTime;
    for (const x of SCENES)
      gains[x].gain.setTargetAtTime(x === s ? 1 : 0, t, SCENE_XFADE / 3);
  };

  // Kick off the first voice, then schedule each seam crossfade a bit early.
  const pump = () => {
    const s = active;
    if (!s) return;
    const now = ctx.currentTime;
    let v = voices[s];
    if (v && now >= v.startedAt + v.dur) v = voices[s] = null; // ran out while away
    if (!v) return advance(s, now + 0.05);
    const seam = v.startedAt + v.dur - Math.min(LOOP_XFADE, v.dur / 2);
    if (!v.seamPassed && now + LOOKAHEAD >= seam) {
      v.seamPassed = true;
      advance(s, Math.max(seam, now + 0.02));
    }
  };

  // Jump to the next variation now (button / hotkey), crossfaded not cut.
  const skip = () => {
    const s = active;
    if (!s) return;
    const v = voices[s];
    if (v) v.seamPassed = true;
    advance(s, ctx.currentTime + 0.03);
  };

  return { setScene, pump, skip };
};

// Play the right voice for one burst kind: live synth for the dense cheap hits,
// a baked sample (or a synth stand-in until it loads) for the marquee ones.
const voice = (k: Kit, kind: number, samples: Map<number, AudioBuffer>) => {
  if (kind === BURST_MUZZLE) return noiseHit(k, 0.05, 0.05, 1600, "highpass");
  if (kind === BURST_IMPACT) return noiseHit(k, 0.04, 0.07, 900, "bandpass");
  const s = SAMPLE[kind];
  if (!s) return;
  const buf = samples.get(kind);
  if (buf) playSample(k, buf, s.gain);
  else noiseHit(k, 0.3, 0.3, 1000, "lowpass"); // sample still loading
};

// Whether this burst has spent its per-frame budget (mutates the tally).
const overBudget = (kind: number, b: { muzzle: number; other: number }) =>
  kind === BURST_MUZZLE
    ? b.muzzle++ >= MUZZLE_PER_FRAME
    : b.other++ >= OTHER_PER_FRAME;

// Diff the burst list against the last-sounded id and fire one voice per fresh
// burst, within the per-frame budgets. Returns the new high-water id.
const soundBursts = (
  k: Kit,
  world: World,
  samples: Map<number, AudioBuffer>,
  cursor: number,
) => {
  const budget = { muzzle: 0, other: 0 };
  let maxId = cursor;
  for (const b of world.bursts.items) {
    if (b.id <= cursor) continue;
    if (b.id > maxId) maxId = b.id;
    if (!overBudget(b.kind, budget)) voice(k, b.kind, samples);
  }
  return maxId;
};

// Highest live burst id — fast-forwards the cursor while muted so unmuting
// doesn't dump a backlog of stale bursts.
const maxBurstId = (world: World, cursor: number) => {
  let m = cursor;
  for (const b of world.bursts.items) if (b.id > m) m = b.id;
  return m;
};

interface Engine {
  kit: Kit;
  master: GainNode;
  musicBus: GainNode;
  music: ReturnType<typeof createMusic>;
  samples: Map<number, AudioBuffer>;
}

// Construct the whole graph on the first gesture (autoplay policy): sfxBus +
// musicBus → master → limiter → speakers, and kick off async asset loading.
const buildEngine = (levels: Levels, muted: boolean, scene: Scene): Engine => {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = muted ? 0 : levels.master;
  master.connect(ctx.createDynamicsCompressor()).connect(ctx.destination);
  const bus = ctx.createGain();
  bus.gain.value = levels.sfx;
  bus.connect(master);
  const musicBus = ctx.createGain();
  musicBus.gain.value = levels.music;
  musicBus.connect(master);
  const samples = new Map<number, AudioBuffer>();
  for (const kind in SAMPLE)
    void fetchDecode(ctx, `${SFX_DIR}/${SAMPLE[kind].file}.ogg`).then((b) =>
      samples.set(Number(kind), b),
    );
  const music = createMusic(ctx, musicBus);
  music.setScene(scene);
  return { kit: { ctx, bus }, master, musicBus, music, samples };
};

// The imperative audio port. Holds mute + level + playback state; the graph is
// built lazily by `buildEngine` the first time `resume` runs under a gesture.
export const createAudio = (): Audio => {
  let muted = localStorage.getItem(MUTE_KEY) === "1";
  const levels = loadLevels();
  let eng: Engine | null = null;
  let cursor = 0;
  let prevAge = 0;
  let scene: Scene = "menu";

  // The gain node backing each bus, and the value it should sit at right now.
  const nodeFor = (b: Bus) =>
    !eng
      ? null
      : b === "master"
        ? eng.master
        : b === "music"
          ? eng.musicBus
          : eng.kit.bus;
  const targetFor = (b: Bus) => (b === "master" && muted ? 0 : levels[b]);
  const apply = (b: Bus) => {
    const node = nodeFor(b);
    if (node && eng)
      node.gain.setTargetAtTime(targetFor(b), eng.kit.ctx.currentTime, 0.04);
  };

  const setLevel = (b: Bus, v: number) => {
    levels[b] = clamp01(v);
    localStorage.setItem(LEVEL_KEY(b), String(levels[b]));
    apply(b);
  };
  const getLevels = () => ({ ...levels, muted });
  const toggleMute = () => {
    muted = !muted;
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    apply("master");
  };
  const resume = () => {
    eng ??= buildEngine(levels, muted, scene);
    void eng.kit.ctx.resume();
  };
  const setScene = (s: Scene) => {
    scene = s;
    eng?.music.setScene(s);
  };
  const skip = () => eng?.music.skip();
  const frame = (world: World, _now: number) => {
    const e = eng;
    if (!e) return;
    if (e.kit.ctx.state !== "running") return;
    e.music.pump();
    if (world.age < prevAge) cursor = 0; // a match reset rewound the sim
    prevAge = world.age;
    cursor = muted
      ? maxBurstId(world, cursor)
      : soundBursts(e.kit, world, e.samples, cursor);
  };

  return { resume, frame, setScene, toggleMute, setLevel, getLevels, skip };
};
