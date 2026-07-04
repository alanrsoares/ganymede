import { describe, expect, test } from "bun:test";
import { createAndGate } from "../src/components/and-gate";
import { createClock } from "../src/components/clock";
import { createNotGate } from "../src/components/not-gate";
import { createSRAM } from "../src/components/sram";
import { createWire } from "../src/components/wire";
import type { Polarity, Pulse } from "../src/domain/pulses";

describe("GoL Computer Components", () => {
  test("Wire should delay pulses", () => {
    const wire = createWire("w1", 10);
    const state = { length: 10 };
    const inputs: Pulse[] = [
      { timestamp: 5, polarity: 1 as Polarity, channelId: "in" },
    ];

    const result = wire.transition(0, state, inputs);
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value[1][0].timestamp).toBe(15);
    }
  });

  test("AND gate should trigger on simultaneous pulses", () => {
    const gate = createAndGate("g1");
    const state = { arrivalWindow: 2 };
    const inputs: Pulse[] = [
      { timestamp: 10, polarity: 1 as Polarity, channelId: "in1" },
      { timestamp: 11, polarity: 1 as Polarity, channelId: "in2" },
    ];

    const result = gate.transition(0, state, inputs);
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value[1].length).toBe(1);
      expect(result.value[1][0].polarity).toBe(1);
    }
  });

  test("AND gate should fail on timing mismatch", () => {
    const gate = createAndGate("g1");
    const state = { arrivalWindow: 2 };
    const inputs: Pulse[] = [
      { timestamp: 10, polarity: 1 as Polarity, channelId: "in1" },
      { timestamp: 20, polarity: 1 as Polarity, channelId: "in2" },
    ];

    const result = gate.transition(0, state, inputs);
    expect(result._tag).toBe("Err");
  });

  test("NOT gate should invert pulses based on clock", () => {
    const gate = createNotGate("not1");
    const state = { clockTick: 10 };

    // Case 1: Presence input -> Absence output
    const inputsPresence: Pulse[] = [
      { timestamp: 10, polarity: 1 as Polarity, channelId: "in" },
    ];
    const res1 = gate.transition(10, state, inputsPresence);
    expect(res1._tag).toBe("Ok");
    if (res1._tag === "Ok") {
      expect(res1.value[1][0].polarity).toBe(0);
    }

    // Case 2: Absence input -> Presence output
    const inputsAbsence: Pulse[] = [
      { timestamp: 10, polarity: 0 as Polarity, channelId: "in" },
    ];
    const res2 = gate.transition(10, state, inputsAbsence);
    expect(res2._tag).toBe("Ok");
    if (res2._tag === "Ok") {
      expect(res2.value[1][0].polarity).toBe(1);
    }
  });

  test("Clock should pulse regularly", () => {
    const clock = createClock("clk1", 10);
    let state = { lastPulse: 0, period: 10 };

    // First tick (t=0) -> no output
    const res1 = clock.transition(0, state, []);
    expect(res1._tag).toBe("Ok");
    if (res1._tag === "Ok") {
      state = res1.value[0];
    }

    // Tick t=10 -> output!
    const res2 = clock.transition(10, state, []);
    expect(res2._tag).toBe("Ok");
    if (res2._tag === "Ok") {
      expect(res2.value[1][0].timestamp).toBe(10);
      state = res2.value[0];
    }
  });

  test("SRAM should store and flip values", () => {
    const sram = createSRAM("mem1");
    let state: any = { value: 0 };

    // Initial read (empty)
    const res1 = sram.transition(0, state, []);
    expect(res1._tag).toBe("Ok");
    if (res1._tag === "Ok") {
      expect(res1.value[1][0].polarity).toBe(0);
      state = res1.value[0];
    }

    // Write Presence
    const writePulse: Pulse[] = [
      { timestamp: 10, polarity: 1 as Polarity, channelId: "in" },
    ];
    const res2 = sram.transition(0, state, writePulse);
    expect(res2._tag).toBe("Ok");
    if (res2._tag === "Ok") {
      expect(res2.value[1][0].polarity).toBe(1);
      state = res2.value[0];
    }

    // Read back (should still be Presence)
    const res3 = sram.transition(0, state, []);
    expect(res3._tag).toBe("Ok");
    if (res3._tag === "Ok") {
      expect(res3.value[1][0].polarity).toBe(1);
    }

    // Write Presence again -> should flip to Absence
    const res4 = sram.transition(0, state, writePulse);
    expect(res4._tag).toBe("Ok");
    if (res4._tag === "Ok") {
      expect(res4.value[1][0].polarity).toBe(0);
    }
  });
});
