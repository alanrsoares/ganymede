import { $, ok, tryGen } from "@onrails/result";
import type { Component } from "~/domain/component";
import type { Pulse } from "~/domain/pulses";
import { type AndGateState, createAndGate } from "./and-gate";
import { createXorGate, type XorGateState } from "./xor-gate";

export interface HalfAdderState {
  readonly xorState: XorGateState;
  readonly andState: AndGateState;
}

export const initialHalfAdderState: HalfAdderState = {
  xorState: {},
  andState: {},
};

export const createHalfAdder = (id: string): Component<HalfAdderState> => {
  const xor = createXorGate(`${id}-xor`);
  const and = createAndGate(`${id}-and`);

  return {
    id,
    transition: (tick, state, inputs) =>
      tryGen(() => {
        const [nextS_xor, outXor] = $(
          xor.transition(tick, state.xorState, inputs),
        );
        const [nextS_and, outAnd] = $(
          and.transition(tick, state.andState, inputs),
        );

        // Use the first pulse of each result if available
        const sumPulse = outXor[0];
        const carryPulse = outAnd[0];

        const outputs: Pulse[] = [];
        if (sumPulse) outputs.push({ ...sumPulse, channelId: `sum-${id}` });
        if (carryPulse)
          outputs.push({ ...carryPulse, channelId: `carry-${id}` });

        return ok([{ xorState: nextS_xor, andState: nextS_and }, outputs]);
      }),
  };
};
