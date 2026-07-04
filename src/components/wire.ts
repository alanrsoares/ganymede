import { ok } from "@onrails/result";
import type { Component } from "~/domain/component";

export interface WireState {
  readonly length: number; // Delay in ticks
}

export const createWire = (id: string): Component<WireState> => ({
  id,
  transition: (_tick, state, inputs) => {
    const outputs = inputs.map((pulse) => ({
      ...pulse,
      timestamp: pulse.timestamp + state.length,
      channelId: `out-${id}`,
    }));
    return ok([state, outputs]);
  },
});
