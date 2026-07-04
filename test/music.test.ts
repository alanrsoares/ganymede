import { describe, expect, test } from "bun:test";
import {
  type CaObservations,
  compose,
  type MusicParams,
  SCALE_NAMES,
  STEP_GENS,
} from "~/domain/music";

const PARAMS: MusicParams = { root: 220, scale: "minor pentatonic" };

const obs = (over: Partial<CaObservations> = {}): CaObservations => ({
  population: 0,
  activity: 0,
  gateHigh: true,
  step: 0,
  ...over,
});

describe("compose — beat layer", () => {
  test("four-on-the-floor kick when the gate is high", () => {
    const kicks = Array.from(
      { length: 16 },
      (_, step) => compose(obs({ step }), PARAMS).kick,
    );
    expect(kicks).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  test("gate low halves the kick (breakdown)", () => {
    const kicks = Array.from(
      { length: 16 },
      (_, step) => compose(obs({ step, gateHigh: false }), PARAMS).kick,
    );
    expect(kicks).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("snare on the backbeat", () => {
    expect(compose(obs({ step: 4 }), PARAMS).snare).toBe(1);
    expect(compose(obs({ step: 12 }), PARAMS).snare).toBe(1);
    expect(compose(obs({ step: 0 }), PARAMS).snare).toBe(0);
  });

  test("high activity fills every step with hats", () => {
    for (let step = 0; step < 16; step++) {
      expect(compose(obs({ step, activity: 0.9 }), PARAMS).hat).toBe(1);
    }
  });
});

describe("compose — harmony layer", () => {
  test("three positive chord tones", () => {
    const { chord } = compose(obs(), PARAMS);
    expect(chord).toHaveLength(3);
    for (const f of chord) expect(f).toBeGreaterThan(0);
  });

  test("chord moves across bars (4-bar loop)", () => {
    const roots = [0, 1, 2, 3].map(
      (bar) => compose(obs({ step: bar * 16 }), PARAMS).chord[0],
    );
    // Not a single static chord across the loop.
    expect(new Set(roots).size).toBeGreaterThan(1);
    // Loops back on bar 4.
    expect(compose(obs({ step: 64 }), PARAMS).chord[0]).toBe(roots[0]);
  });
});

describe("compose — melody layer", () => {
  test("lead frequency is always a positive in-scale pitch", () => {
    for (const scale of SCALE_NAMES) {
      for (let step = 0; step < 32; step++) {
        const { lead } = compose(obs({ step }), { root: 220, scale });
        expect(lead.freq).toBeGreaterThan(0);
      }
    }
  });

  test("population lifts the lead register", () => {
    const low = compose(obs({ step: 1 }), PARAMS).lead.freq;
    const high = compose(obs({ step: 1, population: 1 }), PARAMS).lead.freq;
    expect(high).toBeGreaterThan(low);
  });
});

test("STEP_GENS is a positive integer", () => {
  expect(Number.isInteger(STEP_GENS)).toBe(true);
  expect(STEP_GENS).toBeGreaterThan(0);
});
