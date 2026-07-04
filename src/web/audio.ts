// Synthesizes the generative track (Elementary Audio) from a MusicState the
// pure composer in domain/music.ts produces each frame. Downtempo/Röyksopp
// voicing: a beat (kick/clap/hat), a sidechained sub-bass, a moving-filter
// harmony pad (detuned saws), and a plucked lead with dotted-eighth ping-pong
// delay, all through a send reverb. We rebuild the signal graph from state +
// live params every frame; Elementary diffs it and only writes changed props.
// No imperative scheduling — drum/bass/lead gates ride the CA-driven transport.

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

/** Kick: pitch-swept sine with a fast amp env — deep and round. */
const kickVoice = (gate: number): NodeRepr_t => {
  const g = el.const({ key: "kg", value: gate });
  const amp = el.adsr(0.002, 0.2, 0, 0.06, g);
  const pitch = el.add(42, el.mul(95, el.adsr(0.001, 0.07, 0, 0.05, g)));
  return el.mul(amp, el.tanh(el.mul(1.3, el.cycle(pitch))));
};

/** Clap/snare: soft highpassed noise burst on the backbeat. */
const snareVoice = (gate: number): NodeRepr_t => {
  const g = el.const({ key: "sg", value: gate });
  const amp = el.adsr(0.001, 0.11, 0, 0.06, g);
  const noise = el.highpass(1600, 0.7, el.pinknoise());
  const tone = el.mul(0.25, el.cycle(180));
  return el.mul(0.8, amp, el.add(noise, tone));
};

/** Hat: highpassed pink noise with a very short env. */
const hatVoice = (gate: number): NodeRepr_t => {
  const g = el.const({ key: "hg", value: gate });
  const amp = el.adsr(0.001, 0.035, 0, 0.02, g);
  return el.mul(0.5, amp, el.highpass(8000, 0.8, el.pinknoise()));
};

/** Sub-bass: sine + sub-octave, saturated and lowpassed; the pump anchor. */
const bassVoice = (freq: number, gate: number): NodeRepr_t => {
  const g = el.sm(el.const({ key: "bg", value: gate }));
  const env = el.adsr(0.012, 0.18, 0.75, 0.14, g);
  const f = el.const({ key: "bf", value: freq });
  const osc = el.add(el.cycle(f), el.mul(0.6, el.cycle(el.mul(0.5, f))));
  const sat = el.tanh(el.mul(1.6, osc));
  return el.dcblock(
    el.mul(env, el.lowpass(el.const({ key: "bcut", value: 200 }), 0.5, sat)),
  );
};

/** Harmony pad: three-voice detuned saws per chord tone through a moving
 *  lowpass. `cutoff` (Hz) is driven by the automaton for slow filter sweeps. */
const padLayer = (chord: number[], cutoffHz: number): NodeRepr_t => {
  const voices = chord.map((f, i) =>
    el.add(
      el.blepsaw(el.const({ key: `pa${i}`, value: f * 0.997 })),
      el.blepsaw(el.const({ key: `pb${i}`, value: f })),
      el.blepsaw(el.const({ key: `pc${i}`, value: f * 1.004 })),
    ),
  );
  const mix = el.mul(1 / (chord.length + 1), el.add(0, ...voices));
  const cut = el.sm(el.const({ key: "pcut", value: cutoffHz }));
  return el.lowpass(cut, 0.6, mix);
};

/** Melody lead: a plucked triangle+saw voice, gated by the pattern. */
const leadVoice = (freq: number, gate: number): NodeRepr_t => {
  const g = el.sm(el.const({ key: "lg", value: gate }));
  const env = el.adsr(0.004, 0.13, 0.18, 0.22, g);
  const f = el.const({ key: "lf", value: freq });
  const tone = el.add(el.bleptriangle(f), el.mul(0.25, el.blepsaw(f)));
  return el.mul(env, tone);
};

/** Lightweight send reverb: parallel feedback delays into a lowpass. */
const reverb = (x: NodeRepr_t, times: number[], tag: string): NodeRepr_t => {
  const taps = times.map((t, i) =>
    el.delay(
      { size: 96000 },
      el.ms2samps(el.const({ key: `rv${tag}${i}`, value: t })),
      0.55,
      x,
    ),
  );
  return el.lowpass(
    el.const({ key: `rvlp${tag}`, value: 3200 }),
    0.4,
    el.mul(0.5, el.add(0, ...taps)),
  );
};

export const createAutomataAudio = (): AutomataAudio => {
  let engine: Engine | null = null;
  let ready = false;
  let muted = false;
  const params: AudioParams = { ...DEFAULTS };

  const echo = (
    dry: NodeRepr_t,
    ms: number,
    tag: string,
    fb = 0.34,
  ): NodeRepr_t =>
    el.delay(
      { size: 96000 },
      el.ms2samps(el.const({ key: `dt${tag}`, value: ms })),
      fb,
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

      // Sidechain: duck the harmonic bed with the kick's envelope for the pump.
      const kEnv = el.adsr(
        0.005,
        0.16,
        0,
        0.12,
        el.const({ key: "scg", value: music.kick }),
      );
      const duck = el.sub(1, el.mul(0.75, kEnv));

      const bassSig = bassVoice(music.bass.freq, music.bass.gate);
      const padSig = padLayer(music.chord, 240 + music.cutoff * 3600);
      const bed = el.mul(
        duck,
        el.add(
          el.mul(
            el.const({ key: "bassLvl", value: params.harmony * 0.5 }),
            bassSig,
          ),
          el.mul(
            el.const({ key: "padLvl", value: params.harmony * 0.1 }),
            padSig,
          ),
        ),
      );

      const lead = el.mul(
        el.const({ key: "leadLvl", value: params.melody * 0.42 }),
        leadVoice(music.lead.freq, music.lead.gate),
      );
      // Dotted-eighth ping-pong delay on the pluck — the Röyksopp arp shimmer.
      const echoL = el.mul(0.32, echo(lead, 380, "l"));
      const echoR = el.mul(0.32, echo(lead, 500, "r"));

      // Send reverb on the pad + lead for the wide, atmospheric tail.
      const send = el.add(el.mul(0.5, padSig), el.mul(0.45, lead));
      const revL = el.mul(0.5, reverb(send, [79, 113, 167], "L"));
      const revR = el.mul(0.5, reverb(send, [97, 131, 181], "R"));

      const dry = el.add(beat, bed, lead);
      const gain = el.const({
        key: "master",
        value: muted ? 0 : params.master,
      });
      const left = el.tanh(el.mul(gain, el.add(dry, echoL, revL)));
      const right = el.tanh(el.mul(gain, el.add(dry, echoR, revR)));
      void engine.core.render(left, right);
    },
  };
};
