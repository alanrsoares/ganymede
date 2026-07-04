import { describe, expect, test } from "bun:test";
import { unwrapErr, unwrapOk } from "@onrails/result";
import { createAndGate } from "../src/components/and-gate";
import { createClock } from "../src/components/clock";
import { createNotGate } from "../src/components/not-gate";
import { createSRAM, type SRAMState } from "../src/components/sram";
import { createWire } from "../src/components/wire";
import type { Polarity, Pulse } from "../src/domain/pulses";

describe("GoL Computer Components", () => {
  test("Wire should delay pulses", () => {
    const wire = createWire("w1");
    const state = { length: 10 };
    const inputs: Pulse[] = [
      { timestamp: 5, polarity: 1 as Polarity, channelId: "in" },
    ];

    const [, outputs] = unwrapOk(wire.transition(0, state, inputs));
    expect(outputs[0].timestamp).toBe(15);
  });

  test("AND gate should trigger on simultaneous pulses", () => {
    const gate = createAndGate("g1");
    const state = { arrivalWindow: 2 };
    const inputs: Pulse[] = [
      { timestamp: 10, polarity: 1 as Polarity, channelId: "in1" },
      { timestamp: 11, polarity: 1 as Polarity, channelId: "in2" },
    ];

    const [, outputs] = unwrapOk(gate.transition(0, state, inputs));
    expect(outputs.length).toBe(1);
    expect(outputs[0].polarity).toBe(1);
  });

  test("AND gate should fail on timing mismatch", () => {
    const gate = createAndGate("g1");
    const state = { arrivalWindow: 2 };
    const inputs: Pulse[] = [
      { timestamp: 10, polarity: 1 as Polarity, channelId: "in1" },
      { timestamp: 20, polarity: 1 as Polarity, channelId: "in2" },
    ];

    const error = unwrapErr(gate.transition(0, state, inputs));
    expect(error._tag).toBe("Collision");
  });

  test("NOT gate should invert pulses on its sampling period", () => {
    const gate = createNotGate("not1");
    const state = { period: 10 };

    // Case 1: Presence input -> Absence output
    const inputsPresence: Pulse[] = [
      { timestamp: 10, polarity: 1 as Polarity, channelId: "in" },
    ];
    const [, outPresence] = unwrapOk(
      gate.transition(10, state, inputsPresence),
    );
    expect(outPresence[0].polarity).toBe(0);

    // Case 2: Absence input -> Presence output
    const inputsAbsence: Pulse[] = [
      { timestamp: 10, polarity: 0 as Polarity, channelId: "in" },
    ];
    const [, outAbsence] = unwrapOk(gate.transition(10, state, inputsAbsence));
    expect(outAbsence[0].polarity).toBe(1);

    // Case 3: Off the sampling period -> no output
    const [, outOffPeriod] = unwrapOk(
      gate.transition(7, state, inputsPresence),
    );
    expect(outOffPeriod.length).toBe(0);
  });

  test("Clock should pulse regularly", () => {
    const clock = createClock("clk1");
    let state = { lastPulse: 0, period: 10 };

    // First tick (t=0) -> no output
    const [stateAfterT0, outT0] = unwrapOk(clock.transition(0, state, []));
    expect(outT0.length).toBe(0);
    state = stateAfterT0;

    // Tick t=10 -> output!
    const [, outT10] = unwrapOk(clock.transition(10, state, []));
    expect(outT10[0].timestamp).toBe(10);
  });

  test("SRAM should store and flip values", () => {
    const sram = createSRAM("mem1");
    let state: SRAMState = { value: 0 };

    // Initial read (empty)
    const [stateAfterRead, outRead] = unwrapOk(sram.transition(0, state, []));
    expect(outRead[0].polarity).toBe(0);
    state = stateAfterRead;

    // Write Presence
    const writePulse: Pulse[] = [
      { timestamp: 10, polarity: 1 as Polarity, channelId: "in" },
    ];
    const [stateAfterWrite, outWrite] = unwrapOk(
      sram.transition(0, state, writePulse),
    );
    expect(outWrite[0].polarity).toBe(1);
    state = stateAfterWrite;

    // Read back (should still be Presence)
    const [, outReadBack] = unwrapOk(sram.transition(0, state, []));
    expect(outReadBack[0].polarity).toBe(1);

    // Write Presence again -> should flip to Absence
    const [, outFlip] = unwrapOk(sram.transition(0, state, writePulse));
    expect(outFlip[0].polarity).toBe(0);
  });
});
