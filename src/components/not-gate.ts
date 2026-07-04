import { ok, Result } from "@onrails/result";
import type { Component } from "../domain/component";
import type { Polarity, Pulse } from "../domain/pulses";

export interface NotGateState {
  readonly clockTick: number;
}

export const createNotGate = (id: string): Component<NotGateState> => ({
  id,
  transition: (tick, state, inputs) => {
    // A NOT gate in this simulation produces an output only when it is "clocked".
    // We assume the component logic knows if it's on a clock edge.
    // For simplicity, let's say it outputs every tick, but we should only do so
    // if we are actually simulating a clocked system.

    const hasInputPulse = inputs.some(
      (p) => p.polarity === 1 && Math.abs(p.timestamp - tick) <= 1,
    );
    const outputPolarity = hasInputPulse ? 0 : 1;

    // To prevent spamming, we only emit a pulse if this is the exact clock tick
    if (tick !== state.clockTick) {
      return ok([state, []]);
    }

    const outputs: Pulse[] = [
      {
        timestamp: tick,
        polarity: outputPolarity as Polarity,
        channelId: `out-${id}`,
      },
    ];

    return ok([state, outputs]);
  },
});
