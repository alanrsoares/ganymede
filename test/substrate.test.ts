import { describe, expect, test } from "bun:test";
import { unwrapOk } from "@onrails/result";
import { createClock } from "~/components/clock";
import { createNotGate } from "~/components/not-gate";
import { createWire } from "~/components/wire";
import { type CircuitConfig, type CircuitState, step } from "~/domain/circuit";
import { aliveCells, createGrid, population, stepGrid } from "~/domain/gol";
import type { Polarity, Pulse } from "~/domain/pulses";
import {
  createEdgeDetector,
  createGliderInhibitGate,
  createGliderNotGate,
  createGunClock,
  type Detector,
  GLIDER_GENS_PER_CELL,
  GUN_PERIOD,
  runSubstrate,
} from "~/domain/substrate";

const NEAR_DISTANCE = 20;
const FAR_DISTANCE = 44;
const LANE_CELLS = FAR_DISTANCE - NEAR_DISTANCE;
const WIRE_DELAY = LANE_CELLS * GLIDER_GENS_PER_CELL; // 96 generations

const intervals = (xs: number[]): number[] =>
  xs.slice(1).map((x, i) => x - xs[i]);

/** Runs the CPU substrate and counts glider crossings through a detector. */
const countDetections = (
  seed: readonly (readonly [number, number])[],
  detector: Detector,
  generations: number,
  gridSize = 160,
): number => {
  let grid = createGrid(gridSize, gridSize, seed as [number, number][]);
  const edge = createEdgeDetector();
  let hits = 0;
  for (let gen = 1; gen <= generations; gen++) {
    grid = stepGrid(grid);
    let count = 0;
    for (let dy = 0; dy < detector.size; dy++) {
      const row = (detector.y + dy) * grid.width;
      for (let dx = 0; dx < detector.size; dx++) {
        count += grid.cells[row + detector.x + dx];
      }
    }
    if (edge.sample(count)) hits++;
  }
  return hits;
};

/** Runs the abstract circuit clk(period 30) -> wire(length 96) and returns
 *  the ticks at which the wire's output pulses are delivered. */
const circuitDeliveryTicks = (untilTick: number): number[] => {
  const config: CircuitConfig = {
    components: [createClock("clk"), createWire("w1")],
    connections: [
      { fromId: "clk", fromChannel: "out", toId: "w1", toPort: "in" },
      // Route the wire's output to a named sink so its pulses stay observable.
      { fromId: "w1", fromChannel: "out", toId: "sink", toPort: "in" },
    ],
  };

  let state: CircuitState = {
    componentStates: new Map<string, unknown>([
      ["clk", { period: GUN_PERIOD, lastPulse: 0 }],
      ["w1", { length: WIRE_DELAY }],
    ]),
    inFlightPulses: [],
    currentTick: 0,
  };

  const deliveries: number[] = [];
  for (let i = 0; i < untilTick; i++) {
    const { nextState, emittedPulses } = unwrapOk(step(config, state));
    state = nextState;
    for (const pulse of emittedPulses) {
      if (pulse.channelId === "out-w1") deliveries.push(pulse.timestamp);
    }
  }
  return deliveries;
};

describe("GoL substrate vs circuit oracle", () => {
  const gun = createGunClock(4, 4);
  const near = gun.laneDetector(NEAR_DISTANCE);
  const far = gun.laneDetector(FAR_DISTANCE);
  const [nearHits, farHits] = runSubstrate(gun.seed, 128, 128, 320, [
    near,
    far,
  ]);

  test("gun emits gliders with the clock component's period", () => {
    expect(nearHits.length).toBeGreaterThanOrEqual(5);
    for (const gap of intervals(nearHits)) {
      expect(gap).toBe(GUN_PERIOD);
    }
  });

  test("glider lane delay matches the wire component's delay model", () => {
    expect(farHits.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < farHits.length; i++) {
      expect(farHits[i] - nearHits[i]).toBe(WIRE_DELAY);
    }
  });

  test("lane eater absorbs the glider stream", () => {
    const eaten = [...gun.seed, ...gun.laneEater(36)];
    const detectorBeforeEater = gun.laneDetector(NEAR_DISTANCE);

    let grid = createGrid(128, 128, eaten);
    const pops: number[] = [];
    let escaped = false;
    const edge = createEdgeDetector();
    let hits = 0;

    for (let gen = 1; gen <= 480; gen++) {
      grid = stepGrid(grid);
      let count = 0;
      for (let dy = 0; dy < detectorBeforeEater.size; dy++) {
        for (let dx = 0; dx < detectorBeforeEater.size; dx++) {
          count +=
            grid.cells[
              (detectorBeforeEater.y + dy) * grid.width +
                detectorBeforeEater.x +
                dx
            ];
        }
      }
      if (edge.sample(count)) hits++;
      if (gen % 30 === 0) {
        pops.push(population(grid));
        escaped ||= aliveCells(grid).some(([x, y]) => x > 58 || y > 44);
      }
    }

    // Nothing gets past the eater...
    expect(escaped).toBe(false);
    // ...the whole system settles into a period-30 cycle...
    const tail = pops.slice(-3);
    expect(new Set(tail).size).toBe(1);
    // ...and the stream still flows upstream of the eater.
    expect(hits).toBeGreaterThanOrEqual(10);
  });

  test("substrate pulse train matches circuit sim modulo constant offset", () => {
    const deliveries = circuitDeliveryTicks(320);
    expect(deliveries.length).toBeGreaterThanOrEqual(3);

    // Same cadence...
    expect(intervals(deliveries).every((gap) => gap === GUN_PERIOD)).toBe(true);
    // ...and a single constant phase offset between substrate and sim.
    const shared = Math.min(deliveries.length, farHits.length);
    const offsets = Array.from(
      { length: shared },
      (_, i) => farHits[i] - deliveries[i],
    );
    expect(new Set(offsets).size).toBe(1);
  });
});

describe("glider inhibit gate (A AND NOT B)", () => {
  const gate = createGliderInhibitGate(4, 4);
  const GENS = 420;

  const substrateOut = (a: boolean, b: boolean): 0 | 1 =>
    countDetections(gate.seed(a, b), gate.output, GENS) > 0 ? 1 : 0;

  const cases: { a: boolean; b: boolean; out: 0 | 1 }[] = [
    { a: false, b: false, out: 0 },
    { a: false, b: true, out: 0 },
    { a: true, b: false, out: 1 },
    { a: true, b: true, out: 0 },
  ];

  test.each(cases)("A=$a B=$b -> $out (physical glider streams)", ({
    a,
    b,
    out,
  }) => {
    expect(substrateOut(a, b)).toBe(out);
    // The primitive is exactly boolean AND-NOT.
    expect(out).toBe(a && !b ? 1 : 0);
  });
});

describe("glider NOT gate vs component oracle", () => {
  const gate = createGliderNotGate(4, 4);
  const GENS = 420;

  const oracleOutput = (inputPolarity: Polarity): Polarity => {
    const not = createNotGate("not");
    // Sample on a period boundary so the gate emits.
    const input: Pulse[] = [
      { timestamp: 10, polarity: inputPolarity, channelId: "in" },
    ];
    const [, outputs] = unwrapOk(not.transition(10, { period: 10 }, input));
    return outputs[0].polarity;
  };

  test("NOT(0) = 1: control stream flows when input is absent", () => {
    const hits = countDetections(gate.seed(false), gate.output, GENS);
    expect(hits).toBeGreaterThan(0);
    expect(oracleOutput(0)).toBe(1);
  });

  test("NOT(1) = 0: input stream annihilates the output", () => {
    const hits = countDetections(gate.seed(true), gate.output, GENS);
    expect(hits).toBe(0);
    expect(oracleOutput(1)).toBe(0);
  });

  test("substrate truth table matches the NOT component", () => {
    const substrate = [false, true].map((high) =>
      countDetections(gate.seed(high), gate.output, GENS) > 0 ? 1 : 0,
    );
    const oracle = [0, 1].map((p) => oracleOutput(p as Polarity));
    expect(substrate).toEqual(oracle);
  });
});
