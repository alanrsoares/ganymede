import { ok, Result } from "@onrails/result";
import type { Component } from "../domain/component";
import type { Polarity, Pulse } from "../domain/pulses";
import { createHalfAdder } from "./half-adder";
import { createOrGate } from "./or-gate";

export interface FullAdderState {
  readonly ha1State: any;
  readonly ha2State: any;
  readonly orState: any;
}

export const createFullAdder = (id: string): Component<FullAdderState> => {
  const ha1 = createHalfAdder(`${id}-ha1`);
  const ha2 = createHalfAdder(`${id}-ha2`);
  const orGate = createOrGate(`${id}-or`);

  return {
    id,
    transition: (_tick, state, inputs) => {
      // Defaults for state initialization during tests/first run
      const s_ha1 = state.ha1State ?? { xorState: {}, andState: {} };
      const s_ha2 = state.ha2State ?? { xorState: {}, andState: {} };
      const s_or = state.orState ?? {};

      // Inputs: A (idx 0), B (idx 1), CarryIn (idx 2)
      const a = inputs[0] || {
        timestamp: _tick,
        polarity: 0 as Polarity,
        channelId: "inA",
      };
      const b = inputs[1] || {
        timestamp: _tick,
        polarity: 0 as Polarity,
        channelId: "inB",
      };
      const cin = inputs[2] || {
        timestamp: _tick,
        polarity: 0 as Polarity,
        channelId: "inCin",
      };

      // Step 1: First Half-Adder (A, B)
      const resHA1 = ha1.transition(_tick, s_ha1, [a, b]);
      if (resHA1._tag === "Err") return ok([state, []]);
      const [nextS_ha1, outHA1] = resHA1.value;

      // Step 2: Second Half-Adder (Sum1, CarryIn)
      const sum1 = outHA1.find((p) => p.channelId === `sum-${id}-ha1`);
      if (!sum1) return ok([state, []]);

      const resHA2 = ha2.transition(_tick, s_ha2, [sum1, cin]);
      if (resHA2._tag === "Err") return ok([state, []]);
      const [nextS_ha2, outHA2] = resHA2.value;

      // Step 3: OR gate for CarryOut (Carry1 OR Carry2)
      const carry1 = outHA1.find((p) => p.channelId === `carry-${id}-ha1`);
      const carry2 = outHA2.find((p) => p.channelHId === `carry-${id}-ha2`); // Fix: channelId

      // Re-check the property name for carry2
      const c2 = outHA2.find((p) => p.channelId === `carry-${id}-ha2`);

      const resOR = orGate.transition(_tick, s_or, [
        carry1 || { polarity: 0 as Polarity },
        c2 || { polarity: 0 as Polarity },
      ]);
      if (resOR._tag === "Err") return ok([state, []]);
      const [nextS_or, outOR] = resOR.value;

      // Final Outputs
      const sumPulse = outHA2.find((p) => p.channelId === `sum-${id}-ha2`);
      const carryOutPulse = outOR[0];

      const outputs: Pulse[] = [];
      if (sumPulse) outputs.push({ ...sumPulse, channelId: `sum-${id}` });
      if (carryOutPulse)
        outputs.push({ ...carryOutPulse, channelId: `carry-${id}` });

      return ok([
        {
          ...state,
          ha1State: nextS_ha1,
          ha2State: nextS_ha2,
          orState: nextS_or,
        },
        outputs,
      ]);
    },
  };
};
