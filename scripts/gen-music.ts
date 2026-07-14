// Offline music baker: composes the game's instrumental synthwave loops from a
// tiny procedural tracker — no vocals, no AI slop, deterministic, zero licensing.
// Renders stereo PCM → 16-bit WAV → ffmpeg (libopus) into src/assets/audio/music.
//
//   bun run scripts/gen-music.ts            # rebuild all scenes
//   bun run scripts/gen-music.ts battle     # rebuild one scene
//
// Each scene shares the i–VI–III–VII synthwave progression in A minor; tempo,
// drum pattern and brightness set the mood (calm menu → driving battle → fast
// arcade). Runtime crossfades the loop seam, so tracks need only be periodic.
import { $ } from "bun";

const SR = 44100;
const OUT = "src/assets/audio/music";
const midi = (m: number) => 440 * 2 ** ((m - 69) / 12);

// i–VI–III–VII in A minor: [bass root midi, triad midis]. Two bars each.
const PROG = [
  { root: 45, triad: [57, 60, 64] }, // Am
  { root: 41, triad: [53, 57, 60] }, // F
  { root: 48, triad: [60, 64, 67] }, // C
  { root: 43, triad: [55, 59, 62] }, // G
] as const;

interface Mood {
  bpm: number;
  cycles: number; // repeats of the 8-bar progression
  drums: number; // 0 none · 1 backbeat · 2 four-on-floor
  bright: number; // arp/lead lowpass cutoff (Hz)
  lead: boolean;
}
const MOODS: Record<string, Mood> = {
  menu: { bpm: 96, cycles: 2, drums: 0, bright: 1600, lead: false },
  battle: { bpm: 126, cycles: 2, drums: 2, bright: 3200, lead: true },
  arcade: { bpm: 140, cycles: 2, drums: 2, bright: 4200, lead: true },
};

const osc = (type: string, ph: number): number => {
  if (type === "square") return Math.sin(ph) >= 0 ? 0.7 : -0.7;
  if (type === "saw") return 1 - ((((ph / Math.PI) % 2) + 2) % 2);
  if (type === "triangle") return Math.asin(Math.sin(ph)) * (2 / Math.PI);
  return Math.sin(ph);
};

// Attack/release gate so notes don't click at their edges.
const gate = (i: number, n: number, atk: number, rel: number) => {
  if (i < atk) return i / atk;
  if (i > n - rel) return Math.max(0, (n - i) / rel);
  return 1;
};

class Track {
  L: Float32Array;
  R: Float32Array;
  constructor(seconds: number) {
    this.L = new Float32Array(Math.ceil(seconds * SR));
    this.R = new Float32Array(Math.ceil(seconds * SR));
  }
  // One filtered, gated oscillator note, equal-power panned into the stereo bus.
  note(
    at: number,
    dur: number,
    m: number,
    type: string,
    gain: number,
    opt?: {
      pan?: number;
      cut?: number;
    },
  ) {
    const pan = opt?.pan ?? 0;
    const cut = opt?.cut ?? 12000;
    const s0 = Math.floor(at * SR);
    const n = Math.floor(dur * SR);
    const a = Math.min(1, cut / SR);
    const gl = Math.cos(((pan + 1) * Math.PI) / 4) * gain;
    const gr = Math.sin(((pan + 1) * Math.PI) / 4) * gain;
    let ph = 0;
    let lp = 0;
    const step = (2 * Math.PI * midi(m)) / SR;
    for (let i = 0; i < n && s0 + i < this.L.length; i++) {
      ph += step;
      lp += a * (osc(type, ph) - lp);
      const v = lp * gate(i, n, SR * 0.005, n * 0.25) * (1 - i / n) ** 0.4;
      this.L[s0 + i] += v * gl;
      this.R[s0 + i] += v * gr;
    }
  }
  // Percussion: pitch-dropping sine (kick) or filtered noise (snare/hat).
  hit(at: number, dur: number, gain: number, kind: "kick" | "snare" | "hat") {
    const s0 = Math.floor(at * SR);
    const n = Math.floor(dur * SR);
    let ph = 0;
    for (let i = 0; i < n && s0 + i < this.L.length; i++) {
      const t = i / n;
      const env = (1 - t) ** (kind === "kick" ? 2.5 : 3.5);
      const f = kind === "kick" ? 120 * (1 - t) ** 2 + 45 : 0;
      ph += (2 * Math.PI * f) / SR;
      const body = kind === "kick" ? Math.sin(ph) : Math.random() * 2 - 1;
      const v = body * env * gain;
      this.L[s0 + i] += v;
      this.R[s0 + i] += v;
    }
  }
}

// Lay down bass + arpeggio + pad (+ optional lead) + drums for one mood.
const compose = (mood: Mood): Track => {
  const beat = 60 / mood.bpm;
  const bar = beat * 4;
  const bars = PROG.length * 2 * mood.cycles;
  const t = new Track(bars * bar + 0.5);
  for (let b = 0; b < bars; b++) {
    const chord = PROG[Math.floor(b / 2) % PROG.length];
    const t0 = b * bar;
    layBass(t, t0, beat, chord.root);
    layArp(t, t0, beat, chord.triad, mood.bright);
    layPad(t, t0, bar, chord.triad);
    if (mood.lead && b % 2 === 1)
      layLead(t, t0, beat, chord.triad, mood.bright);
    if (mood.drums) layDrums(t, t0, beat, mood.drums);
  }
  return t;
};

const layBass = (t: Track, t0: number, beat: number, root: number) => {
  for (
    let e = 0;
    e < 8;
    e++ // driving 8th-note root pulse
  )
    t.note(t0 + e * beat * 0.5, beat * 0.46, root, "saw", 0.5, { cut: 700 });
};

const layArp = (
  t: Track,
  t0: number,
  beat: number,
  triad: readonly number[],
  cut: number,
) => {
  const notes = [triad[0], triad[1], triad[2], triad[1] + 12];
  for (let s = 0; s < 16; s++) {
    const m = notes[s % notes.length] + 12;
    const pan = s % 2 === 0 ? -0.5 : 0.5;
    t.note(t0 + s * beat * 0.25, beat * 0.22, m, "square", 0.16, { pan, cut });
  }
};

const layPad = (
  t: Track,
  t0: number,
  bar: number,
  triad: readonly number[],
) => {
  for (const m of triad) {
    t.note(t0, bar * 0.98, m, "saw", 0.09, { pan: -0.3, cut: 1400 });
    t.note(t0, bar * 0.98, m, "saw", 0.09, { pan: 0.3, cut: 1400 });
  }
};

const layLead = (
  t: Track,
  t0: number,
  beat: number,
  triad: readonly number[],
  cut: number,
) => {
  const line = [triad[2] + 12, triad[1] + 12, triad[2] + 12, triad[0] + 24];
  for (let i = 0; i < line.length; i++)
    t.note(t0 + i * beat, beat * 0.9, line[i], "triangle", 0.14, { cut });
};

const layDrums = (t: Track, t0: number, beat: number, mode: number) => {
  for (let b = 0; b < 4; b++) {
    if (mode === 2 || b % 2 === 0) t.hit(t0 + b * beat, 0.18, 0.7, "kick");
    if (b % 2 === 1) t.hit(t0 + b * beat, 0.16, 0.35, "snare");
    t.hit(t0 + b * beat + beat * 0.5, 0.05, 0.14, "hat");
  }
};

// Peak-normalise both channels together, quantise to interleaved 16-bit WAV.
const toWav = (L: Float32Array, R: Float32Array): Uint8Array => {
  let peak = 0;
  for (let i = 0; i < L.length; i++)
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak > 0 ? 0.85 / peak : 1;
  const bytes = new Uint8Array(44 + L.length * 4);
  const dv = new DataView(bytes.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  dv.setUint32(4, 36 + L.length * 4, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  tag(36, "data");
  dv.setUint32(40, L.length * 4, true);
  const q = (x: number) => Math.max(-1, Math.min(1, x * g)) * 32767;
  for (let i = 0; i < L.length; i++) {
    dv.setInt16(44 + i * 4, q(L[i]), true);
    dv.setInt16(44 + i * 4 + 2, q(R[i]), true);
  }
  return bytes;
};

const wanted = Bun.argv.slice(2);
const scenes = wanted.length ? wanted : Object.keys(MOODS);
await $`mkdir -p ${OUT}`;
for (const scene of scenes) {
  const mood = MOODS[scene];
  if (!mood) throw new Error(`unknown scene: ${scene}`);
  const t = compose(mood);
  const wav = `${OUT}/${scene}.wav`;
  await Bun.write(wav, toWav(t.L, t.R));
  await $`ffmpeg -y -v error -i ${wav} -c:a libopus -b:a 112k ${OUT}/${scene}.ogg`;
  await $`rm ${wav}`;
  console.log("baked ->", `${OUT}/${scene}.ogg`);
}
