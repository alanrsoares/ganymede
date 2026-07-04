import { ok } from "@onrails/result";
import type { Component } from "~/domain/component";
import type { Polarity, Pulse } from "~/domain/pulses";

// Stateless gate; state is a placeholder for the transition contract.
export type XorGateState = Record<string, never>;

export const createXorGate = (id: string): Component<XorGateState> => ({
  id,
  transition: (_tick, state, inputs) => {
    const presenceCount = inputs.filter((p) => p.polarity === 1).length;
    const outputPolarity = presenceCount === 1 ? 1 : 0;

    const outputs: Pulse[] = [
      {
        timestamp: inputs[0]?.timestamp ?? _tick,
        polarity: outputPolarity as Polarity,
        channelId: `out-${id}`,
      },
    ];

    return ok([state, outputs]);
  },
});
