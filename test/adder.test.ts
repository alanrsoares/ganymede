import { describe, expect, test } from "bun:test";
import { createFullAdder } from "../src/components/full-adder";
import { createHalfAdder } from "../src/components/half-adder";
import type { Polarity, Pulse } from "../src/domain/pulses";

describe("Turing Completeness - Adder", () => {
  test("Half Adder should correctly sum binary inputs", () => {
    const ha = createHalfAdder("ha1");
    const state: any = { xorState: {}, andState: {} };

    const testCases = [
      { in: [0, 0], expectedSum: 0, expectedCarry: 0 },
      { in: [0, 1], expectedSum: 1, expectedCarry: 0 },
      { in: [1, 0], expectedSum: 1, expectedCarry: 0 },
      { in: [1, 1], expectedSum: 0, expectedCarry: 1 },
    ];

    for (const { in: inputsVal, expectedSum, expectedCarry } of testCases) {
      const inputs: Pulse[] = inputsVal.map((v, i) => ({
        timestamp: 10,
        polarity: v as Polarity,
        channelId: `in${i}`,
      }));

      const res = ha.transition(10, state, inputs);
      expect(res._tag).toBe("Ok");
      if (res._tag === "Ok") {
        const outputs = res.value[1];
        expect(outputs.find((p) => p.channelId === "sum-ha1")?.polarity).toBe(
          expectedSum,
        );
        expect(outputs.find((p) => p.channelId === "carry-ha1")?.polarity).toBe(
          expectedCarry,
        );
      }
    }
  });
});

describe("Turing Completeness - Full Adder", () => {
  test("Full Adder should correctly sum three binary inputs", () => {
    const fa = createFullAdder("fa1");
    const state: any = { ha1State: {}, ha2State: {}, orState: {} };

    const testCases = [
      { in: [0, 0, 0], expectedSum: 0, expectedCarry: 0 },
      { in: [0, 0, 1], expectedSum: 1, expectedCarry: 0 },
      { in: [0, 1, 0], expectedSum: 1, expectedCarry: 0 },
      { in: [0, 1, 1], expectedSum: 0, expectedCarry: 1 },
      { in: [1, 0, 0], expectedSum: 1, expectedCarry: 0 },
      { in: [1, 0, 1], expectedSum: 0, expectedCarry: 1 },
      { in: [1, 1, 0], expectedSum: 0, expectedCarry: 1 },
      { in: [1, 1, 1], expectedSum: 1, expectedCarry: 1 },
    ];

    for (const { in: inputsVal, expectedSum, expectedCarry } of testCases) {
      const inputs: Pulse[] = inputsVal.map((v, i) => ({
        timestamp: 10,
        polarity: v as Polarity,
        channelId: `in${i}`,
      }));

      const res = fa.transition(10, state, inputs);
      expect(res._tag).toBe("Ok");
      if (res._tag === "Ok") {
        const outputs = res.value[1];
        expect(outputs.find((p) => p.channelId === "sum-fa1")?.polarity).toBe(
          expectedSum,
        );
        expect(outputs.find((p) => p.channelId === "carry-fa1")?.polarity).toBe(
          expectedCarry,
        );
      }
    }
  });
});
