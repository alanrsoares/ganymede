import { ok, Result } from "@onrails/result";
import type { Component } from "../domain/component";
import type { Polarity, Pulse } from "../domain/pulses";

export interface ClockState {
  readonly period: number;
  readonly lastPulse: number;
}

export const createClock = (
  id: string,
  period: number,
): Component<ClockState> => ({
  id,
  transition: (tick, state, _inputs) => {
    // Emit a pulse every 'period' ticks.
    if (tick > 0 && tick % period === 0 && tick > state.lastPulse) {
      const outputs: Pulse[] = [
        {
          timestamp: tick,
          polarity: 1 as Polarity,
          channelId: `out-${id}`,
        },
      ];

      return ok([{ ...state, lastPulse: tick }, outputs]);
    }

    return ok([state, []]);
  },
});
