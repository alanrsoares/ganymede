import { describe, expect, test } from "bun:test";
import { createClock } from "../src/components/clock";
import { createNotGate } from "../src/components/not-gate";
import { createWire } from "../src/components/wire";
import {
  type CircuitConfig,
  type CircuitState,
  Connection,
  step,
} from "../src/domain/circuit";

describe("Circuit Orchestration", () => {
  test("Pulse should propagate from Clock -> Wire -> NOT Gate", () => {
    const clock = createClock("clk", 10);
    const wire = createWire("w1", 5);
    const notGate = createNotGate("not1");

    const config: CircuitConfig<any> = {
      components: [clock, wire, notGate],
      connections: [
        { fromId: "clk", fromChannel: "out", toId: "w1" },
        { fromId: "w1", fromChannel: "out", toId: "not1" },
      ],
    };

    let state: CircuitState = {
      componentStates: new Map([
        ["clk", { lastPulse: 0, period: 10 }],
        ["w1", { length: 5 }],
        ["not1", { clockTick: 0 }],
      ]),
      inFlightPulses: [],
      currentTick: 0,
    };

    const allEmittedPulses: any[] = [];

    for (let i = 0; i < 20; i++) {
      state.componentStates.set("not1", { clockTick: state.currentTick });

      const res = step(config, state);
      expect(res._tag).toBe("Ok");
      if (res._tag === "Ok") {
        allEmittedPulses.push(...res.value.emittedPulses);
        state = res.value.nextState;
      }
    }

    console.log("Total Emitted Pulses:", allEmittedPulses);

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
