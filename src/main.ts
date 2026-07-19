// Runtime shell bootstrap: owns the canvas, GPU init, and the fixed-timestep
// loop that ports the pure World into the renderer. The imperative edges live in
// runtime/input.ts (DOM events) and runtime/frame.ts (stepping + render/HUD).

import { createAccumulator, createLoop } from "~/engine/loop";
import { createRenderer, loadCycleTextures, type Renderer } from "~/render/gpu";
import { acquireGpu } from "~/render/gpu-context";
import { createOverlay, type Overlay } from "~/render/overlay";
import { type Audio, createAudio, type Scene } from "~/runtime/audio";
import {
  buildAndRender,
  createResizeSync,
  createStarters,
  handleArcadeEnd,
  handleMatchEnd,
  initLoopState,
  type Sim,
  stepDeploy,
  stepSimulation,
  updateHud,
  updateScreenShake,
} from "~/runtime/frame";
import { updateGridDimensions, wireInput } from "~/runtime/input";
import { type Lobby, mountArcadeLobby } from "~/ui/arcade-lobby";
import { mountMixer } from "~/ui/mixer";
import { mountMobileControls } from "~/ui/mobileControls";
import { mountPauseMenu, type PauseMenu } from "~/ui/pauseMenu";
import { mountSetup, type Setup } from "~/ui/setup";
import { rgbCss } from "~/ui/shipStats";
import { mountUi, type Ui } from "~/ui/ui";
import { mountWelcome, type Welcome } from "~/ui/welcome";
import { DEFAULT_CONFIG } from "~/world/tuning";
import {
  initWorld,
  type MatchConfig,
  type Msg,
  TEAMS,
  update,
  type World,
} from "./world";

// Team colors (0..1 rgb) → CSS strings for the scoreboard.
const TEAM_SWATCHES = TEAMS.map((t) => ({
  name: t.name,
  css: rgbCss(t.rgb),
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

// Soundtrack scene from game state: pre-game screens → menu bed, a live match →
// battle or arcade.
const sceneFor = (world: World, inMatch: boolean): Scene =>
  !inMatch ? "menu" : world.config.format === "arcade" ? "arcade" : "battle";

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

// Reveal the pre-game screen for the chosen mode + all persistent chrome.
const revealForMode = (
  mode: "arcade" | "autobattle",
  lobby: Lobby,
  setup: ReturnType<typeof mountSetup>,
  ui: Ui,
  codex: ReturnType<typeof wireInput>,
) => {
  (mode === "arcade" ? lobby : setup).show();
  ui.setChromeHidden(false);
  codex.setChromeHidden(false);
};

// Wire the post-init runtime: the world port, the two pre-game screens (gated
// behind the welcome splash), input, and the fixed-timestep loop.
const wireTouchControls = (
  dispatch: (msg: Msg) => void,
  ui: Ui,
  onPause: (paused: boolean) => void,
) =>
  mountMobileControls({
    controlledShip: ui.controlledShip,
    onKeys: (k) => dispatch({ kind: "controlKeys", ...k }),
    onAction: (id) => dispatch({ kind: "action", actionId: id }),
    onCycle: (dir) => dispatch({ kind: "cycleTarget", dir }),
    onPause,
  });

// Surface a real pause as an on-screen touch button (no-op on pointer devices)
// and return the loop's "is the sim frozen?" predicate. The codex already pauses
// while open (and has its own opener button); `paused` is a separate freeze.
const wirePause = (
  codex: ReturnType<typeof wireInput>,
  pause: PauseMenu,
  dispatch: (msg: Msg) => void,
  ui: Ui,
): (() => boolean) => {
  const paused = { on: false };
  wireTouchControls(dispatch, ui, (p) => {
    paused.on = p;
  });
  return () => codex.isOpen() || paused.on || pause.isOpen();
};

interface PreGameFlow {
  setup: Setup;
  lobby: Lobby;
  codex: ReturnType<typeof wireInput>;
  /** Desktop ESC pause menu; its `isOpen()` freezes the sim. */
  pause: PauseMenu;
  /** Live welcome splash across remounts; `up` gates game input under it. */
  welcomeRef: { current: Welcome; up: boolean };
  /** True once a mode was chosen and no pre-game dialog is covering the sim. */
  inMatch: () => boolean;
}

// Pre-game surfaces and their lifecycle: welcome splash → mode dialog →
// launch. Closing a dialog (✕ / Escape / backdrop) returns to a freshly
// mounted welcome splash (the old one removed itself); the ref keeps the
// render loop pointed at the live splash's camera across remounts.
const wirePreGame = (
  renderer: Renderer,
  dispatch: (msg: Msg) => void,
  ui: Ui,
  sim: Sim,
  audio: Audio,
  welcome: Welcome,
  startMatch: (config: MatchConfig) => void,
  startArcadeMatch: (config: MatchConfig) => void,
): PreGameFlow => {
  const welcomeRef = { current: welcome, up: true };
  let begun = false;
  const onDialogClose = () => {
    begun = false;
    ui.setChromeHidden(true);
    codex.setChromeHidden(true);
    welcomeRef.current = mountWelcome();
    welcomeRef.up = true;
    wireBegun(welcomeRef.current);
  };
  const setup = mountSetup(startMatch, {
    startHidden: true,
    onClose: onDialogClose,
  });
  const lobby = mountArcadeLobby(startArcadeMatch, {
    startHidden: true,
    onClose: onDialogClose,
  });
  // ESC pause menu; quitting to title reuses the dialog-close flow (back to
  // the welcome splash).
  const pause = mountPauseMenu({ onQuit: onDialogClose });
  const codex = wireInput(
    canvas,
    renderer,
    dispatch,
    ui,
    () => sim.world,
    // Gate game input while any full-screen surface is up — the pre-game
    // dialogs or the welcome splash (stops C opening the codex over the title).
    () => setup.isOpen() || lobby.isOpen() || welcomeRef.up,
    audio,
    pause,
  );
  // Keep the welcome splash clean; reveal all chrome together on launch.
  codex.setChromeHidden(true);
  // The welcome CTA is the first user gesture — the only moment the browser
  // lets us start the AudioContext.
  const wireBegun = (w: Welcome) =>
    w.begun.then((mode) => {
      begun = true;
      welcomeRef.up = false;
      audio.resume();
      revealForMode(mode, lobby, setup, ui, codex);
    });
  wireBegun(welcome);
  return {
    setup,
    lobby,
    codex,
    pause,
    welcomeRef,
    inMatch: () => begun && !setup.isOpen() && !lobby.isOpen(),
  };
};

const startRuntime = (
  renderer: Renderer,
  overlay: Overlay,
  ui: Ui,
  welcome: Welcome,
  sim: Sim,
  audio: Audio,
) => {
  // The single port from the pure world into the runtime: swap in the next world.
  const dispatch = (msg: Msg) => {
    sim.world = update(msg, sim.world);
  };
  const advanceSim = createAccumulator(() => sim.simRate);
  const loopState = initLoopState();
  const { startMatch, startArcadeMatch } = createStarters(sim, ui, loopState);

  const flow = wirePreGame(
    renderer,
    dispatch,
    ui,
    sim,
    audio,
    welcome,
    startMatch,
    startArcadeMatch,
  );
  const { setup, lobby, codex, pause, welcomeRef } = flow;
  const isPaused = wirePause(codex, pause, dispatch, ui);

  const syncCanvasSize = createResizeSync(renderer, canvas);
  const loop = createLoop((dt, now) => {
    syncCanvasSize();
    // The codex/guide panel — and the mobile pause button — freeze the sim:
    // while paused we still render the frozen world (and skip accumulating dt,
    // so resume doesn't fast-forward).
    if (!isPaused()) {
      stepDeploy(dispatch, dt, loopState);
      // Suppress trickle reinforcement until the launch fleet finishes mustering.
      const reinforceRate =
        loopState.deployRemaining > 0 ? 0 : sim.reinforceRate;
      stepSimulation(advanceSim, dispatch, dt, now, reinforceRate, loopState);
      if (sim.world.config.format === "arcade") {
        handleArcadeEnd(sim.world, ui, loopState, lobby);
      } else {
        handleMatchEnd(sim.world, ui, loopState, setup);
      }
    }
    buildAndRender(
      overlay,
      renderer,
      canvas,
      sim.world,
      now,
      ui.hpOn.val,
      welcomeRef.current.camera,
    );
    updateScreenShake(canvas, sim.world, now, loopState);
    updateHud(ui, sim.world);
    // setScene is idempotent, so calling it each frame is fine.
    audio.setScene(sceneFor(sim.world, flow.inMatch()));
    audio.frame(sim.world, now);
  });
  loop.start();
};

const main = async () => {
  // Show the title screen immediately — it also masks the GPU init latency and
  // directs the composite camera over the live attract scene behind it.
  const welcome = mountWelcome();
  const overlay = createOverlay();
  const audio = createAudio();
  mountMixer(audio);
  // Placeholder attract world on the default grid; rebuilt on the real grid
  // once GPU init settles the client layout (below).
  const sim: Sim = {
    world: initWorld(Date.now(), ATTRACT_CONFIG),
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
    // GPU init done → the browser has settled the client layout sizing.
    updateGridDimensions(canvas);
    sim.world = initWorld(Date.now(), ATTRACT_CONFIG);
    startRuntime(renderer, overlay, ui, welcome, sim, audio);
  } catch (e: unknown) {
    ui.showError(
      e instanceof Error
        ? `${e.message} — try Chrome/Edge 113+, or Safari 18+ with WebGPU enabled.`
        : String(e),
    );
  }
};

void main();
