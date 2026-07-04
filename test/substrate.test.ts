import { describe, expect, test } from "bun:test";
import { unwrapOk } from "@onrails/result";
import { createClock } from "~/components/clock";
import { createWire } from "~/components/wire";
import { type CircuitConfig, type CircuitState, step } from "~/domain/circuit";
import { aliveCells, createGrid, population, stepGrid } from "~/domain/gol";
import {
  createEdgeDetector,
  createGunClock,
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
