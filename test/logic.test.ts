import { describe, expect, test } from "bun:test";
import { unwrapOk } from "@onrails/result";
import { createAndGate } from "~/components/and-gate";
import {
  createFullAdder,
  initialFullAdderState,
} from "~/components/full-adder";
import {
  createHalfAdder,
  initialHalfAdderState,
} from "~/components/half-adder";
import { createOrGate } from "~/components/or-gate";
import { createXorGate } from "~/components/xor-gate";
import type { Component } from "~/domain/component";
import {
  and,
  type Bit,
  fullAdder,
  halfAdder,
  not,
  or,
  xor,
} from "~/domain/logic";
import type { Polarity, Pulse } from "~/domain/pulses";

const BITS: Bit[] = [0, 1];

const pulse = (polarity: Bit, channelId: string): Pulse => ({
  timestamp: 10,
  polarity: polarity as Polarity,
  channelId,
});

/** Drives a 2-input gate component and returns its output polarity as a Bit. */
const runGate = <S>(gate: Component<S>, state: S, a: Bit, b: Bit): Bit => {
  const [, outputs] = unwrapOk(
    gate.transition(10, state, [pulse(a, "in0"), pulse(b, "in1")]),
  );
  return outputs[0].polarity as Bit;
};

describe("inhibit-derived gates match the gate components", () => {
  test("AND", () => {
    const gate = createAndGate("and");
    for (const a of BITS)
      for (const b of BITS)
        expect(and(a, b)).toBe(runGate(gate, { arrivalWindow: 2 }, a, b));
  });

  test("OR", () => {
    const gate = createOrGate("or");
    for (const a of BITS)
      for (const b of BITS) expect(or(a, b)).toBe(runGate(gate, {}, a, b));
  });

  test("XOR", () => {
    const gate = createXorGate("xor");
    for (const a of BITS)
      for (const b of BITS) expect(xor(a, b)).toBe(runGate(gate, {}, a, b));
  });

  test("NOT matches a single-input inversion", () => {
    // XOR with a constant 1 inverts, so it doubles as a NOT reference.
    for (const a of BITS) expect(not(a)).toBe(xor(a, 1));
  });
});

describe("inhibit-derived adders match the adder components", () => {
  test("half adder", () => {
    const ha = createHalfAdder("ha");
    for (const a of BITS)
      for (const b of BITS) {
        const [, outputs] = unwrapOk(
          ha.transition(10, initialHalfAdderState, [
            pulse(a, "a"),
            pulse(b, "b"),
          ]),
        );
        const sum = outputs.find((p) => p.channelId === "sum-ha")?.polarity;
        const carry = outputs.find((p) => p.channelId === "carry-ha")?.polarity;
        expect({ sum, carry }).toEqual(halfAdder(a, b));
      }
  });

  test("full adder over all 8 inputs", () => {
    const fa = createFullAdder("fa");
    for (const a of BITS)
      for (const b of BITS)
        for (const cin of BITS) {
          const [, outputs] = unwrapOk(
            fa.transition(10, initialFullAdderState, [
              pulse(a, "a"),
              pulse(b, "b"),
              pulse(cin, "cin"),
            ]),
          );
          const sum = outputs.find((p) => p.channelId === "sum-fa")?.polarity;
          const carry = outputs.find(
            (p) => p.channelId === "carry-fa",
          )?.polarity;
          expect({ sum, carry }).toEqual(fullAdder(a, b, cin));
        }
  });
});
