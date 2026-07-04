import { unwrapOk } from "@onrails/result";
import { createClock } from "~/components/clock";
import { createNotGate } from "~/components/not-gate";
import { createSRAM, type SRAMState } from "~/components/sram";
import { createWire } from "~/components/wire";
import {
  type CircuitConfig,
  type CircuitState,
  type Connection,
  step,
} from "~/domain/circuit";
import type { Polarity } from "~/domain/pulses";

export interface NodeView {
  readonly id: string;
  readonly kind: "clock" | "wire" | "not" | "sram";
  readonly x: number; // normalized 0..1
  readonly y: number;
  readonly label: string;
}

export interface PulseView {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly t0: number; // tick emitted
  readonly t1: number; // tick delivered
  readonly polarity: Polarity;
}

export interface EdgeView {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

// Timings chosen so clock pulses land exactly on the NOT gate's sampling
// boundary: clk emits at 8k, wire adds 4, and (8k + 4) % 4 === 0.
export const nodes: NodeView[] = [
  { id: "clk", kind: "clock", x: 0.1, y: 0.5, label: "CLK ·8" },
  { id: "w1", kind: "wire", x: 0.3, y: 0.5, label: "WIRE ·4" },
  { id: "not1", kind: "not", x: 0.5, y: 0.5, label: "NOT ·4" },
  { id: "w2", kind: "wire", x: 0.7, y: 0.5, label: "WIRE ·4" },
  { id: "sram1", kind: "sram", x: 0.9, y: 0.5, label: "SRAM" },
];

const nodeById = new Map(nodes.map((n) => [n.id, n]));

const connections: Connection[] = [
  { fromId: "clk", fromChannel: "out", toId: "w1", toPort: "in" },
  { fromId: "w1", fromChannel: "out", toId: "not1", toPort: "in" },
  { fromId: "not1", fromChannel: "out", toId: "w2", toPort: "in" },
  { fromId: "w2", fromChannel: "out", toId: "sram1", toPort: "in" },
];

export const edges: EdgeView[] = connections.flatMap((c) => {
  const from = nodeById.get(c.fromId);
  const to = nodeById.get(c.toId);
  return from && to
    ? [{ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }]
    : [];
});

const config: CircuitConfig = {
  components: [
    createClock("clk"),
    createWire("w1"),
    createNotGate("not1"),
    createWire("w2"),
    createSRAM("sram1"),
  ],
  connections,
};

export interface Simulation {
  /** Steps the circuit up to floor(simTime) ticks; prunes expired pulses. */
  advance(simTime: number): void;
  readonly tick: () => number;
  readonly sramValue: () => Polarity;
  readonly pulses: () => readonly PulseView[];
  readonly lastEmitTick: (id: string) => number;
}

export const createSimulation = (): Simulation => {
  let state: CircuitState = {
    componentStates: new Map<string, unknown>([
      ["clk", { period: 8, lastPulse: 0 }],
      ["w1", { length: 4 }],
      ["not1", { period: 4 }],
      ["w2", { length: 4 }],
      ["sram1", { value: 0 }],
    ]),
    inFlightPulses: [],
    currentTick: 0,
  };

  let pulseViews: PulseView[] = [];
  const lastEmit = new Map<string, number>();

  const runStep = () => {
    const tick = state.currentTick;
    const { nextState, emittedPulses } = unwrapOk(step(config, state));
    state = nextState;

    for (const pulse of emittedPulses) {
      const connection = connections.find(
        (c) => pulse.channelId === `${c.fromChannel}-${c.fromId}`,
      );
      if (!connection) continue;

      const from = nodeById.get(connection.fromId);
      const to = nodeById.get(connection.toId);
      if (!from || !to) continue;

      lastEmit.set(connection.fromId, tick);
      pulseViews.push({
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        t0: tick,
        // Delivery happens on the first step where timestamp <= tick.
        t1: Math.max(pulse.timestamp, tick + 1),
        polarity: pulse.polarity,
      });
    }
  };

  return {
    advance: (simTime) => {
      while (state.currentTick <= Math.floor(simTime)) {
        runStep();
      }
      pulseViews = pulseViews.filter((p) => p.t1 >= simTime - 0.25);
    },
    tick: () => state.currentTick,
    sramValue: () => {
      // Heterogeneous state map; sram1 is registered with SRAMState above.
      const sram = state.componentStates.get("sram1") as SRAMState;
      return sram.value;
    },
    pulses: () => pulseViews,
    lastEmitTick: (id) => lastEmit.get(id) ?? Number.NEGATIVE_INFINITY,
  };
};
