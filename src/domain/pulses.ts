import { err, ok } from "@onrails/result";

export type Polarity = 1 | 0;

export interface Pulse {
  readonly timestamp: number; // The tick the pulse occurs at
  readonly polarity: Polarity;
  readonly channelId: string;
}

export type TimingError =
  | {
      readonly _tag: "TooEarly";
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly _tag: "TooLate";
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly _tag: "Collision"; readonly timestamp: number };

/**
 * Validates if a pulse arrives within the expected timing window.
 */
export const validateTiming = (pulse: Pulse, expectedTick: number) => {
  if (pulse.timestamp < expectedTick) {
    return err({
      _tag: "TooEarly",
      expected: expectedTick,
      actual: pulse.timestamp,
    });
  }
  if (pulse.timestamp > expectedTick) {
    return err({
      _tag: "TooLate",
      expected: expectedTick,
      actual: pulse.timestamp,
    });
  }
  return ok(pulse);
};
