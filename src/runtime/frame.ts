// Per-frame runtime helpers: the mutable loop/sim state, the fixed-timestep
// stepping + staggered deploy, match/run end handling, and the render + HUD
// sync. Pure glue between the immutable World and the imperative renderer/DOM.

import type { CameraView, Renderer } from "~/render/gpu";
import type { Overlay } from "~/render/overlay";
import type { Lobby } from "~/ui/arcade-lobby";
import type { Setup } from "~/ui/setup";
import type { Ui } from "~/ui/ui";
import {
  ARENA,
  BURST_EXPLOSION,
  initArcadeWorld,
  initWorld,
  type MatchConfig,
  type Msg,
  setOrbitPhase,
  type World,
} from "~/world";
import { augmentTier } from "~/world/augments";
import { updateGridDimensions } from "./input";

// Staggered launch muster: a new match starts with an empty arena and deploys
// its fleet one ship at a time, this many seconds apart, from the bases.
export const DEPLOY_INTERVAL_S = 0.17;

// The mutable runtime state shared between the UI handlers and the render loop:
// the current immutable world plus the two live-tunable rates. A starter swaps
// the whole world; ticks swap it each frame via `dispatch`.
export interface Sim {
  world: World;
  simRate: number;
  reinforceRate: number;
}

// Mutable state carried between successive loop frames, threaded through the
// per-frame helpers below.
export interface LoopState {
  gen: number;
  resetScheduled: boolean;
  shake: number;
  lastBoomId: number;
  prevAge: number;
  deployRemaining: number; // launch-fleet ships still to muster in
  deployTimer: number; // seconds until the next muster spawn
}

export const initLoopState = (): LoopState => ({
  gen: 0,
  resetScheduled: false,
  shake: 0,
  lastBoomId: 0,
  prevAge: 0,
  deployRemaining: 0,
  deployTimer: 0,
});

// Advance the fixed-timestep sim by however many ticks have accumulated, and
// fire the periodic reinforcement spawn.
export const stepSimulation = (
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
export const stepDeploy = (
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
// next starter clears it, so this fires exactly once per match.
export const handleMatchEnd = (
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

// Arcade run end: the pilot burned their last life. Show a game-over line once,
// then reopen the lobby to pick a hull and try again. Mirrors handleMatchEnd's
// latch so it fires exactly once per run.
export const handleArcadeEnd = (
  world: World,
  ui: Ui,
  state: LoopState,
  lobby: Lobby,
) => {
  const a = world.arcade;
  if (a?.over && !state.resetScheduled) {
    state.resetScheduled = true;
    ui.banner.val = `GAME OVER — wave ${a.wave} · ${a.kills} kills`;
    setTimeout(() => {
      ui.banner.val = "";
      lobby.show();
    }, 3600);
  }
};

// Build this frame's instance buffers from the World and hand them to the GPU
// renderer.
export const buildAndRender = (
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
  const frame = overlay.build({
    w: canvas.width,
    h: canvas.height,
    gridW: ARENA.w,
    gridH: ARENA.h,
    now,
    world,
    showHp,
  });
  renderer.render(frame, now / 1000, camera);
};

// Screen shake: each fresh explosion punches the canvas; it decays fast.
// Burst ids are monotonic per match; a reset (age rewinds) clears the mark.
export const updateScreenShake = (
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

// The HUD status/phase line for the current world (arcade wave/lives, autobattle
// reinforce/sudden-death, or endless).
const getHudPhaseText = (world: World): string => {
  const a = world.arcade;
  if (a) {
    const tier = augmentTier(a.augments);
    const mk = tier > 0 ? ` · Mk ${tier}` : ""; // prestige readout past L5
    return a.over
      ? "game over"
      : `wave ${a.wave} · ${a.waveRemaining + a.pending} enemies${mk}`;
  }
  if (world.winner) return "match over";
  if (world.config.format === "endless") return "endless";
  const remain = world.config.reinforceGens - world.age;
  return remain > 0
    ? `reinforce ${Math.ceil(remain / world.config.tempo)}s`
    : "sudden death";
};

// Push per-frame world state into the reactive HUD handles.
export const updateHud = (ui: Ui, world: World) => {
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
  ui.controlledShip.val =
    world.controlledShipId !== null
      ? world.ships.items.find((s) => s.id === world.controlledShipId) || null
      : null;
  ui.arcadeLives.val =
    world.arcade && !world.arcade.over ? world.arcade.lives : null;
};

// Track the canvas backing size; when the client box changes, re-derive the grid
// bounds and resize the renderer. Owns its own last-size state so the loop stays
// a one-line call.
export const createResizeSync = (
  renderer: Renderer,
  canvas: HTMLCanvasElement,
) => {
  let lastW = 0;
  let lastH = 0;
  return () => {
    if (canvas.clientWidth === lastW && canvas.clientHeight === lastH) return;
    lastW = canvas.clientWidth;
    lastH = canvas.clientHeight;
    updateGridDimensions(canvas);
    renderer.resize();
  };
};

// The two match launchers, sharing the runtime's mutable Sim + loop state. Both
// swap in a fresh world and reset the per-match rates; autobattle musters its
// fleet in staggered (stepDeploy), arcade spawns the controlled pilot outright.
export const createStarters = (sim: Sim, ui: Ui, loopState: LoopState) => {
  const reset = (cfg: MatchConfig) => {
    sim.simRate = cfg.tempo;
    ui.activeTeamCount.val = cfg.teams;
    ui.banner.val = "";
    loopState.resetScheduled = false;
  };
  const startMatch = (cfg: MatchConfig) => {
    sim.world = initWorld(Date.now(), { ...cfg, initialShips: 0 });
    sim.reinforceRate = cfg.reinforceRate;
    reset(cfg);
    ui.hudTitle.val = "Autobattle";
    ui.setSimKnobsHidden(false);
    loopState.deployRemaining = cfg.initialShips;
    loopState.deployTimer = DEPLOY_INTERVAL_S;
  };
  const startArcadeMatch = (cfg: MatchConfig) => {
    sim.world = initArcadeWorld(Date.now(), cfg);
    sim.reinforceRate = 0;
    reset(cfg);
    // Arcade: the stage/wave sets tempo + spawns, so hide the sim knobs.
    const diff = cfg.arcade?.difficulty ?? "normal";
    ui.hudTitle.val = `Arcade — ${diff[0].toUpperCase()}${diff.slice(1)}`;
    ui.setSimKnobsHidden(true);
    loopState.deployRemaining = 0;
    loopState.deployTimer = 0;
  };
  return { startMatch, startArcadeMatch };
};
