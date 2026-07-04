import { $, ok, tryGen } from "@onrails/result";
import type { Component } from "~/domain/component";
import type { Polarity, Pulse } from "~/domain/pulses";
import {
  createHalfAdder,
  type HalfAdderState,
  initialHalfAdderState,
} from "./half-adder";
import { createOrGate, type OrGateState } from "./or-gate";

export interface FullAdderState {
  readonly ha1State: HalfAdderState;
  readonly ha2State: HalfAdderState;
  readonly orState: OrGateState;
}

export const initialFullAdderState: FullAdderState = {
  ha1State: initialHalfAdderState,
  ha2State: initialHalfAdderState,
  orState: {},
};

const absentPulse = (tick: number, channelId: string): Pulse => ({
  timestamp: tick,
  polarity: 0 as Polarity,
  channelId,
});

export const createFullAdder = (id: string): Component<FullAdderState> => {
  const ha1 = createHalfAdder(`${id}-ha1`);
  const ha2 = createHalfAdder(`${id}-ha2`);
  const orGate = createOrGate(`${id}-or`);

  return {
    id,
    transition: (tick, state, inputs) =>
      tryGen(() => {
        // Named input ports: "a", "b", "cin"; missing = absence.
        const port = (name: string) =>
          inputs.find((p) => p.channelId === name) ?? absentPulse(tick, name);
        const a = port("a");
        const b = port("b");
        const cin = port("cin");

        // Step 1: First Half-Adder (A, B)
        const [nextS_ha1, outHA1] = $(
          ha1.transition(tick, state.ha1State, [a, b]),
        );

        // Step 2: Second Half-Adder (Sum1, CarryIn)
        const sum1 =
          outHA1.find((p) => p.channelId === `sum-${id}-ha1`) ??
          absentPulse(tick, `sum-${id}-ha1`);

        const [nextS_ha2, outHA2] = $(
          ha2.transition(tick, state.ha2State, [sum1, cin]),
        );

        // Step 3: OR gate for CarryOut (Carry1 OR Carry2)
        const carry1 =
          outHA1.find((p) => p.channelId === `carry-${id}-ha1`) ??
          absentPulse(tick, `carry-${id}-ha1`);
        const carry2 =
          outHA2.find((p) => p.channelId === `carry-${id}-ha2`) ??
          absentPulse(tick, `carry-${id}-ha2`);

        const [nextS_or, outOR] = $(
          orGate.transition(tick, state.orState, [carry1, carry2]),
        );

        // Final Outputs
        const sumPulse = outHA2.find((p) => p.channelId === `sum-${id}-ha2`);
        const carryOutPulse = outOR[0];

        const outputs: Pulse[] = [];
        if (sumPulse) outputs.push({ ...sumPulse, channelId: `sum-${id}` });
        if (carryOutPulse)
          outputs.push({ ...carryOutPulse, channelId: `carry-${id}` });

        return ok([
          {
            ha1State: nextS_ha1,
            ha2State: nextS_ha2,
            orState: nextS_or,
          },
          outputs,
        ]);
      }),
  };
};
