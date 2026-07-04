import { ok } from "@onrails/result";
import type { Component } from "~/domain/component";
import type { Polarity, Pulse } from "~/domain/pulses";

export interface NotGateState {
  // Sampling period in ticks. Inverting absence requires a clock: the gate
  // emits on every period boundary, whether or not an input pulse arrived.
  readonly period: number;
}

export const createNotGate = (id: string): Component<NotGateState> => ({
  id,
  transition: (tick, state, inputs) => {
    if (tick <= 0 || tick % state.period !== 0) {
      return ok([state, []]);
    }

    const hasInputPulse = inputs.some((p) => p.polarity === 1);
    const outputPolarity: Polarity = hasInputPulse ? 0 : 1;

    const outputs: Pulse[] = [
      {
        timestamp: tick,
        polarity: outputPolarity,
        channelId: `out-${id}`,
      },
    ];

    return ok([state, outputs]);
  },
});
