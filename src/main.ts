// Runtime shell: owns the canvas, the fixed-timestep loop, input, and the port
// from the pure World into the GPU renderer. The simulation is pure (world.ts);
// everything here is the imperative edge (WebGPU, rAF, DOM events).

import { type Codex, mountCodex } from "./codex";
import { createAccumulator, createLoop } from "./engine/loop";
import {
  type CameraView,
  createRenderer,
  loadCycleTextures,
  type Renderer,
} from "./gpu";
import { acquireGpu } from "./gpu-context";
import { createOverlay, type Overlay } from "./overlay";
import { mountSetup, type Setup } from "./setup";
import { mountShipCard } from "./shipCard";
import { mountUi, type Ui } from "./ui";
import { mountWelcome, type Welcome } from "./welcome";
import {
  ARENA,
  BURST_EXPLOSION,
  DEFAULT_GRID_H,
  initWorld,
  type LightCycle,
  type MatchConfig,
  type Msg,
  setGridBounds,
  setOrbitPhase,
  TEAMS,
  update,
  type World,
} from "./world";
import { DEFAULT_CONFIG, shipRadius } from "./world/factory";

// Team colors (0..1 rgb) → CSS strings for the scoreboard.
const TEAM_SWATCHES = TEAMS.map((t) => ({
  name: t.name,
  css: `rgb(${t.rgb.map((c) => Math.round(c * 255)).join(",")})`,
}));

// The backdrop behind the welcome/setup screens: a lively endless 4-team swarm
// so the title screen shows a dense, colourful fleet flocking the centre core.
const ATTRACT_CONFIG: MatchConfig = {
  teams: 4,
  initialShips: 9,
  reinforceRate: 6,
  tempo: 44,
  reinforceGens: DEFAULT_CONFIG.reinforceGens,
  format: "endless",
};

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
  deployRemaining: number; // launch-fleet ships still to muster in
  deployTimer: number; // seconds until the next muster spawn
}

const initLoopState = (): LoopState => ({
  gen: 0,
  resetScheduled: false,
  shake: 0,
  lastBoomId: 0,
  prevAge: 0,
  deployRemaining: 0,
  deployTimer: 0,
});

// Staggered launch muster: a new match starts with an empty arena and deploys
// its fleet one ship at a time, this many seconds apart, from the bases.
const DEPLOY_INTERVAL_S = 0.17;

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

// Nearest ship under a grid point, or null — the hull whose radius (plus a
// small margin) contains the cursor. O(ships) ≤ 12, cheap enough per move.
const pickShip = (world: World, gx: number, gy: number): LightCycle | null => {
  let best: LightCycle | null = null;
  let bestD2 = Infinity;
  for (const s of world.ships.items) {
    const dx = s.x - gx;
    const dy = s.y - gy;
    const d2 = dx * dx + dy * dy;
    const reach = shipRadius(s.level) + 3;
    if (d2 <= reach * reach && d2 < bestD2) {
      bestD2 = d2;
      best = s;
    }
  }
  return best;
};

const updateGridDimensions = () => {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const aspect = h > 0 ? w / h : 16 / 9;
  const newGridW = Math.round(DEFAULT_GRID_H * aspect);
  setGridBounds(newGridW, DEFAULT_GRID_H);
};

// Pointer/keyboard/resize wiring. The dispatch closure is the single port
// from DOM events into the pure World.
// True while keyboard focus is inside a form control — we must not hijack its
// keys (a slider drag, a future text field) for game hotkeys.
const typingInField = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === "INPUT" ||
      t.tagName === "SELECT" ||
      t.tagName === "TEXTAREA" ||
      t.isContentEditable)
  );
};

const handlePointerDown = (
  e: PointerEvent,
  canvas: HTMLCanvasElement,
  dispatch: (msg: Msg) => void,
  getWorld: () => World,
) => {
  const cx = (e.offsetX / canvas.clientWidth) * ARENA.w;
  const cy = (e.offsetY / canvas.clientHeight) * ARENA.h;
  if (e.button === 2 || e.shiftKey) {
    dispatch({ kind: "rally", x: Math.floor(cx), y: Math.floor(cy) });
  } else {
    const clickedShip = pickShip(getWorld(), cx, cy);
    if (clickedShip) {
      dispatch({ kind: "control", shipId: clickedShip.id });
    } else {
      const world = getWorld();
      if (world.controlledShipId !== null) {
        dispatch({ kind: "control", shipId: null });
      } else {
        dispatch({ kind: "drop", x: Math.floor(cx), y: Math.floor(cy) });
      }
    }
  }
};

const getDirectionKey = (
  key: string,
): "up" | "down" | "left" | "right" | null => {
  if (key === "w" || key === "arrowup") return "up";
  if (key === "s" || key === "arrowdown") return "down";
  if (key === "a" || key === "arrowleft") return "left";
  if (key === "d" || key === "arrowright") return "right";
  return null;
};

const triggerManualAction = (
  key: string,
  getWorld: () => World,
  dispatch: (msg: Msg) => void,
): boolean => {
  const isAction = /^[1-7]$/.test(key);
  if (!isAction) return false;
  const world = getWorld();
  if (world.controlledShipId !== null) {
    const actionId = Number.parseInt(key, 10);
    dispatch({ kind: "action", actionId });
    return true;
  }
  return false;
};

const handleKeyDown = (
  e: KeyboardEvent,
  codex: Codex,
  isSetupOpen: () => boolean,
  pressedKeys: {
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    space: boolean;
  },
  updateControls: () => void,
  gameKeys: Record<string, () => void>,
  dispatch: (msg: Msg) => void,
  getWorld: () => World,
) => {
  if (typingInField(e)) return;
  const key = e.key.toLowerCase();
  if (key === "c") return codex.toggle();
  if (codex.isOpen() || isSetupOpen()) return;

  const dir = getDirectionKey(key);
  if (dir) {
    pressedKeys[dir] = true;
    e.preventDefault();
    updateControls();
    return;
  }

  if (key === " ") {
    pressedKeys.space = true;
    e.preventDefault();
    updateControls();
    return;
  }

  if (triggerManualAction(key, getWorld, dispatch)) {
    e.preventDefault();
    return;
  }

  gameKeys[key]?.();
};

const handleKeyUp = (
  e: KeyboardEvent,
  pressedKeys: {
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    space: boolean;
  },
  updateControls: () => void,
) => {
  if (typingInField(e)) return;
  const key = e.key.toLowerCase();
  const dir = getDirectionKey(key);
  if (dir) {
    pressedKeys[dir] = false;
    updateControls();
    return;
  }
  if (key === " ") {
    pressedKeys.space = false;
    updateControls();
  }
};

const createControlState = (
  dispatch: (msg: Msg) => void,
  getWorld: () => World,
) => {
  const pressedKeys = {
    up: false,
    down: false,
    left: false,
    right: false,
    space: false,
  };
  const updateControls = () => {
    const world = getWorld();
    if (world.controlledShipId !== null) {
      dispatch({
        kind: "controlKeys",
        up: pressedKeys.up,
        down: pressedKeys.down,
        left: pressedKeys.left,
        right: pressedKeys.right,
        space: pressedKeys.space,
      });
    }
  };
  const clearControls = () => {
    pressedKeys.up = false;
    pressedKeys.down = false;
    pressedKeys.left = false;
    pressedKeys.right = false;
    pressedKeys.space = false;
    updateControls();
  };
  return { pressedKeys, updateControls, clearControls };
};

const wireInput = (
  canvas: HTMLCanvasElement,
  renderer: Renderer,
  dispatch: (msg: Msg) => void,
  ui: Ui,
  getWorld: () => World,
  isSetupOpen: () => boolean,
): Codex => {
  const card = mountShipCard();
  const codex = mountCodex();
  window.addEventListener("resize", () => {
    updateGridDimensions();
    renderer.resize();
  });

  canvas.addEventListener("pointerdown", (e) =>
    handlePointerDown(e, canvas, dispatch, getWorld),
  );
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointermove", (e) => {
    const gx = (e.offsetX / canvas.clientWidth) * ARENA.w;
    const gy = (e.offsetY / canvas.clientHeight) * ARENA.h;
    card.render(pickShip(getWorld(), gx, gy), e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerleave", () => card.render(null, 0, 0));

  const { pressedKeys, updateControls, clearControls } = createControlState(
    dispatch,
    getWorld,
  );

  const gameKeys: Record<string, () => void> = {
    z: () => dispatch({ kind: "launch", dir: "a" }),
    x: () => dispatch({ kind: "launch", dir: "b" }),
    h: () => {
      ui.hpOn.val = !ui.hpOn.val;
    },
  };

  window.addEventListener("keydown", (e) =>
    handleKeyDown(
      e,
      codex,
      isSetupOpen,
      pressedKeys,
      updateControls,
      gameKeys,
      dispatch,
      getWorld,
    ),
  );

  window.addEventListener("keyup", (e) =>
    handleKeyUp(e, pressedKeys, updateControls),
  );

  window.addEventListener("blur", clearControls);

  return codex;
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

// Deploy the launch fleet a ship at a time — each `replenish` mans the emptiest
// live base, so a fresh match musters in staggered from the bases instead of
// the whole fleet popping in at once.
const stepDeploy = (
  dispatch: (msg: Msg) => void,
  dt: number,
  state: LoopState,
) => {
  if (state.deployRemaining <= 0) return;
  state.deployTimer -= dt;
  if (state.deployTimer > 0) return;
  dispatch({ kind: "replenish" });
  state.deployRemaining -= 1;
  state.deployTimer = DEPLOY_INTERVAL_S;
};

// Match end: show the winner banner once, then reopen the setup screen so the
// player can tweak and launch a fresh match. `resetScheduled` latches until the
// next startMatch clears it, so this fires exactly once per match.
const handleMatchEnd = (
  world: World,
  ui: Ui,
  state: LoopState,
  setup: Setup,
) => {
  if (world.winner && !state.resetScheduled) {
    state.resetScheduled = true;
    ui.banner.val =
      world.winner === "draw" ? "DRAW" : `${world.winner.toUpperCase()} WINS`;
    setTimeout(() => {
      ui.banner.val = "";
      setup.show();
    }, 3600);
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
  camera: CameraView,
) => {
  // Align the furniture ring to the world being drawn (the sim advances age
  // between renders; this keeps rendered bases/portals/pads on the live orbit).
  setOrbitPhase(world.age);
  const {
    instances,
    count,
    rockInstances,
    rockCount,
    shieldInstances,
    shieldCount,
    orbInstances,
    orbCount,
    baseInstances,
    baseCount,
    centerPadInstances,
    centerPadCount,
    portalCount,
  } = overlay.build({
    w: canvas.width,
    h: canvas.height,
    gridW: ARENA.w,
    gridH: ARENA.h,
    now,
    world,
    showHp,
  });
  renderer.render(
    instances,
    count,
    portalCount,
    rockInstances,
    rockCount,
    shieldInstances,
    shieldCount,
    orbInstances,
    orbCount,
    baseInstances,
    baseCount,
    centerPadInstances,
    centerPadCount,
    now / 1000,
    camera,
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
const getHudPhaseText = (world: World): string => {
  if (world.winner) return "match over";
  if (world.config.format === "endless") return "endless";
  const remain = world.config.reinforceGens - world.age;
  return remain > 0
    ? `reinforce ${Math.ceil(remain / world.config.tempo)}s`
    : "sudden death";
};

// Scoreboard + status line text.
const updateHud = (ui: Ui, world: World) => {
  ui.score.val = world.score;
  const counts: Record<string, number> = {};
  for (const s of world.ships.items) {
    counts[s.colorName] = (counts[s.colorName] ?? 0) + 1;
  }
  ui.counts.val = counts;
  const phase = getHudPhaseText(world);
  const rallyText = world.rally ? ` — ${world.rally.team} rally` : "";
  ui.status.val =
    `ships ${world.ships.items.length} — ${phase}` +
    ` — HP bars: ${ui.hpOn.val ? "on (h)" : "off (h)"}` +
    rallyText;

  const controlled =
    world.controlledShipId !== null
      ? world.ships.items.find((s) => s.id === world.controlledShipId) || null
      : null;
  ui.controlledShip.val = controlled;
};

// Track the canvas backing size; when the client box changes, re-derive the grid
// bounds and resize the renderer. Owns its own last-size state so the render loop
// stays a one-line call. Split out to keep `startRuntime` short.
const createResizeSync = (renderer: Renderer) => {
  let lastW = 0;
  let lastH = 0;
  return () => {
    if (canvas.clientWidth === lastW && canvas.clientHeight === lastH) return;
    lastW = canvas.clientWidth;
    lastH = canvas.clientHeight;
    updateGridDimensions();
    renderer.resize();
  };
};

// The mutable runtime state shared between the UI handlers and the render loop:
// the current immutable world plus the two live-tunable rates. `startMatch`
// swaps the whole world; ticks swap it each frame via `dispatch`.
interface Sim {
  world: World;
  simRate: number;
  reinforceRate: number;
}

// Wire the post-init runtime: the world port, the setup screen (gated behind the
// welcome splash), input, and the fixed-timestep loop. Split out of `main` so
// that function stays a short bootstrap.
const startRuntime = (
  renderer: Renderer,
  overlay: Overlay,
  ui: Ui,
  welcome: Welcome,
  sim: Sim,
) => {
  // The single port from the pure world into the runtime: apply the transition
  // and swap in the next immutable world.
  const dispatch = (msg: Msg) => {
    sim.world = update(msg, sim.world);
  };
  const advanceSim = createAccumulator(() => sim.simRate);
  const loopState = initLoopState();

  // Launch a fresh match from the setup screen's chosen config. The arena starts
  // empty; `stepDeploy` musters the fleet in staggered from the bases.
  const startMatch = (cfg: MatchConfig) => {
    sim.world = initWorld(Date.now(), { ...cfg, initialShips: 0 });
    sim.simRate = cfg.tempo;
    sim.reinforceRate = cfg.reinforceRate;
    ui.activeTeamCount.val = cfg.teams;
    ui.banner.val = "";
    loopState.resetScheduled = false;
    loopState.deployRemaining = cfg.initialShips;
    loopState.deployTimer = DEPLOY_INTERVAL_S;
  };
  // Setup starts hidden behind the welcome splash; the title screen reveals it
  // once the player hits "Enter orbit".
  const setup = mountSetup(startMatch, { startHidden: true });
  const codex = wireInput(
    canvas,
    renderer,
    dispatch,
    ui,
    () => sim.world,
    () => setup.isOpen(),
  );
  // Keep the welcome splash clean (the HUD is already hidden from boot); reveal
  // all chrome together on launch.
  codex.setChromeHidden(true);
  welcome.begun.then(() => {
    setup.show();
    ui.setChromeHidden(false);
    codex.setChromeHidden(false);
  });

  const syncCanvasSize = createResizeSync(renderer);
  const loop = createLoop((dt, now) => {
    syncCanvasSize();
    stepDeploy(dispatch, dt, loopState);
    // Suppress trickle reinforcement until the launch fleet finishes mustering.
    const reinforceRate = loopState.deployRemaining > 0 ? 0 : sim.reinforceRate;
    stepSimulation(advanceSim, dispatch, dt, now, reinforceRate, loopState);
    handleMatchEnd(sim.world, ui, loopState, setup);
    buildAndRender(
      overlay,
      renderer,
      canvas,
      sim.world,
      now,
      ui.hpOn.val,
      welcome.camera,
    );
    updateScreenShake(canvas, sim.world, now, loopState);
    updateHud(ui, sim.world);
  });
  loop.start();
};

const main = async () => {
  // Show the title screen immediately — it also masks the GPU init latency and
  // directs the composite camera over the live attract scene behind it.
  const welcome = mountWelcome();
  const overlay = createOverlay();
  const sim: Sim = {
    world: null as any,
    simRate: ATTRACT_CONFIG.tempo,
    reinforceRate: ATTRACT_CONFIG.reinforceRate,
  };
  const ui = mountUi({
    teams: TEAM_SWATCHES,
    onTempo: (v) => {
      sim.simRate = v;
    },
    onReinforce: (v) => {
      sim.reinforceRate = v;
    },
  });
  ui.setChromeHidden(true); // keep the welcome splash clean; revealed on launch

  try {
    const renderer = await initGpu(canvas, ui);
    // At this point, GPU initialization is complete, so the browser has fully
    // calculated the window client layout sizing.
    updateGridDimensions();
    sim.world = initWorld(Date.now(), ATTRACT_CONFIG);

    startRuntime(renderer, overlay, ui, welcome, sim);
  } catch (e: unknown) {
    ui.showError(
      e instanceof Error
        ? `${e.message} — try Chrome/Edge 113+, or Safari 18+ with WebGPU enabled.`
        : String(e),
    );
  }
};

void main();
