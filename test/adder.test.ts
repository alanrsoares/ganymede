import { describe, expect, test } from "bun:test";
import { unwrapOk } from "@onrails/result";
import {
  createFullAdder,
  initialFullAdderState,
} from "../src/components/full-adder";
import {
  createHalfAdder,
  initialHalfAdderState,
} from "../src/components/half-adder";
import type { Polarity, Pulse } from "../src/domain/pulses";

interface AdderCase {
  readonly in: Polarity[];
  readonly expectedSum: Polarity;
  readonly expectedCarry: Polarity;
}

const toPulses = (values: Polarity[], tick: number): Pulse[] =>
  values.map((polarity, i) => ({
    timestamp: tick,
    polarity,
    channelId: `in${i}`,
  }));

describe("Half Adder", () => {
  const cases: AdderCase[] = [
    { in: [0, 0], expectedSum: 0, expectedCarry: 0 },
    { in: [0, 1], expectedSum: 1, expectedCarry: 0 },
    { in: [1, 0], expectedSum: 1, expectedCarry: 0 },
    { in: [1, 1], expectedSum: 0, expectedCarry: 1 },
  ];

  test.each(cases)("sums %j", ({
    in: inputsVal,
    expectedSum,
    expectedCarry,
  }) => {
    const ha = createHalfAdder("ha1");

    const [, outputs] = unwrapOk(
      ha.transition(10, initialHalfAdderState, toPulses(inputsVal, 10)),
    );
    expect(outputs.find((p) => p.channelId === "sum-ha1")?.polarity).toBe(
      expectedSum,
    );
    expect(outputs.find((p) => p.channelId === "carry-ha1")?.polarity).toBe(
      expectedCarry,
    );
  });
});

describe("Full Adder", () => {
  const cases: AdderCase[] = [
    { in: [0, 0, 0], expectedSum: 0, expectedCarry: 0 },
    { in: [0, 0, 1], expectedSum: 1, expectedCarry: 0 },
    { in: [0, 1, 0], expectedSum: 1, expectedCarry: 0 },
    { in: [0, 1, 1], expectedSum: 0, expectedCarry: 1 },
    { in: [1, 0, 0], expectedSum: 1, expectedCarry: 0 },
    { in: [1, 0, 1], expectedSum: 0, expectedCarry: 1 },
    { in: [1, 1, 0], expectedSum: 0, expectedCarry: 1 },
    { in: [1, 1, 1], expectedSum: 1, expectedCarry: 1 },
  ];

  test.each(cases)("sums %j", ({
    in: inputsVal,
    expectedSum,
    expectedCarry,
  }) => {
    const fa = createFullAdder("fa1");

    const [, outputs] = unwrapOk(
      fa.transition(10, initialFullAdderState, toPulses(inputsVal, 10)),
    );
    expect(outputs.find((p) => p.channelId === "sum-fa1")?.polarity).toBe(
      expectedSum,
    );
    expect(outputs.find((p) => p.channelId === "carry-fa1")?.polarity).toBe(
      expectedCarry,
    );
  });
});
