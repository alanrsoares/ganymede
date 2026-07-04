import { unwrapOk } from "@onrails/result";
import type { Cell } from "~/domain/gol";
import { createGrid, stepGrid } from "~/domain/gol";
import {
  type CaObservations,
  compose,
  SCALE_NAMES,
  type ScaleName,
  STEP_GENS,
} from "~/domain/music";
import { GLIDER_RLE, parseRle, placePattern } from "~/domain/patterns";
import {
  countWindow,
  createDuplicator,
  createEdgeDetector,
  createGliderInhibitGate,
  createGunClock,
  createReflector,
  GLIDER_GENS_PER_CELL,
} from "~/domain/substrate";
import { createAutomataAudio } from "./audio";
import { createGolEngine } from "./gol-gpu";
import { createRenderer, FLOATS_PER_INSTANCE } from "./gpu";
import { acquireGpu } from "./gpu-context";
import { createSimulation, edges, type NodeView, nodes } from "./sim";
import { mountUi } from "./ui";

const TICKS_PER_SECOND = 3;
const GOL_GENERATIONS_PER_SECOND = 45;
const GRID_W = 480;
const GRID_H = 270;
const GUN_X = 6;
const GUN_Y = 6;
// Detector taps down the clock's glider lane — each is a pentatonic step, so
// the crossings play a generative arpeggio timed by the automaton itself.
const MUSIC_DISTANCES = [16, 21, 26, 31, 36];
const NEAR_DISTANCE = MUSIC_DISTANCES[0];
const FAR_DISTANCE = MUSIC_DISTANCES[MUSIC_DISTANCES.length - 1];
const EATER_DISTANCE = 40;
const NOT_BASE_X = 40;
const NOT_BASE_Y = 150;
// Routing showcase (step 1 primitives): a reflector turning a spaced glider
// stream 90 degrees, and a duplicator fanning one p30 stream into two.
const REFLECT_BASE_X = 320;
const REFLECT_BASE_Y = 30;
const REFLECT_INJECT_PERIOD = 64; // > Snark 43-gen recovery time
const DUP_BASE_X = 300;
const DUP_BASE_Y = 150;
const EXPECTED_LANE_DELAY =
  (FAR_DISTANCE - NEAR_DISTANCE) * GLIDER_GENS_PER_CELL;
const PARITY_GENERATIONS = 120;
const DEFAULT_SCALE = "minor pentatonic";

// Labels for the real GoL substrate, anchored at their actual grid cells.
const SUBSTRATE_LABELS = [
  { x: 24, y: 18, text: "CLK · Gosper gun" },
  { x: 60, y: 34, text: "WIRE · glider lane" },
  { x: 74, y: 48, text: "EATER" },
  { x: 58, y: 144, text: "A · carrier gun" },
  { x: 129, y: 143, text: "B · deleter gun" },
  { x: 118, y: 218, text: "OUT · A∧¬B" },
  { x: 330, y: 20, text: "REFLECTOR · 90° turn" },
  { x: 315, y: 205, text: "DUPLICATOR · fan-out →2" },
];

type Rgb = readonly [number, number, number];

const nodeColors: Record<NodeView["kind"], Rgb> = {
  clock: [0.95, 0.72, 0.25],
  wire: [0.45, 0.62, 0.68],
  not: [0.72, 0.5, 0.95],
  sram: [0.35, 0.9, 0.55],
};

const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;

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
  const audio = createAutomataAudio();
  let golRate = GOL_GENERATIONS_PER_SECOND;
  let muted = false;
  let root = 220;
  let scale: ScaleName = DEFAULT_SCALE;

  // All declarative chrome (HUD, panel, splash, labels) lives in the UI module.
  const ui = mountUi({
    gridW: GRID_W,
    gridH: GRID_H,
    nodeLabels: nodes.map((n) => ({ x: n.x, y: n.y, text: n.label })),
    substrateLabels: SUBSTRATE_LABELS,
    scales: SCALE_NAMES,
    defaultScale: DEFAULT_SCALE,
    onStart: () => audio.resume(),
    onScale: (s) => {
      scale = s as ScaleName;
    },
    onTempo: (v) => {
      golRate = v;
    },
    onRoot: (v) => {
      root = v;
    },
    onVolume: (v) => audio.configure({ master: v }),
    onBeat: (v) => audio.configure({ beat: v }),
    onHarmony: (v) => audio.configure({ harmony: v }),
    onMelody: (v) => audio.configure({ melody: v }),
  });

  try {
    const gpu = await acquireGpu(canvas);

    const glider = unwrapOk(parseRle(GLIDER_RLE));
    const gunClock = createGunClock(GUN_X, GUN_Y);
    const inhibitGate = createGliderInhibitGate(NOT_BASE_X, NOT_BASE_Y);
    // Routing primitives (step 1): a 90-degree reflector and a fan-out
    // duplicator. Both are fed live in the frame loop.
    const reflector = createReflector(REFLECT_BASE_X, REFLECT_BASE_Y);
    const duplicator = createDuplicator(DUP_BASE_X, DUP_BASE_Y);

    // The scene: the clock/wire/eater lane, a live glider inhibit gate
    // (A AND NOT B), and a routing showcase (reflector + duplicator). The
    // duplicator machine is seeded with its first input so the parity check
    // sees a clean, non-chaotic machine.
    let inputA = true;
    let inputB = true;
    const buildScene = (a: boolean, b: boolean): Cell[] => [
      ...gunClock.seed,
      ...gunClock.laneEater(EATER_DISTANCE),
      ...inhibitGate.seed(a, b),
      ...reflector.seed,
      ...duplicator.seed,
      ...duplicator.inputGlider(),
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
    // Each tap is a pentatonic step: a crossing flashes the window and plucks.
    const detectors = MUSIC_DISTANCES.map((d) => gunClock.laneDetector(d));
    const edgeDetectors = detectors.map(() => createEdgeDetector());
    const detections: number[][] = detectors.map(() => []);
    const detectorFlash = detectors.map(() => 0);
    // Latest alive-count per detector window — the gate signal for each voice.
    const windowLevel = detectors.map(() => 0);

    const sampleDetectors = () => {
      detectors.forEach((det, i) => {
        const gen = engine.generation();
        void engine
          .readRegion(det.x, det.y, det.size, det.size)
          .then((cells) => {
            const level = countWindow(cells);
            windowLevel[i] = level;
            if (edgeDetectors[i].sample(level)) {
              detections[i].push(gen);
              detectorFlash[i] = performance.now() + 400;
            }
          });
      });
    };

    // Inhibit gate output: edge-detect the carrier lane past the crossing, and
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

    // Click drops a glider at the cursor (and enables audio on first gesture).
    canvas.addEventListener("pointerdown", (e) => {
      audio.resume();
      const cx = Math.floor((e.clientX / canvas.clientWidth) * GRID_W);
      const cy = Math.floor((e.clientY / canvas.clientHeight) * GRID_H);
      engine.inject(placePattern(glider, cx, cy));
    });

    // Keys: "a"/"b" toggle the inhibit gate's input streams (which gate the
    // drone voice); "m" mutes.
    window.addEventListener("keydown", (e) => {
      audio.resume();
      const key = e.key.toLowerCase();
      if (key === "a") {
        inputA = !inputA;
        rebuildGate();
      } else if (key === "b") {
        inputB = !inputB;
        rebuildGate();
      } else if (key === "m") {
        muted = audio.toggleMute();
      }
    });

    // Population readback once a second — exercises the same readRegion path
    // the circuit substrate uses as its output detector.
    let populationText = "";
    let popNorm = 0;
    const samplePopulation = async () => {
      const cells = await engine.readRegion(0, 0, GRID_W, GRID_H);
      let count = 0;
      for (const c of cells) count += c;
      popNorm = Math.min(1, count / 500);
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

      golAccumulator += dt * golRate;
      let golSteps = Math.floor(golAccumulator);
      golAccumulator -= golSteps;
      const stepped = golSteps > 0;
      // Step in chunks that land on multiples of 30, feeding the routing
      // showcase: the duplicator needs a p30-aligned input stream; the stable
      // reflector accepts spaced gliders at any phase.
      while (golSteps > 0) {
        const gen = engine.generation();
        const nextBoundary = (Math.floor(gen / 30) + 1) * 30;
        const chunk = Math.min(golSteps, nextBoundary - gen);
        engine.step(chunk);
        golSteps -= chunk;
        const nowGen = engine.generation();
        if (nowGen % 30 === 0) engine.inject(duplicator.inputGlider());
        if (
          Math.floor(nowGen / REFLECT_INJECT_PERIOD) >
          Math.floor(gen / REFLECT_INJECT_PERIOD)
        ) {
          engine.inject(reflector.inputGlider(2));
        }
      }
      if (stepped) {
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

      // Routing output markers (purple): where the reflector delivers its
      // turned glider and the duplicator delivers its two fan-out copies.
      for (const m of [
        reflector.outputDetector(30),
        duplicator.outputNE(45),
        duplicator.outputSE(45),
      ]) {
        pushInstance(
          (m.x + m.size / 2) * cellPx,
          (m.y + m.size / 2) * cellPy,
          (m.size / 2) * cellPx,
          (m.size / 2) * cellPy,
          0,
          0,
          [0.62, 0.42, 0.95, 0.32],
        );
      }

      // Inhibit gate output detector: green when flowing, dim red when dark.
      // Render audio from current CA state: each lane window gates a voice, the
      // gate output gates the drone. A glider fills a ~6-cell window as it passes.
      const gateFlowing = now - gateOutFlash < 1200;
      // Observe the automaton and compose one step of the generative track:
      // population lifts the melody, glider density fills the beat, and the
      // logic gate's output thins/opens it. The gun's generation is the clock.
      const activity = Math.min(
        1,
        windowLevel.reduce((a, c) => a + c, 0) / (windowLevel.length * 3),
      );
      const observations: CaObservations = {
        population: popNorm,
        activity,
        gateHigh: gateFlowing,
        step: Math.floor(engine.generation() / STEP_GENS),
      };
      audio.render(compose(observations, { root, scale }));
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

      const nearHits = detections[0];
      const farHits = detections[detections.length - 1];
      const shared = Math.min(nearHits.length, farHits.length);
      const laneDelay =
        shared > 0 ? farHits[shared - 1] - nearHits[shared - 1] : null;
      ui.substrate.val =
        `substrate: gpu≡cpu ${parityOk ? "✓" : "✗ DIVERGED"} (${PARITY_GENERATIONS} gens)` +
        ` — lane gliders: near ${nearHits.length}, far ${farHits.length}` +
        (laneDelay !== null
          ? `, delay ${laneDelay} gens (wire model: ${EXPECTED_LANE_DELAY})`
          : "");
      const gateOut01 = gateFlowing ? 1 : 0;
      const sound = !audio.enabled()
        ? "click/key to start"
        : muted
          ? "muted (m)"
          : "on";
      ui.gate.val =
        `inhibit gate A∧¬B (keys "a"/"b"): A=${inputA ? 1 : 0} B=${inputB ? 1 : 0}` +
        ` → out ${gateOut01} drives the beat — sound: ${sound}`;
      ui.status.val = `tick ${sim.tick()} — sram bit: ${sim.sramValue()}${populationText}`;
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  } catch (e: unknown) {
    ui.showError(
      e instanceof Error
        ? `${e.message} — try Chrome/Edge 113+, or Safari 18+ with WebGPU enabled.`
        : String(e),
    );
  }
};

void main();
