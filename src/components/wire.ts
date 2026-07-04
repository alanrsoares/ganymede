import { ok, Result } from "@onrails/result";
import type { Component } from "../domain/component";
import { Pulse } from "../domain/pulses";

export interface WireState {
  readonly length: number; // Delay in ticks
}

export const createWire = (
  id: string,
  length: number,
): Component<WireState> => ({
  id,
  transition: (_tick, state, inputs) => {
    if (inputs.length > 0) {
      console.log(`Wire ${id} processing ${inputs.length} pulses`);
    }
    const outputs = inputs.map((pulse) => ({
      ...pulse,
      timestamp: pulse.timestamp + state.length,
    }));
    console.log(`Wire ${id} emitting ${outputs.length} pulses`);
    return ok([state, outputs]);
  },
});
