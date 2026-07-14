// Runtime shell bootstrap: owns the canvas, GPU init, and the fixed-timestep
// loop that ports the pure World into the renderer. The imperative edges live in
// runtime/input.ts (DOM events) and runtime/frame.ts (stepping + render/HUD).

import { type Lobby, mountArcadeLobby } from "./arcade-lobby";
import { createAccumulator, createLoop } from "./engine/loop";
import { createRenderer, loadCycleTextures, type Renderer } from "./gpu";
import { acquireGpu } from "./gpu-context";
import { mountMixer } from "./mixer";
import { mountMobileControls } from "./mobileControls";
import { createOverlay, type Overlay } from "./overlay";
import { type Audio, createAudio, type Scene } from "./runtime/audio";
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
} from "./runtime/frame";
import { updateGridDimensions, wireInput } from "./runtime/input";
import { mountSetup } from "./setup";
import { rgbCss } from "./shipInfo";
import { mountUi, type Ui } from "./ui";
import { mountWelcome, type Welcome } from "./welcome";
import {
  initWorld,
  type MatchConfig,
  type Msg,
  TEAMS,
  update,
  type World,
} from "./world";
import { DEFAULT_CONFIG } from "./world/factory";

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
const wireTouchControls = (dispatch: (msg: Msg) => void, ui: Ui) =>
  mountMobileControls({
    controlledShip: ui.controlledShip,
    onKeys: (k) => dispatch({ kind: "controlKeys", ...k }),
    onAction: (id) => dispatch({ kind: "action", actionId: id }),
  });

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

  const setup = mountSetup(startMatch, { startHidden: true });
  const lobby = mountArcadeLobby(startArcadeMatch, { startHidden: true });
  const codex = wireInput(
    canvas,
    renderer,
    dispatch,
    ui,
    () => sim.world,
    () => setup.isOpen() || lobby.isOpen(),
    audio,
  );
  // On-screen stick/fire/abilities for touch devices — the same intent the
  // keyboard emits, so the sim is unchanged. No-op on pointer devices.
  wireTouchControls(dispatch, ui);
  // Keep the welcome splash clean; reveal all chrome together on launch.
  codex.setChromeHidden(true);
  // The welcome CTA is the first user gesture — the only moment the browser lets
  // us start the AudioContext.
  let begun = false;
  welcome.begun.then((mode) => {
    begun = true;
    audio.resume();
    revealForMode(mode, lobby, setup, ui, codex);
  });

  const syncCanvasSize = createResizeSync(renderer, canvas);
  const loop = createLoop((dt, now) => {
    syncCanvasSize();
    // The codex/guide panel pauses the sim: while it's open we still render the
    // frozen world (and skip accumulating dt, so resume doesn't fast-forward).
    if (!codex.isOpen()) {
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
      welcome.camera,
    );
    updateScreenShake(canvas, sim.world, now, loopState);
    updateHud(ui, sim.world);
    // setScene is idempotent, so calling it each frame is fine.
    const inMatch = begun && !setup.isOpen() && !lobby.isOpen();
    audio.setScene(sceneFor(sim.world, inMatch));
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
