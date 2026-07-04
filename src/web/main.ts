import { unwrapOk } from "@onrails/result";
import type { Cell } from "~/domain/gol";
import { createGrid, stepGrid } from "~/domain/gol";
import { GLIDER_RLE, parseRle, placePattern } from "~/domain/patterns";
import {
  countWindow,
  createEdgeDetector,
  createGliderInhibitGate,
  createGunClock,
  GLIDER_GENS_PER_CELL,
} from "~/domain/substrate";
import { createGolEngine } from "./gol-gpu";
import { createRenderer, FLOATS_PER_INSTANCE } from "./gpu";
import { acquireGpu } from "./gpu-context";
import { createSimulation, edges, type NodeView, nodes } from "./sim";

const TICKS_PER_SECOND = 3;
const GOL_GENERATIONS_PER_SECOND = 20;
const GRID_W = 480;
const GRID_H = 270;
const GUN_X = 6;
const GUN_Y = 6;
const NEAR_DISTANCE = 20;
const FAR_DISTANCE = 32;
const EATER_DISTANCE = 40;
const NOT_BASE_X = 40;
const NOT_BASE_Y = 150;
const EXPECTED_LANE_DELAY =
  (FAR_DISTANCE - NEAR_DISTANCE) * GLIDER_GENS_PER_CELL;
const PARITY_GENERATIONS = 120;

type Rgb = readonly [number, number, number];

const nodeColors: Record<NodeView["kind"], Rgb> = {
  clock: [0.95, 0.72, 0.25],
  wire: [0.45, 0.62, 0.68],
  not: [0.72, 0.5, 0.95],
  sram: [0.35, 0.9, 0.55],
};

const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
const status = document.getElementById("status") as HTMLElement;
const substrate = document.getElementById("substrate") as HTMLElement;
const notGateText = document.getElementById("notgate") as HTMLElement;
const labels = document.getElementById("labels") as HTMLElement;
const errorBox = document.getElementById("error") as HTMLElement;

for (const node of nodes) {
  const el = document.createElement("div");
  el.className = "label";
  el.textContent = node.label;
  el.style.left = `${node.x * 100}%`;
  el.style.top = `calc(${node.y * 100}% + 26px)`;
  labels.appendChild(el);
}

const instances = new Float32Array(256 * FLOATS_PER_INSTANCE);
let instanceCount = 0;

const pushInstance = (
  cx: number,
  cy: number,
  hx: number,
  hy: number,
  rot: number,
  shape: number,
  color: readonly [number, number, number, number],
) => {
  const base = instanceCount * FLOATS_PER_INSTANCE;
  instances.set([cx, cy, hx, hy, rot, shape, 0, 0, ...color], base);
  instanceCount++;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const main = async () => {
  const gpu = await acquireGpu(canvas);

  const glider = unwrapOk(parseRle(GLIDER_RLE));
  const gunClock = createGunClock(GUN_X, GUN_Y);
  const inhibitGate = createGliderInhibitGate(NOT_BASE_X, NOT_BASE_Y);

  // The scene: the clock/wire/eater lane plus a live glider inhibit gate
  // (A AND NOT B) whose inputs toggle to watch stream annihilation flip the
  // output. This gate is functionally complete, so it is the whole computer's
  // primitive; NOT is the A-always-on case.
  let inputA = true;
  let inputB = true;
  const buildScene = (a: boolean, b: boolean): Cell[] => [
    ...gunClock.seed,
    ...gunClock.laneEater(EATER_DISTANCE),
    ...inhibitGate.seed(a, b),
  ];
  const seed = buildScene(inputA, inputB);
  const engine = createGolEngine(gpu.device, GRID_W, GRID_H, seed);

  // GPU ≡ CPU parity: run both engines from the same seed and compare the
  // whole grid. The CPU reference is the tested oracle; a mismatch means the
  // compute shader diverged from real Game of Life.
  engine.step(PARITY_GENERATIONS);
  const gpuCells = await engine.readRegion(0, 0, GRID_W, GRID_H);
  let cpuGrid = createGrid(GRID_W, GRID_H, seed);
  for (let i = 0; i < PARITY_GENERATIONS; i++) cpuGrid = stepGrid(cpuGrid);
  let parityOk = true;
  for (let i = 0; i < gpuCells.length; i++) {
    if (gpuCells[i] !== cpuGrid.cells[i]) {
      parityOk = false;
      break;
    }
  }

  // Live detectors on the gun's glider lane (the Clock -> Wire substrate).
  const detectors = [
    gunClock.laneDetector(NEAR_DISTANCE),
    gunClock.laneDetector(FAR_DISTANCE),
  ];
  const edgeDetectors = detectors.map(() => createEdgeDetector());
  const detections: number[][] = detectors.map(() => []);
  const detectorFlash = detectors.map(() => 0);

  const sampleDetectors = () => {
    detectors.forEach((det, i) => {
      const gen = engine.generation();
      void engine.readRegion(det.x, det.y, det.size, det.size).then((cells) => {
        if (edgeDetectors[i].sample(countWindow(cells))) {
          detections[i].push(gen);
          detectorFlash[i] = performance.now() + 400;
        }
      });
    });
  };

  // NOT gate output: edge-detect the control lane past the crossing, and
  // report whether the output is flowing (high) over a recent window.
  const gateOut = inhibitGate.output;
  let gateOutEdge = createEdgeDetector();
  let gateOutFlash = 0;

  const sampleGate = () => {
    void engine
      .readRegion(gateOut.x, gateOut.y, gateOut.size, gateOut.size)
      .then((cells) => {
        if (gateOutEdge.sample(countWindow(cells))) {
          gateOutFlash = performance.now() + 400;
        }
      });
  };

  const rebuildGate = () => {
    engine.reset(buildScene(inputA, inputB));
    gateOutEdge = createEdgeDetector();
  };

  const renderer = createRenderer(gpu, canvas, engine);
  const sim = createSimulation();

  window.addEventListener("resize", () => renderer.resize());

  // Click drops a glider at the cursor.
  canvas.addEventListener("pointerdown", (e) => {
    const cx = Math.floor((e.clientX / canvas.clientWidth) * GRID_W);
    const cy = Math.floor((e.clientY / canvas.clientHeight) * GRID_H);
    engine.inject(placePattern(glider, cx, cy));
  });

  // Press "a"/"b" to toggle the inhibit gate's input streams.
  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (key === "a") {
      inputA = !inputA;
      rebuildGate();
    } else if (key === "b") {
      inputB = !inputB;
      rebuildGate();
    }
  });

  // Population readback once a second — exercises the same readRegion path
  // the circuit substrate will use as its output detector.
  let populationText = "";
  const samplePopulation = async () => {
    const cells = await engine.readRegion(0, 0, GRID_W, GRID_H);
    let count = 0;
    for (const c of cells) count += c;
    populationText = ` — gol gen ${engine.generation()}, pop ${count}`;
  };
  setInterval(() => void samplePopulation(), 1000);

  let simTime = 0;
  let golAccumulator = 0;
  let lastFrame = performance.now();

  const frame = (now: number) => {
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;

    simTime += dt * TICKS_PER_SECOND;
    sim.advance(simTime);

    golAccumulator += dt * GOL_GENERATIONS_PER_SECOND;
    const golSteps = Math.floor(golAccumulator);
    if (golSteps > 0) {
      engine.step(golSteps);
      golAccumulator -= golSteps;
      sampleDetectors();
      sampleGate();
    }

    const w = canvas.width;
    const h = canvas.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    instanceCount = 0;

    // Connection lines
    for (const edge of edges) {
      const x0 = edge.fromX * w;
      const y0 = edge.fromY * h;
      const x1 = edge.toX * w;
      const y1 = edge.toY * h;
      const len = Math.hypot(x1 - x0, y1 - y0);
      pushInstance(
        (x0 + x1) / 2,
        (y0 + y1) / 2,
        len / 2,
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
      pushInstance(node.x * w, node.y * h, size, size, 0, 0, [
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
        pushInstance(x, y, 7 * dpr, 7 * dpr, 0, 1, [0.4, 1.0, 0.85, 0.95]);
      } else {
        pushInstance(x, y, 5 * dpr, 5 * dpr, 0, 1, [0.4, 0.45, 0.6, 0.6]);
      }
    }

    // Detector windows on the glider lane, flashing when a glider crosses
    const cellPx = w / GRID_W;
    const cellPy = h / GRID_H;
    detectors.forEach((det, i) => {
      const flash = now < detectorFlash[i] ? 0.45 : 0;
      pushInstance(
        (det.x + det.size / 2) * cellPx,
        (det.y + det.size / 2) * cellPy,
        (det.size / 2) * cellPx,
        (det.size / 2) * cellPy,
        0,
        0,
        [0.95, 0.72, 0.25, 0.18 + flash],
      );
    });

    // Inhibit gate output detector: green when flowing, dim red when dark
    const gateFlowing = now - gateOutFlash < 1200;
    const gateFlash = now < gateOutFlash ? 0.4 : 0;
    pushInstance(
      (gateOut.x + gateOut.size / 2) * cellPx,
      (gateOut.y + gateOut.size / 2) * cellPy,
      (gateOut.size / 2) * cellPx,
      (gateOut.size / 2) * cellPy,
      0,
      0,
      gateFlowing
        ? [0.35, 0.9, 0.55, 0.25 + gateFlash]
        : [0.85, 0.35, 0.35, 0.22],
    );

    renderer.render(instances, instanceCount, now / 1000);

    const [nearHits, farHits] = detections;
    const shared = Math.min(nearHits.length, farHits.length);
    const laneDelay =
      shared > 0 ? farHits[shared - 1] - nearHits[shared - 1] : null;
    substrate.textContent =
      `substrate: gpu≡cpu ${parityOk ? "✓" : "✗ DIVERGED"} (${PARITY_GENERATIONS} gens)` +
      ` — lane gliders: near ${nearHits.length}, far ${farHits.length}` +
      (laneDelay !== null
        ? `, delay ${laneDelay} gens (wire model: ${EXPECTED_LANE_DELAY})`
        : "");
    const gateOut01 = gateFlowing ? 1 : 0;
    notGateText.textContent =
      `inhibit gate A∧¬B (keys "a"/"b"): A=${inputA ? 1 : 0} B=${inputB ? 1 : 0}` +
      ` → out ${gateOut01} — functionally complete: every gate + the adder derive from this`;
    status.textContent = `tick ${sim.tick()} — sram bit: ${sim.sramValue()}${populationText}`;
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
};

main().catch((e: unknown) => {
  errorBox.style.display = "grid";
  errorBox.textContent =
    e instanceof Error
      ? `${e.message} — try Chrome/Edge 113+, or Safari 18+ with WebGPU enabled.`
      : String(e);
});
