// The punctuation the flip beat (#31) shipped without: the corridor brakes into
// the beat and winds back out of it, and the beat announces itself with a line.
// The topology swap was flown on its own first — this is what #32 needs before
// the gear change can be judged at all.

import { afterEach, expect, test } from "bun:test";
import type { Seed } from "~/engine/rng";
import { handleFlipBanner, initLoopState } from "~/runtime/frame";
import { signal } from "~/ui/signal";
import type { Ui } from "~/ui/ui";
import {
  ARENA,
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  FLIP_HALT_GENS,
  hasArenaFurniture,
  initArcadeWorld,
  type MatchConfig,
  SCROLL_RATE,
  type StageFlip,
  scrollFactor,
  setGridBounds,
  syncField,
  type World,
} from "~/world";
import { tick } from "~/world/tick";
import { DEFAULT_CONFIG } from "~/world/tuning";

afterEach(() => setGridBounds(DEFAULT_GRID_W, DEFAULT_GRID_H));

const beat: StageFlip = {
  at: 60,
  banner: "ALL-RANGE MODE",
  maxGens: 400,
  spawns: [{ x: 240, y: 60, shape: "line", count: 3, hull: "scout", level: 1 }],
};

const flipConfig = (): MatchConfig => ({
  ...DEFAULT_CONFIG,
  format: "scroll",
  run: {
    playerRole: "pilot",
    difficulty: "normal",
    playerTeam: "cyan",
    playerArchetype: "fighter",
    victory: { kind: "none" },
    defeat: { kind: "lives", count: 3 },
    enemyTeams: ["orange"],
    stage: { name: "test", entries: [], flips: [beat] },
  },
});

const flipWorld = (): World => {
  const w = initArcadeWorld(7 as Seed, flipConfig());
  syncField(w);
  return { ...w, asteroids: { items: [], nextId: 1 } };
};

const flyToHalt = (w: World, limit = 2000): World => {
  let out = w;
  for (let i = 0; i < limit; i++) {
    out = tick(out, 1, 16 * i);
    if (out.flip) return out;
  }
  throw new Error("the flip never opened");
};

test("the corridor brakes into the beat instead of cutting to a stop", () => {
  let w = flyToHalt(flipWorld());
  let prev = w.scrollY;
  let lastStep = Infinity;
  for (let i = 0; i < FLIP_HALT_GENS - 1; i++) {
    w = tick(w, 1, 16 * i);
    const step = prev - w.scrollY;
    // Still moving, and never faster than the tick before: a brake, not a cut.
    expect(step).toBeGreaterThanOrEqual(0);
    expect(step).toBeLessThanOrEqual(lastStep + 1e-9);
    expect(step).toBeLessThanOrEqual(SCROLL_RATE + 1e-9);
    lastStep = step;
    prev = w.scrollY;
  }
  // The brake is still the corridor: the arena arrives with the stop, not
  // before it, or the pilot is wrapping across edges that are still sliding.
  expect(w.flip?.phase).toBe("halt");
  expect(ARENA.wrapX).toBe(false);
  expect(ARENA.wrapY).toBe(false);
  expect(hasArenaFurniture(w)).toBe(false);
});

test("the ambush is not planted until the window has stopped", () => {
  const halt = flyToHalt(flipWorld());
  expect(halt.flip?.ids).toHaveLength(0);
  const during = tick(halt, 1, 16);
  expect(during.flip?.phase).toBe("halt");
  // Nothing has been spawned into a window that is still moving under it.
  expect(during.ships.items).toHaveLength(halt.ships.items.length);
});

test("the ease is a stopped stage at the ends, and nothing past them", () => {
  const base = { maxGens: 400, banner: "X", spawns: [], ids: [] } as const;
  expect(scrollFactor(null)).toBe(1);
  expect(scrollFactor({ ...base, phase: "halt", gens: 0 })).toBeCloseTo(1, 9);
  expect(scrollFactor({ ...base, phase: "halt", gens: 999 })).toBeCloseTo(0, 9);
  expect(scrollFactor({ ...base, phase: "fight", gens: 5 })).toBe(0);
  expect(scrollFactor({ ...base, phase: "resume", gens: 0 })).toBeCloseTo(0, 9);
  expect(scrollFactor({ ...base, phase: "resume", gens: 999 })).toBeCloseTo(
    1,
    9,
  );
});

// --- the banner -------------------------------------------------------------
// `handleFlipBanner` only ever touches `ui.banner`, so the HUD it needs is one
// signal: the rest of the Ui surface has nothing to do with the beat.

const bannerUi = () => {
  const banner = signal("");
  return { ui: { banner } as unknown as Ui, banner };
};

const halted = (w: World, gens: number): World => ({
  ...w,
  flip: {
    phase: "halt",
    gens,
    maxGens: beat.maxGens,
    banner: beat.banner,
    spawns: beat.spawns,
    ids: [],
  },
});

test("the beat's line goes up with the brake and comes down in the fight", () => {
  const { ui, banner } = bannerUi();
  const state = initLoopState();
  const w = flipWorld();

  handleFlipBanner(w, ui, state);
  expect(banner.val).toBe("");

  handleFlipBanner(halted(w, 4), ui, state);
  expect(banner.val).toBe("ALL-RANGE MODE");

  // Held briefly into act two, then out of the way of the fight it announced.
  const fighting = (gens: number): World => ({
    ...w,
    flip: { ...halted(w, 0).flip!, phase: "fight", gens, ids: [2] },
  });
  handleFlipBanner(fighting(10), ui, state);
  expect(banner.val).toBe("ALL-RANGE MODE");
  handleFlipBanner(fighting(400), ui, state);
  expect(banner.val).toBe("");
});

test("the beat never writes over a banner it does not own", () => {
  const { ui, banner } = bannerUi();
  const state = initLoopState();
  const w = flipWorld();

  // A run that ends mid-beat: the game-over line owns the slot and its own
  // timeout clears it, so the beat must neither post over it nor wipe it.
  handleFlipBanner(halted(w, 4), ui, state);
  banner.val = "GAME OVER";
  const over: World = {
    ...halted(w, 5),
    run: w.run && { ...w.run, over: true },
  };
  handleFlipBanner(over, ui, state);
  expect(banner.val).toBe("GAME OVER");
});
