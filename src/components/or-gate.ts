import { ok, Result } from "@onrails/result";
import type { Component } from "../domain/component";
import type { Polarity, Pulse } from "../domain/pulses";

export type OrGateState = {};

export const createOrGate = (id: string): Component<OrGateState> => ({
  id,
  transition: (_tick, state, inputs) => {
    // An OR gate emits 1 if any of its inputs are 1.
    const hasPresence = inputs.some((p) => p.polarity === 1);

    const outputs: Pulse[] = [
      {
        timestamp: inputs[0]?.timestamp ?? _tick,
        polarity: hasPresence ? 1 : (0 as Polarity),
        channelId: `out-${id}`,
      },
    ];

    return ok([state, outputs]);
  },
});
