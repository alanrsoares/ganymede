import { describe, expect, test } from "bun:test";
import { unwrapOk } from "@onrails/result";
import { createClock } from "../src/components/clock";
import { createNotGate } from "../src/components/not-gate";
import { createWire } from "../src/components/wire";
import {
  type CircuitConfig,
  type CircuitState,
  step,
} from "../src/domain/circuit";
import type { Pulse } from "../src/domain/pulses";

describe("Circuit Orchestration", () => {
  test("Pulse should propagate from Clock -> Wire -> NOT Gate", () => {
    const clock = createClock("clk");
    const wire = createWire("w1");
    const notGate = createNotGate("not1");

    const config: CircuitConfig = {
      components: [clock, wire, notGate],
      connections: [
        { fromId: "clk", fromChannel: "out", toId: "w1" },
        { fromId: "w1", fromChannel: "out", toId: "not1" },
      ],
    };

    let state: CircuitState = {
      componentStates: new Map<string, unknown>([
        ["clk", { lastPulse: 0, period: 10 }],
        ["w1", { length: 5 }],
        ["not1", { period: 5 }],
      ]),
      inFlightPulses: [],
      currentTick: 0,
    };

    const allEmittedPulses: Pulse[] = [];

    for (let i = 0; i < 20; i++) {
      const { nextState, emittedPulses } = unwrapOk(step(config, state));
      allEmittedPulses.push(...emittedPulses);
      state = nextState;
    }

    const clockPulse = allEmittedPulses.find((p) => p.channelId === "out-clk");
    expect(clockPulse).toBeDefined();
    expect(clockPulse?.timestamp).toBe(10);

    const wirePulse = allEmittedPulses.find((p) => p.channelId === "out-w1");
    expect(wirePulse).toBeDefined();
    expect(wirePulse?.timestamp).toBe(15);

    const notPulse = allEmittedPulses.find(
      (p) => p.channelId === "out-not1" && p.timestamp === 15,
    );
    expect(notPulse).toBeDefined();
    expect(notPulse?.polarity).toBe(0);
  });
});
