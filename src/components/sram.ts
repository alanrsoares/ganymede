import { ok } from "@onrails/result";
import type { Component } from "~/domain/component";
import type { Polarity, Pulse } from "~/domain/pulses";

export interface SRAMState {
  readonly value: 1 | 0;
}

export const createSRAM = (id: string): Component<SRAMState> => ({
  id,
  transition: (_tick, state, inputs) => {
    const writeSignal = inputs.find((p) => p.polarity === 1);

    let nextValue = state.value;
    if (writeSignal) {
      nextValue = state.value === 1 ? 0 : 1;
    }

    // SRAM always outputs its current value, whether it's reading or writing.
    const outputs: Pulse[] = [
      {
        timestamp: inputs[0]?.timestamp ?? _tick,
        polarity: nextValue as Polarity,
        channelId: `out-${id}`,
      },
    ];

    return ok([{ value: nextValue }, outputs]);
  },
});
