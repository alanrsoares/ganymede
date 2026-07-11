// Runtime shell: owns the canvas, the fixed-timestep loop, input, and the port
// from the pure World into the GPU renderer. The simulation is pure (world.ts);
// everything here is the imperative edge (WebGPU, rAF, DOM events).

import { createAccumulator, createLoop } from "./engine/loop";
import { createRenderer, loadCycleTextures, type Renderer } from "./gpu";
import { acquireGpu } from "./gpu-context";
import { createOverlay, type Overlay } from "./overlay";
import { mountUi, type Ui } from "./ui";
import {
  BURST_EXPLOSION,
  GRID_H,
  GRID_W,
  initWorld,
  type Msg,
  TEAMS,
  update,
  type World,
} from "./world";
import { MATCH_REINFORCE_GENS } from "./world/factory";

// Team colors (0..1 rgb) → CSS strings for the scoreboard.
const TEAM_SWATCHES = TEAMS.map((t) => ({
  name: t.name,
  css: `rgb(${t.rgb.map((c) => Math.round(c * 255)).join(",")})`,
}));

const SIM_GENERATIONS_PER_SECOND = 45; // fixed sim step rate

const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;

// Mutable state carried between successive `loop` frames. Bundled into one
// object purely so it can be threaded through the per-frame helpers below;
// the fields are the same ones the loop body closed over before extraction.
interface LoopState {
  gen: number;
  resetScheduled: boolean;
  shake: number;
  lastBoomId: number;
  prevAge: number;
}

// Acquire the GPU device/context, wire up the "device lost" surface, and build
// the renderer. Split out of `main` purely to keep that function short.
const initGpu = async (
  canvas: HTMLCanvasElement,
  ui: Ui,
): Promise<Renderer> => {
  const gpu = await acquireGpu(canvas);
  // Surface a GPU reset (driver crash, tab backgrounded too long) instead of
  // silently freezing the canvas.
  gpu.device.lost.then((info) => {
    if (info.reason !== "destroyed") {
      ui.showError(`GPU device lost: ${info.message || info.reason}`);
    }
  });
  const { textureView, sampler } = await loadCycleTextures(gpu.device);
  return createRenderer(gpu, canvas, textureView, sampler);
};

// Pointer/keyboard/resize wiring. The dispatch closure is the single port
// from DOM events into the pure World.
const setupInputHandlers = (
  canvas: HTMLCanvasElement,
  renderer: Renderer,
  dispatch: (msg: Msg) => void,
  ui: Ui,
) => {
  window.addEventListener("resize", () => renderer.resize());

  canvas.addEventListener("pointerdown", (e) => {
    const cx = Math.floor((e.clientX / canvas.clientWidth) * GRID_W);
    const cy = Math.floor((e.clientY / canvas.clientHeight) * GRID_H);
    dispatch({ kind: "drop", x: cx, y: cy });
  });

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (key === "z") dispatch({ kind: "launch", dir: "a" });
    else if (key === "x") dispatch({ kind: "launch", dir: "b" });
    else if (key === "c") dispatch({ kind: "launch", dir: "c" });
    else if (key === "v") dispatch({ kind: "launch", dir: "d" });
    else if (key === "h") ui.hpOn.val = !ui.hpOn.val;
  });
};

// Advance the fixed-timestep sim by however many ticks have accumulated, and
// fire the periodic reinforcement spawn.
const stepSimulation = (
  advanceSim: (dt: number) => number,
  dispatch: (msg: Msg) => void,
  dt: number,
  now: number,
  reinforceRate: number,
  state: LoopState,
) => {
  const steps = advanceSim(dt);
  if (steps > 0) {
    dispatch({ kind: "tick", steps, now });
    state.gen += steps;

    if (reinforceRate > 0) {
      const spawnInterval = Math.floor(600 / reinforceRate);
      if (state.gen % spawnInterval < steps) dispatch({ kind: "replenish" });
    }
  }
};

// Match end: show the winner banner once, then auto-reset to a new round.
const handleMatchEnd = (
  world: World,
  dispatch: (msg: Msg) => void,
  ui: Ui,
  state: LoopState,
) => {
  if (world.winner && !state.resetScheduled) {
    state.resetScheduled = true;
    ui.banner.val =
      world.winner === "draw" ? "DRAW" : `${world.winner.toUpperCase()} WINS`;
    setTimeout(() => {
      dispatch({ kind: "reset" });
      ui.banner.val = "";
      state.resetScheduled = false;
    }, 4200);
  }
};

// Build this frame's instance buffers from the World and hand them to the GPU
// renderer.
const buildAndRender = (
  overlay: Overlay,
  renderer: Renderer,
  canvas: HTMLCanvasElement,
  world: World,
  now: number,
  showHp: boolean,
) => {
  const {
    instances,
    count,
    rockInstances,
    rockCount,
    shieldInstances,
    shieldCount,
    orbInstances,
    orbCount,
  } = overlay.build({
    w: canvas.width,
    h: canvas.height,
    gridW: GRID_W,
    gridH: GRID_H,
    now,
    world,
    showHp,
  });
  renderer.render(
    instances,
    count,
    rockInstances,
    rockCount,
    shieldInstances,
    shieldCount,
    orbInstances,
    orbCount,
    now / 1000,
  );
};

// Screen shake: each fresh explosion punches the canvas; it decays fast.
// Burst ids are monotonic per match; a reset (age rewinds) clears the mark.
const updateScreenShake = (
  canvas: HTMLCanvasElement,
  world: World,
  now: number,
  state: LoopState,
) => {
  if (world.age < state.prevAge) state.lastBoomId = 0;
  state.prevAge = world.age;
  for (const b of world.bursts.items) {
    if (b.kind === BURST_EXPLOSION && b.id > state.lastBoomId) {
      state.lastBoomId = b.id;
      state.shake = Math.min(7, state.shake + 2.2);
    }
  }
  state.shake *= 0.86;
  canvas.style.transform =
    state.shake > 0.15
      ? `translate(${Math.sin(now * 0.11) * state.shake}px, ${Math.cos(now * 0.17) * state.shake}px)`
      : "";
};

// Scoreboard + status line text.
const updateHud = (ui: Ui, world: World) => {
  ui.score.val = world.score;
  const counts: Record<string, number> = {};
  for (const s of world.ships.items) {
    counts[s.colorName] = (counts[s.colorName] ?? 0) + 1;
  }
  ui.counts.val = counts;
  const remain = MATCH_REINFORCE_GENS - world.age;
  const phase = world.winner
    ? "match over"
    : remain > 0
      ? `reinforce ${Math.ceil(remain / SIM_GENERATIONS_PER_SECOND)}s`
      : "sudden death";
  ui.status.val =
    `ships ${world.ships.items.length} — ${phase}` +
    ` — HP bars: ${ui.hpOn.val ? "on (h)" : "off (h)"}`;
};

const main = async () => {
  const overlay = createOverlay();

  // The pure model. Every mutation flows through `dispatch` below.
  let world: World = initWorld(Date.now());

  let simRate = SIM_GENERATIONS_PER_SECOND;
  let reinforceRate = 3; // reinforcement spawns per (arbitrary) window

  const ui = mountUi({
    teams: TEAM_SWATCHES,
    onTempo: (v) => {
      simRate = v;
    },
    onReinforce: (v) => {
      reinforceRate = v;
    },
  });

  try {
    const renderer = await initGpu(canvas, ui);

    // The single port from the pure world into the runtime. Cmds (CA cell
    // injections) are no longer consumed by anything, so we just apply the
    // transition.
    const dispatch = (msg: Msg) => {
      const [next] = update(msg, world);
      world = next;
    };

    setupInputHandlers(canvas, renderer, dispatch, ui);

    const advanceSim = createAccumulator(() => simRate);
    const loopState: LoopState = {
      gen: 0,
      resetScheduled: false,
      shake: 0,
      lastBoomId: 0,
      prevAge: 0,
    };

    const loop = createLoop((dt, now) => {
      stepSimulation(advanceSim, dispatch, dt, now, reinforceRate, loopState);
      handleMatchEnd(world, dispatch, ui, loopState);
      buildAndRender(overlay, renderer, canvas, world, now, ui.hpOn.val);
      updateScreenShake(canvas, world, now, loopState);
      updateHud(ui, world);
    });

    loop.start();
  } catch (e: unknown) {
    ui.showError(
      e instanceof Error
        ? `${e.message} — try Chrome/Edge 113+, or Safari 18+ with WebGPU enabled.`
        : String(e),
    );
  }
};

void main();
