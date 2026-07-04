import { ok, Result } from "@onrails/result";
import type { Component } from "../domain/component";
import { Polarity, type Pulse } from "../domain/pulses";
import { createAndGate } from "./and-gate";
import { createXorGate } from "./xor-gate";

export interface HalfAdderState {
  readonly xorState: any;
  readonly andState: any;
}

export const createHalfAdder = (id: string): Component<HalfAdderState> => {
  const xor = createXorGate(`${id}-xor`);
  const and = createAndGate(`${id}-and`);

  return {
    id,
    transition: (_tick, state, inputs) => {
      const resXor = xor.transition(_tick, state.xorState, inputs);
      const resAnd = and.transition(_tick, state.andState, inputs);

      if (resXor._tag === "Err" || resAnd._tag === "Err") {
        return ok([state, []]);
      }

      const [nextS_xor, outXor] = resXor.value;
      const [nextS_and, outAnd] = resAnd.value;

      // Use the first pulse of each result if available
      const sumPulse = outXor[0];
      const carryPulse = outAnd[0];

      const outputs: Pulse[] = [];
      if (sumPulse) outputs.push({ ...sumPulse, channelId: `sum-${id}` });
      if (carryPulse) outputs.push({ ...carryPulse, channelId: `carry-${id}` });

      return ok([
        { ...state, xorState: nextS_xor, andState: nextS_and },
        outputs,
      ]);
    },
  };
};
