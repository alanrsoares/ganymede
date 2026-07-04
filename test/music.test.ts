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
  andHigh: true,
  laneTriggers: [],
  step: 0,
  ...over,
});

/** A lane-trigger vector of `len` with a single arrival at `fire`. */
const fireLane = (fire: number, len = 5): boolean[] =>
  Array.from({ length: len }, (_, i) => i === fire);

describe("compose — beat layer", () => {
  test("steady four-on-the-floor kick (drums are the clock)", () => {
    const kicks = Array.from(
      { length: 16 },
      (_, step) => compose(obs({ step }), PARAMS).kick,
    );
    expect(kicks).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  test("kick is unaffected by the gate outputs (computation ≠ timing)", () => {
    const on = Array.from(
      { length: 16 },
      (_, step) => compose(obs({ step }), PARAMS).kick,
    );
    const off = Array.from(
      { length: 16 },
      (_, step) =>
        compose(obs({ step, gateHigh: false, andHigh: false }), PARAMS).kick,
    );
    expect(off).toEqual(on);
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
  test("four positive chord tones (7th voicing)", () => {
    const { chord } = compose(obs(), PARAMS);
    expect(chord).toHaveLength(4);
    for (const f of chord) expect(f).toBeGreaterThan(0);
    // Ascending voicing (root < 3rd < 5th < 7th).
    for (let i = 1; i < chord.length; i++)
      expect(chord[i]).toBeGreaterThan(chord[i - 1]);
  });

  test("chord moves across bars (4-bar loop)", () => {
    const roots = [0, 1, 2, 3].map(
      (bar) => compose(obs({ step: bar * 16 }), PARAMS).chord[0],
    );
    expect(new Set(roots).size).toBeGreaterThan(1);
    expect(compose(obs({ step: 64 }), PARAMS).chord[0]).toBe(roots[0]);
  });

  test("the AND gate bit enables the pad", () => {
    expect(compose(obs({ andHigh: true }), PARAMS).padGate).toBe(1);
    expect(compose(obs({ andHigh: false }), PARAMS).padGate).toBe(0);
  });
});

describe("compose — gate word transposes harmony", () => {
  test("setting a gate bit raises the tonal centre", () => {
    const low = compose(obs({ gateHigh: false, andHigh: false }), PARAMS)
      .chord[0];
    const high = compose(obs({ gateHigh: true, andHigh: false }), PARAMS)
      .chord[0];
    expect(high).toBeGreaterThan(low);
  });

  test("both bits transpose further than one", () => {
    const one = compose(obs({ gateHigh: true, andHigh: false }), PARAMS)
      .chord[0];
    const both = compose(obs({ gateHigh: true, andHigh: true }), PARAMS)
      .chord[0];
    expect(both).toBeGreaterThan(one);
  });
});

describe("compose — arp (physics-timed melody)", () => {
  test("no glider arrival = silent arp", () => {
    const { lead } = compose(obs({ laneTriggers: [] }), PARAMS);
    expect(lead.gate).toBe(0);
  });

  test("a lane arrival opens the arp gate", () => {
    const { lead } = compose(obs({ laneTriggers: fireLane(0) }), PARAMS);
    expect(lead.gate).toBe(1);
    expect(lead.freq).toBeGreaterThan(0);
  });

  test("farther lane taps play higher arp notes", () => {
    const near = compose(obs({ laneTriggers: fireLane(0) }), PARAMS).lead.freq;
    const far = compose(obs({ laneTriggers: fireLane(3) }), PARAMS).lead.freq;
    expect(far).toBeGreaterThan(near);
  });

  test("arp frequency is always a positive in-scale pitch", () => {
    for (const scale of SCALE_NAMES) {
      for (let step = 0; step < 32; step++) {
        const { lead } = compose(
          obs({ step, laneTriggers: fireLane(step % 5) }),
          {
            root: 220,
            scale,
          },
        );
        expect(lead.freq).toBeGreaterThan(0);
      }
    }
  });
});

describe("compose — mallet ensemble (poly lanes)", () => {
  test("one mallet voice per lane tap, gated by its arrival", () => {
    const { mallets } = compose(obs({ laneTriggers: fireLane(2) }), PARAMS);
    expect(mallets).toHaveLength(5);
    expect(mallets[2].gate).toBe(1);
    expect(mallets.filter((m) => m.gate === 1)).toHaveLength(1);
    for (const m of mallets) expect(m.freq).toBeGreaterThan(0);
  });

  test("mallet pitches climb with lane index", () => {
    const { mallets } = compose(obs({ laneTriggers: fireLane(0) }), PARAMS);
    for (let i = 1; i < mallets.length; i++)
      expect(mallets[i].freq).toBeGreaterThan(mallets[i - 1].freq);
  });

  test("no arrivals = no mallet voices sounding", () => {
    const { mallets } = compose(obs({ laneTriggers: [] }), PARAMS);
    expect(mallets.every((m) => m.gate === 0)).toBe(true);
  });
});

describe("compose — keys + rim", () => {
  test("keys stab on the off-beats, silent on the beat", () => {
    const gates = Array.from(
      { length: 16 },
      (_, step) => compose(obs({ step }), PARAMS).keysGate,
    );
    expect(gates).toEqual([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  test("rim ghost note on the syncopated step", () => {
    const gates = Array.from(
      { length: 16 },
      (_, step) => compose(obs({ step }), PARAMS).rim,
    );
    expect(gates).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe("compose — sub-bass layer", () => {
  test("bass sits well below the chord root and is in-scale", () => {
    const { bass, chord } = compose(obs({ step: 0 }), PARAMS);
    expect(bass.freq).toBeGreaterThan(0);
    expect(bass.freq).toBeLessThan(chord[0]);
  });

  test("the inhibit gate bit enables the bass", () => {
    const on = Array.from(
      { length: 16 },
      (_, step) => compose(obs({ step, gateHigh: true }), PARAMS).bass.gate,
    );
    const off = Array.from(
      { length: 16 },
      (_, step) => compose(obs({ step, gateHigh: false }), PARAMS).bass.gate,
    );
    expect(on).toContain(1);
    expect(on[0]).toBe(1); // downbeat plays when enabled
    expect(off.every((g) => g === 0)).toBe(true);
  });
});

describe("compose — filter cutoff", () => {
  test("cutoff stays in 0..1 and opens with activity", () => {
    const calm = compose(obs({ activity: 0 }), PARAMS).cutoff;
    const busy = compose(obs({ activity: 1, population: 1 }), PARAMS).cutoff;
    expect(calm).toBeGreaterThanOrEqual(0);
    expect(busy).toBeLessThanOrEqual(1);
    expect(busy).toBeGreaterThan(calm);
  });
});

test("STEP_GENS is a positive integer", () => {
  expect(Number.isInteger(STEP_GENS)).toBe(true);
  expect(STEP_GENS).toBeGreaterThan(0);
});
