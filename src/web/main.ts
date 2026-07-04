import { createGrid, stepGrid } from "~/domain/gol";
import {
  type CaObservations,
  compose,
  SCALE_NAMES,
  type ScaleName,
  STEP_GENS,
} from "~/domain/music";
import { createAutomataAudio } from "./audio";
import { createGolEngine } from "./gol-gpu";
import { createRenderer, FLOATS_PER_INSTANCE } from "./gpu";
import { acquireGpu } from "./gpu-context";
import { createScene, EXPECTED_LANE_DELAY, PARITY_GENERATIONS } from "./scene";
import { createSimulation, edges, type NodeView, nodes } from "./sim";
import { mountUi } from "./ui";

const TICKS_PER_SECOND = 3;
const GOL_GENERATIONS_PER_SECOND = 45;
const GRID_W = 480;
const GRID_H = 270;
const DEFAULT_SCALE = "minor pentatonic";

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
  const scene = createScene();
  let golRate = GOL_GENERATIONS_PER_SECOND;
  let muted = false;
  let root = 220;
  let scale: ScaleName = DEFAULT_SCALE;

  // All declarative chrome (HUD, panel, splash, labels) lives in the UI module.
  const ui = mountUi({
    gridW: GRID_W,
    gridH: GRID_H,
    nodeLabels: nodes.map((n) => ({ x: n.x, y: n.y, text: n.label })),
    substrateLabels: scene.labels,
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
    const seed = scene.seed();
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

    const renderer = createRenderer(gpu, canvas, engine);
    const sim = createSimulation();

    window.addEventListener("resize", () => renderer.resize());

    // Click drops a glider at the cursor (and enables audio on first gesture).
    canvas.addEventListener("pointerdown", (e) => {
      audio.resume();
      const cx = Math.floor((e.clientX / canvas.clientWidth) * GRID_W);
      const cy = Math.floor((e.clientY / canvas.clientHeight) * GRID_H);
      scene.drop(engine, cx, cy);
    });

    // Keys: "a"/"b" toggle the inhibit gate's input streams; "m" mutes.
    window.addEventListener("keydown", (e) => {
      audio.resume();
      const key = e.key.toLowerCase();
      if (key === "a") scene.toggleInput(engine, "a");
      else if (key === "b") scene.toggleInput(engine, "b");
      else if (key === "m") muted = audio.toggleMute();
    });

    // Population readback once a second — exercises the same readRegion path
    // the substrate uses as its output detector; feeds the music's register.
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
      const golSteps = Math.floor(golAccumulator);
      golAccumulator -= golSteps;
      if (golSteps > 0) {
        scene.stepAndFeed(engine, golSteps);
        scene.sample(engine);
      }

      const w = canvas.width;
      const h = canvas.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cellPx = w / GRID_W;
      const cellPy = h / GRID_H;
      instanceCount = 0;

      // Connection lines (abstract spec circuit)
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

      const marker = (
        det: { x: number; y: number; size: number },
        color: readonly [number, number, number, number],
      ) =>
        pushInstance(
          (det.x + det.size / 2) * cellPx,
          (det.y + det.size / 2) * cellPy,
          (det.size / 2) * cellPx,
          (det.size / 2) * cellPy,
          0,
          0,
          color,
        );

      // Lane detector windows (amber), flashing when a glider crosses
      for (const { det, flashUntil } of scene.detectorViews()) {
        const flash = now < flashUntil ? 0.45 : 0;
        marker(det, [0.95, 0.72, 0.25, 0.18 + flash]);
      }

      // Routing output markers (purple): reflector turn + duplicator fan-out
      for (const det of scene.routingMarkers())
        marker(det, [0.62, 0.42, 0.95, 0.32]);

      // Inhibit gate output: green when flowing, dim red when dark
      const obs = scene.observe(now);
      const gate = scene.gateView();
      const gateFlash = now < gate.flashUntil ? 0.4 : 0;
      marker(
        gate.det,
        obs.gateFlowing
          ? [0.35, 0.9, 0.55, 0.25 + gateFlash]
          : [0.85, 0.35, 0.35, 0.22],
      );

      // Audio: compose one step of the generative track from CA observations.
      const observations: CaObservations = {
        population: popNorm,
        activity: obs.activity,
        gateHigh: obs.gateFlowing,
        step: Math.floor(engine.generation() / STEP_GENS),
      };
      audio.render(compose(observations, { root, scale }));

      renderer.render(instances, instanceCount, now / 1000);

      ui.substrate.val =
        `substrate: gpu≡cpu ${parityOk ? "✓" : "✗ DIVERGED"} (${PARITY_GENERATIONS} gens)` +
        ` — lane gliders: near ${obs.laneNear}, far ${obs.laneFar}` +
        (obs.laneDelay !== null
          ? `, delay ${obs.laneDelay} gens (wire model: ${EXPECTED_LANE_DELAY})`
          : "");
      const sound = !audio.enabled()
        ? "click/key to start"
        : muted
          ? "muted (m)"
          : "on";
      ui.gate.val =
        `inhibit gate A∧¬B (keys "a"/"b"): A=${scene.inputA ? 1 : 0} B=${scene.inputB ? 1 : 0}` +
        ` → out ${obs.gateFlowing ? 1 : 0} drives the beat — sound: ${sound}`;
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
