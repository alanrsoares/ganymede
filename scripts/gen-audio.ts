// Offline SFX baker: synthesises the marquee combat hits (the loud, rare ones)
// into src/assets/audio/sfx/*.ogg. Pure procedural DSP → 16-bit WAV → ffmpeg
// (libopus). Committed + portable: `bun run scripts/gen-audio.ts` regenerates
// them anywhere ffmpeg is on PATH. The dense/cheap sounds (muzzle, impact) stay
// synthesised live in the runtime; only these six are baked for extra body.
//
// Music loops are NOT baked here — they're trimmed from external source tracks;
// see README (Audio) for that one-off recipe.
import { $ } from "bun";

const SR = 48000;
const OUT = "src/assets/audio/sfx";

// A mono render buffer with tiny DSP helpers layered onto it.
class Clip {
  buf: Float32Array;
  constructor(seconds: number) {
    this.buf = new Float32Array(Math.ceil(seconds * SR));
  }
  // Additive oscillator with exponential decay from `gain` to silence.
  tone(f0: number, f1: number, dur: number, gain: number, type = "sine") {
    const n = Math.min(this.buf.length, Math.ceil(dur * SR));
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const f = f0 * (f1 / f0) ** t;
      phase += (2 * Math.PI * f) / SR;
      const env = (1 - t) ** 2.2;
      this.buf[i] += osc(type, phase) * env * gain;
    }
  }
  // Filtered noise burst: one-pole lowpass on white noise, exp-decayed.
  noise(dur: number, gain: number, cutoff: number) {
    const n = Math.min(this.buf.length, Math.ceil(dur * SR));
    const a = Math.min(1, cutoff / SR);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += a * (Math.random() * 2 - 1 - lp);
      this.buf[i] += lp * (1 - i / n) ** 2 * gain;
    }
  }
  // Cheap feedback-delay tail so hits ring out instead of clicking off.
  tail(delayS: number, feedback: number) {
    const d = Math.floor(delayS * SR);
    for (let i = d; i < this.buf.length; i++)
      this.buf[i] += this.buf[i - d] * feedback;
  }
}

const osc = (type: string, phase: number): number => {
  switch (type) {
    case "square":
      return Math.sin(phase) >= 0 ? 1 : -1;
    case "saw":
      return 1 - ((((phase / Math.PI) % 2) + 2) % 2);
    case "triangle":
      return Math.asin(Math.sin(phase)) * (2 / Math.PI);
  }
  return Math.sin(phase);
};

// The six marquee voices. Each returns a rendered Clip.
const VOICES: Record<string, () => Clip> = {
  explosion() {
    const c = new Clip(0.7);
    c.tone(170, 42, 0.5, 0.55);
    c.noise(0.45, 0.5, 1200);
    c.tail(0.06, 0.28);
    return c;
  },
  detonation() {
    const c = new Clip(0.9);
    c.tone(120, 32, 0.75, 0.6);
    c.noise(0.6, 0.5, 800);
    c.tail(0.08, 0.34);
    return c;
  },
  emp() {
    const c = new Clip(0.5);
    c.tone(1100, 120, 0.32, 0.28, "square");
    c.noise(0.28, 0.14, 2600);
    c.tail(0.04, 0.3);
    return c;
  },
  shield() {
    const c = new Clip(0.6);
    c.tone(680, 700, 0.3, 0.18);
    c.tone(1020, 1050, 0.24, 0.12);
    c.tone(1530, 1560, 0.18, 0.07);
    return c;
  },
  arc() {
    const c = new Clip(0.35);
    c.noise(0.14, 0.2, 3200);
    c.tone(2400, 1600, 0.12, 0.08, "square");
    c.tail(0.03, 0.35);
    return c;
  },
  counter() {
    const c = new Clip(0.3);
    c.tone(760, 1520, 0.16, 0.22, "triangle");
    c.tone(1520, 3040, 0.1, 0.08);
    return c;
  },
};

// Peak-normalise to -1 dBFS, then quantise to a 16-bit PCM mono WAV buffer.
const toWav = (f32: Float32Array): Uint8Array => {
  let peak = 0;
  for (const s of f32) peak = Math.max(peak, Math.abs(s));
  const g = peak > 0 ? 0.89 / peak : 1;
  const bytes = new Uint8Array(44 + f32.length * 2);
  const dv = new DataView(bytes.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  dv.setUint32(4, 36 + f32.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  tag(36, "data");
  dv.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++)
    dv.setInt16(
      44 + i * 2,
      Math.max(-1, Math.min(1, f32[i] * g)) * 32767,
      true,
    );
  return bytes;
};

await $`mkdir -p ${OUT}`;
for (const [name, make] of Object.entries(VOICES)) {
  const wav = `${OUT}/${name}.wav`;
  await Bun.write(wav, toWav(make().buf));
  await $`ffmpeg -y -v error -i ${wav} -c:a libopus -b:a 96k ${OUT}/${name}.ogg`;
  await $`rm ${wav}`;
  console.log("baked ->", `${OUT}/${name}.ogg`);
}
