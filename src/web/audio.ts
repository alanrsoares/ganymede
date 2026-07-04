// Synthesizes the generative track (Elementary Audio) from a MusicState the
// pure composer in domain/music.ts produces each frame. Three layers: a beat
// (kick/snare/hat), a harmony pad (detuned saws → lowpass on chord tones), and
// a melody lead. We rebuild the signal graph from state + live params every
// frame; Elementary diffs it and only writes changed props. No imperative
// scheduling — drum/lead gates ride the CA-driven transport.

import { el, type NodeRepr_t } from "@elemaudio/core";
import WebRenderer from "@elemaudio/web-renderer";
import type { MusicState } from "~/domain/music";

/** Live-tweakable layer mix (driven by the on-screen knobs). */
export interface AudioParams {
  master: number; // 0..1
  beat: number; // 0..1
  harmony: number; // 0..1
  melody: number; // 0..1
}

const DEFAULTS: AudioParams = {
  master: 0.5,
  beat: 0.9,
  harmony: 0.7,
  melody: 0.8,
};

export interface AutomataAudio {
  /** Create/resume the context from a user gesture; safe to call repeatedly. */
  resume(): void;
  /** True once the graph is live and unmuted. */
  enabled(): boolean;
  /** Toggle master gain; returns the new muted state. */
  toggleMute(): boolean;
  /** Merge live parameter changes from the knobs. */
  configure(p: Partial<AudioParams>): void;
  /** Render one step of the generative track. */
  render(music: MusicState): void;
}

interface Engine {
  ctx: AudioContext;
  core: WebRenderer;
}

// --- Layer synthesis (pure Elementary graph builders) ---

/** Kick: pitch-swept sine with a fast amp env. */
const kickVoice = (gate: number): NodeRepr_t => {
  const g = el.const({ key: "kg", value: gate });
  const amp = el.adsr(0.002, 0.16, 0, 0.05, g);
  const pitch = el.add(45, el.mul(80, el.adsr(0.001, 0.06, 0, 0.05, g)));
  return el.mul(amp, el.cycle(pitch));
};

/** Snare: highpassed noise plus a short tone. */
const snareVoice = (gate: number): NodeRepr_t => {
  const g = el.const({ key: "sg", value: gate });
  const amp = el.adsr(0.001, 0.12, 0, 0.05, g);
  const noise = el.highpass(1400, 0.9, el.noise());
  const tone = el.mul(0.4, el.cycle(190));
  return el.mul(amp, el.add(noise, tone));
};

/** Hat: highpassed noise with a very short env. */
const hatVoice = (gate: number): NodeRepr_t => {
  const g = el.const({ key: "hg", value: gate });
  const amp = el.adsr(0.001, 0.03, 0, 0.02, g);
  return el.mul(0.6, amp, el.highpass(7000, 0.9, el.noise()));
};

/** Harmony pad: detuned saws per chord tone through a lowpass. */
const padLayer = (chord: number[]): NodeRepr_t => {
  const voices = chord.map((f, i) =>
    el.add(
      el.blepsaw(el.const({ key: `pa${i}`, value: f })),
      el.blepsaw(el.const({ key: `pb${i}`, value: f * 1.005 })),
    ),
  );
  const mix = el.add(0, ...voices);
  return el.lowpass(el.const({ key: "pcut", value: 900 }), 0.7, mix);
};

/** Melody lead: a plucked triangle voice, gated by the pattern. */
const leadVoice = (freq: number, gate: number): NodeRepr_t => {
  const g = el.sm(el.const({ key: "lg", value: gate }));
  const env = el.adsr(0.004, 0.14, 0.2, 0.18, g);
  return el.mul(env, el.bleptriangle(el.const({ key: "lf", value: freq })));
};

export const createAutomataAudio = (): AutomataAudio => {
  let engine: Engine | null = null;
  let ready = false;
  let muted = false;
  const params: AudioParams = { ...DEFAULTS };

  const echo = (dry: NodeRepr_t, ms: number, tag: string): NodeRepr_t =>
    el.delay(
      { size: 48000 },
      el.ms2samps(el.const({ key: `dt${tag}`, value: ms })),
      0.3,
      dry,
    );

  const init = async (): Promise<void> => {
    if (engine) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const core = new WebRenderer();
    const node = await core.initialize(ctx, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    engine = { ctx, core };
    ready = true;
  };

  return {
    resume: () => {
      void init().then(() => {
        if (engine && engine.ctx.state !== "running") void engine.ctx.resume();
      });
    },
    enabled: () => ready && engine?.ctx.state === "running" && !muted,
    toggleMute: () => {
      muted = !muted;
      return muted;
    },
    configure: (p) => {
      Object.assign(params, p);
    },
    render: (music) => {
      if (!engine || !ready || engine.ctx.state !== "running") return;

      const beat = el.mul(
        el.const({ key: "beatLvl", value: params.beat }),
        el.add(
          kickVoice(music.kick),
          snareVoice(music.snare),
          hatVoice(music.hat),
        ),
      );
      const harmony = el.mul(
        el.const({ key: "harmLvl", value: params.harmony * 0.12 }),
        padLayer(music.chord),
      );
      const lead = el.mul(
        el.const({ key: "leadLvl", value: params.melody * 0.5 }),
        leadVoice(music.lead.freq, music.lead.gate),
      );

      const dry = el.add(beat, harmony, lead);
      const gain = el.const({
        key: "master",
        value: muted ? 0 : params.master,
      });
      const left = el.tanh(
        el.mul(gain, el.add(dry, el.mul(0.28, echo(lead, 270, "l")))),
      );
      const right = el.tanh(
        el.mul(gain, el.add(dry, el.mul(0.28, echo(lead, 330, "r")))),
      );
      void engine.core.render(left, right);
    },
  };
};
