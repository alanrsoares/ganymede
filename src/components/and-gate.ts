import { err, ok } from "@onrails/result";
import type { Component } from "~/domain/component";
import type { Polarity, Pulse } from "~/domain/pulses";

export interface AndGateState {
  readonly arrivalWindow?: number;
}

export const createAndGate = (id: string): Component<AndGateState> => ({
  id,
  transition: (_tick, state, inputs) => {
    const presencePulses = inputs.filter((p) => p.polarity === 1);

    if (presencePulses.length < 2) {
      return ok([
        state,
        [
          {
            timestamp: inputs[0]?.timestamp ?? _tick,
            polarity: 0 as Polarity,
            channelId: `out-${id}`,
          },
        ],
      ]);
    }

    const timestamps = presencePulses.map((p) => p.timestamp);
    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);

    const window = state.arrivalWindow ?? 2;
    if (max - min > window) {
      return err({
        _tag: "Collision",
        timestamp: max,
      });
    }

    const outputs: Pulse[] = [
      {
        timestamp: max,
        polarity: 1 as Polarity,
        channelId: `out-${id}`,
      },
    ];

    return ok([state, outputs]);
  },
});
