import {
  type CaObservations,
  compose,
  SCALE_NAMES,
  type ScaleName,
  STEP_GENS,
} from "~/domain/music";
import { createAutomataAudio } from "./audio";
import { createGolEngine } from "./gol-gpu";
import { createRenderer } from "./gpu";
import { acquireGpu } from "./gpu-context";
import { createOverlay } from "./overlay";
import { checkParity } from "./parity";
import { createScene, EXPECTED_LANE_DELAY, PARITY_GENERATIONS } from "./scene";
import { createSimulation, nodes } from "./sim";
import { mountUi } from "./ui";

const TICKS_PER_SECOND = 3;
const GOL_GENERATIONS_PER_SECOND = 45;
const GRID_W = 480;
const GRID_H = 270;
const DEFAULT_SCALE = "minor pentatonic";

const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;

const main = async () => {
  const audio = createAutomataAudio();
  const scene = createScene();
  const overlay = createOverlay();
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
    onDrive: (v) => audio.configure({ drive: v }),
    onDelay: (v) => audio.configure({ delay: v }),
    onReverb: (v) => audio.configure({ reverb: v }),
  });

  try {
    const gpu = await acquireGpu(canvas);
    const seed = scene.seed();
    const engine = createGolEngine(gpu.device, GRID_W, GRID_H, seed);

    // GPU ≡ CPU parity against the tested CPU oracle (advances the engine).
    const parityOk = await checkParity(
      engine,
      seed,
      PARITY_GENERATIONS,
      GRID_W,
      GRID_H,
    );

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

    // Input register on the bottom key row: z/x = inhibit A/B, c/v = AND A/B
    // (b/n reserved for the next gate); m mutes.
    window.addEventListener("keydown", (e) => {
      audio.resume();
      const key = e.key.toLowerCase();
      if (key === "z") scene.toggleInput(engine, "a");
      else if (key === "x") scene.toggleInput(engine, "b");
      else if (key === "c") scene.toggleInput(engine, "c");
      else if (key === "v") scene.toggleInput(engine, "d");
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

      const obs = scene.observe(now);

      // Audio: compose one step of the generative track from CA observations.
      const observations: CaObservations = {
        population: popNorm,
        activity: obs.activity,
        gateHigh: obs.gateFlowing,
        andHigh: obs.andFlowing,
        laneTriggers: obs.laneTriggers,
        step: Math.floor(engine.generation() / STEP_GENS),
      };
      audio.render(compose(observations, { root, scale }));

      // Overlay: build the sprite instances and draw over the GoL background.
      const { instances, count } = overlay.build({
        w: canvas.width,
        h: canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
        gridW: GRID_W,
        gridH: GRID_H,
        simTime,
        now,
        sim,
        scene,
        gateFlowing: obs.gateFlowing,
        andFlowing: obs.andFlowing,
      });
      renderer.render(instances, count, now / 1000);

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
        `inhibit A∧¬B (keys z/x): A=${scene.inputA ? 1 : 0} B=${scene.inputB ? 1 : 0}` +
        ` → out ${obs.gateFlowing ? 1 : 0} enables the bass — sound: ${sound}`;
      ui.and.val =
        `wired AND A∧B (keys c/v): A=${scene.andA ? 1 : 0} B=${scene.andB ? 1 : 0}` +
        ` → out ${obs.andFlowing ? 1 : 0} enables the pad — 2-bit word transposes harmony`;
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
