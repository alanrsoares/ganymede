// Builds the overlay instance buffer drawn on top of the GoL background: the
// abstract spec circuit (connection lines, component nodes, in-flight pulses)
// and the substrate markers (lane detectors, routing outputs, gate output).
// Pure presentation — it reads the sim and scene and emits sprite instances;
// gpu.ts turns them into draw calls.

import { FLOATS_PER_INSTANCE } from "./gpu";
import type { Scene } from "./scene";
import { edges, type NodeView, nodes, type Simulation } from "./sim";

const MAX_INSTANCES = 256;

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

const nodeColors: Record<NodeView["kind"], Rgb> = {
  clock: [0.95, 0.72, 0.25],
  wire: [0.45, 0.62, 0.68],
  not: [0.72, 0.5, 0.95],
  sram: [0.35, 0.9, 0.55],
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface OverlayFrame {
  w: number;
  h: number;
  dpr: number;
  gridW: number;
  gridH: number;
  simTime: number;
  now: number;
  sim: Simulation;
  scene: Scene;
  gateFlowing: boolean;
  andFlowing: boolean;
}

export interface Overlay {
  build(frame: OverlayFrame): {
    instances: Float32Array<ArrayBuffer>;
    count: number;
  };
}

export const createOverlay = (): Overlay => {
  const instances = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  let count = 0;

  const push = (
    cx: number,
    cy: number,
    hx: number,
    hy: number,
    rot: number,
    shape: number,
    color: Rgba,
  ) => {
    instances.set(
      [cx, cy, hx, hy, rot, shape, 0, 0, ...color],
      count * FLOATS_PER_INSTANCE,
    );
    count++;
  };

  return {
    build: ({
      w,
      h,
      dpr,
      gridW,
      gridH,
      simTime,
      now,
      sim,
      scene,
      gateFlowing,
      andFlowing,
    }) => {
      count = 0;
      const cellPx = w / gridW;
      const cellPy = h / gridH;

      const marker = (
        det: { x: number; y: number; size: number },
        color: Rgba,
      ) =>
        push(
          (det.x + det.size / 2) * cellPx,
          (det.y + det.size / 2) * cellPy,
          (det.size / 2) * cellPx,
          (det.size / 2) * cellPy,
          0,
          0,
          color,
        );

      // Connection lines (abstract spec circuit)
      for (const edge of edges) {
        const x0 = edge.fromX * w;
        const y0 = edge.fromY * h;
        const x1 = edge.toX * w;
        const y1 = edge.toY * h;
        push(
          (x0 + x1) / 2,
          (y0 + y1) / 2,
          Math.hypot(x1 - x0, y1 - y0) / 2,
          1 * dpr,
          Math.atan2(y1 - y0, x1 - x0),
          0,
          [0.2, 0.5, 0.45, 0.35],
        );
      }

      // Component nodes: flash briefly after emitting
      for (const node of nodes) {
        const flash = clamp01(1 - (simTime - sim.lastEmitTick(node.id)) / 1.5);
        const [r, g, b] =
          node.kind === "sram" && sim.sramValue() === 0
            ? ([0.4, 0.45, 0.5] as const)
            : nodeColors[node.kind];
        const lift = 0.25 * flash;
        const size = (13 + 3 * flash) * dpr;
        push(node.x * w, node.y * h, size, size, 0, 0, [
          Math.min(1, r + lift),
          Math.min(1, g + lift),
          Math.min(1, b + lift),
          0.95,
        ]);
      }

      // In-flight pulses, interpolated between emit and delivery ticks
      for (const pulse of sim.pulses()) {
        const f = clamp01((simTime - pulse.t0) / (pulse.t1 - pulse.t0));
        const x = (pulse.fromX + (pulse.toX - pulse.fromX) * f) * w;
        const y = (pulse.fromY + (pulse.toY - pulse.fromY) * f) * h;
        if (pulse.polarity === 1) {
          push(x, y, 7 * dpr, 7 * dpr, 0, 1, [0.4, 1.0, 0.85, 0.95]);
        } else {
          push(x, y, 5 * dpr, 5 * dpr, 0, 1, [0.4, 0.45, 0.6, 0.6]);
        }
      }

      // Lane detector windows (amber), flashing when a glider crosses
      for (const { det, flashUntil } of scene.detectorViews()) {
        marker(det, [0.95, 0.72, 0.25, 0.18 + (now < flashUntil ? 0.45 : 0)]);
      }

      // Inhibit gate output: green when flowing, dim red when dark
      const gate = scene.gateView();
      const gateFlash = now < gate.flashUntil ? 0.4 : 0;
      marker(
        gate.det,
        gateFlowing
          ? [0.35, 0.9, 0.55, 0.25 + gateFlash]
          : [0.85, 0.35, 0.35, 0.22],
      );

      // Physical AND gate output: same green/red convention
      const andGate = scene.andView();
      const andFlash = now < andGate.flashUntil ? 0.4 : 0;
      marker(
        andGate.det,
        andFlowing
          ? [0.35, 0.9, 0.55, 0.25 + andFlash]
          : [0.85, 0.35, 0.35, 0.22],
      );

      return { instances, count };
    },
  };
};
