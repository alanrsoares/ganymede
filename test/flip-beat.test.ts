// The all-range flip beat (#31): mid-stage the scroll stops, the corridor
// closes into the toroidal arena, the ambush is fought, and the corridor
// resumes from exactly where it stopped.

import { afterEach, expect, test } from "bun:test";
import type { Seed } from "~/engine/rng";
import {
  ARENA,
  CENTER_PAD,
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  FLIP_HALT_GENS,
  FLIP_RESUME_GENS,
  hasArenaFurniture,
  hasBaseObjective,
  initArcadeWorld,
  type MatchConfig,
  OVERCHARGE_KIND,
  SCROLL_RATE,
  type StageFlip,
  type StageScript,
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

const withFlip = (flip: StageFlip = beat): StageScript => ({
  name: "test",
  entries: [],
  flips: [flip],
});

const flipConfig = (stage: StageScript): MatchConfig => ({
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
    stage,
  },
});

const flipWorld = (stage: StageScript = withFlip()): World => {
  const w = initArcadeWorld(7 as Seed, flipConfig(stage));
  syncField(w);
  // No scenery: a ship that flies into an asteroid is a different test.
  return {
    ...w,
    asteroids: { items: [], nextId: 1 },
    pickups: { items: [], nextId: 1 },
  };
};

/** Tick until the beat claims the stage: the brake, before any of the arena. */
const flyToHalt = (w: World, limit = 2000): World => {
  let out = w;
  for (let i = 0; i < limit; i++) {
    out = tick(out, 1, 16 * i);
    if (out.flip) return out;
  }
  throw new Error("the flip never opened");
};

/** Tick on through the brake, so a test can inspect act two itself. */
const flyToFight = (w: World, limit = 2000): World => {
  let out = flyToHalt(w, limit);
  for (let i = 0; i < limit; i++) {
    if (out.flip?.phase === "fight") return out;
    out = tick(out, 1, 16 * i);
  }
  throw new Error("the brake never landed");
};

test("the scroll halts at the authored distance", () => {
  const open = flyToFight(flipWorld());
  expect(open.flip?.banner).toBe("ALL-RANGE MODE");
  // Forward is -y, so travelled is -scrollY; the beat opens the tick it is
  // reached and the stage brakes to a stop just past it.
  expect(-open.scrollY).toBeGreaterThanOrEqual(beat.at);
  const held = tick(open, 30, 16);
  expect(held.scrollY).toBeCloseTo(open.scrollY, 9);
});

test("the window closes into exactly today's arena, in place", () => {
  const open = flyToFight(flipWorld());
  expect(ARENA).toMatchObject({
    x0: 0,
    y0: open.scrollY,
    w: DEFAULT_GRID_W,
    h: DEFAULT_GRID_H,
    wrapX: true,
    wrapY: true,
  });
});

test("the ambush is waiting inside the window, not beyond it", () => {
  const open = flyToFight(flipWorld());
  const ids = open.flip?.ids ?? [];
  expect(ids).toHaveLength(3);
  for (const s of open.ships.items.filter((s) => ids.includes(s.id))) {
    expect(s.y).toBeGreaterThanOrEqual(open.scrollY);
    expect(s.y).toBeLessThanOrEqual(open.scrollY + DEFAULT_GRID_H);
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.x).toBeLessThanOrEqual(DEFAULT_GRID_W);
  }
});

test("the ring of furniture re-centres on the window", () => {
  const open = flyToFight(flipWorld());
  // The arena's centre pad is the star everything orbits. On a stage it sits a
  // stage-length away; during the beat it is back in the middle of the screen.
  expect(CENTER_PAD.y).toBeCloseTo(open.scrollY + DEFAULT_GRID_H / 2, 0);
  expect(hasArenaFurniture(open)).toBe(true);
  // ...as terrain. The raid it carries in the arena stays off on a stage.
  expect(hasBaseObjective(open)).toBe(false);
});

test("wiping the ambush resumes the corridor where it stopped", () => {
  const open = flyToFight(flipWorld());
  const ids = open.flip?.ids ?? [];
  const wiped: World = {
    ...open,
    ships: {
      ...open.ships,
      items: open.ships.items.filter((s) => !ids.includes(s.id)),
    },
  };
  // The torus opens back into a corridor the moment the fight is settled...
  const resumed = tick(wiped, 1, 16);
  expect(resumed.flip?.phase).toBe("resume");
  expect(ARENA.wrapY).toBe(false);

  // ...and the corridor winds back up to rate rather than snapping to it, so
  // the wind-up covers less ground than a full-rate run of the same length.
  let out = resumed;
  for (let i = 0; i < FLIP_RESUME_GENS; i++) out = tick(out, 1, 16 * i);
  expect(out.flip).toBeNull();
  const travelled = open.scrollY - out.scrollY;
  expect(travelled).toBeGreaterThan(0);
  expect(travelled).toBeLessThan(SCROLL_RATE * FLIP_RESUME_GENS);
  // Back at full rate once the beat is done with.
  const after = tick(out, 1, 16);
  expect(after.scrollY).toBeCloseTo(out.scrollY - SCROLL_RATE, 9);
});

test("the failsafe cap ends a beat nothing can finish", () => {
  const open = flyToFight(flipWorld());
  // Nobody touches the ambush: only the cap can close this.
  let out = open;
  const span = beat.maxGens + FLIP_RESUME_GENS + 2;
  for (let i = 0; i < span; i++) out = tick(out, 1, 16 * i);
  expect(out.flip).toBeNull();
  expect(out.scrollY).toBeLessThan(open.scrollY);
});

test("a beat plays once — the cursor never rereads it", () => {
  const open = flyToFight(flipWorld());
  expect(open.flipCursor).toBe(1);
  let out = open;
  for (let i = 0; i < beat.maxGens + 600; i++) out = tick(out, 1, 16 * i);
  expect(out.flip).toBeNull();
  expect(out.flipCursor).toBe(1);
});

test("the corridor ahead is cleared, so nothing wraps in from nowhere", () => {
  // A formation forms up beyond the leading edge, inside the cull margin — it
  // is out of shot but still alive. With both axes closing it would otherwise
  // fold in from the opposite edge, a ship materialising on screen with no
  // run-in. Flown to the last tick of the brake — the corridor is cleared when
  // the topology actually closes, not when the beat is claimed — then given a
  // straggler ahead of the window and one in the wake.
  let w = flyToHalt(flipWorld());
  while ((w.flip?.gens ?? 0) < FLIP_HALT_GENS - 1) w = tick(w, 1, 16);
  const pilot = w.ships.items[0];
  const ahead = { ...pilot, id: 900, colorName: "orange", y: w.scrollY - 40 };
  const wake = { ...pilot, id: 901, colorName: "orange", y: w.scrollY + 300 };
  const open = tick(
    { ...w, ships: { items: [...w.ships.items, ahead, wake], nextId: 902 } },
    1,
    16,
  );

  expect(open.flip?.phase).toBe("fight");
  const ids = open.ships.items.map((s) => s.id);
  expect(ids).not.toContain(900);
  expect(ids).not.toContain(901);
  // The pilot and the beat's own ambush are what act two is fought with.
  expect(ids).toContain(pilot.id);
  for (const id of open.flip?.ids ?? []) expect(ids).toContain(id);
});

test("a formation cleared for the beat owes no reward", () => {
  // Its ships were never shot down — the beat made room for itself. The wake
  // test in `escaped` can't catch this one: the formation was *ahead* of the
  // window, so without dropping the debt it pays out for nothing.
  //
  // Planted by hand at the last tick of the brake: an authored formation has
  // the whole brake to fly into shot, and one that arrives in time is act two's
  // cast rather than something the beat cleared.
  let w = flyToHalt(flipWorld());
  while ((w.flip?.gens ?? 0) < FLIP_HALT_GENS - 1) w = tick(w, 1, 16);
  const pilot = w.ships.items[0];
  const ahead = { ...pilot, id: 900, colorName: "orange", y: w.scrollY - 40 };
  const open = tick(
    {
      ...w,
      ships: { items: [...w.ships.items, ahead], nextId: 901 },
      stageDrops: [
        { ids: [900], kind: OVERCHARGE_KIND, x: ahead.x, y: ahead.y },
      ],
    },
    1,
    16,
  );
  expect(open.flip?.phase).toBe("fight");
  expect(open.ships.items.map((s) => s.id)).not.toContain(900);
  expect(open.stageDrops).toHaveLength(0);

  // Wipe the ambush and let the corridor resume: the debt stays settled, and
  // `resolveDrops` pays out of nothing else. (Bare pickup count won't do — the
  // scenery pool refills itself as the stage flies.)
  const ids = open.flip?.ids ?? [];
  let out: World = {
    ...open,
    ships: {
      ...open.ships,
      items: open.ships.items.filter((s) => !ids.includes(s.id)),
    },
  };
  for (let i = 0; i < FLIP_RESUME_GENS + 2; i++) out = tick(out, 1, 16 * i);
  expect(out.flip).toBeNull();
  expect(out.stageDrops).toHaveLength(0);
});

test("a beat still closes if the script goes away under it", () => {
  const open = flyToFight(flipWorld());
  // Same run, script dropped mid-beat. Closing must not need it: a held scroll
  // with no way back to the corridor is a hung run.
  const ids = open.flip?.ids ?? [];
  const run = flipConfig(withFlip()).run;
  const orphaned: World = {
    ...open,
    config: { ...open.config, run: run && { ...run, stage: undefined } },
    ships: {
      ...open.ships,
      items: open.ships.items.filter((s) => !ids.includes(s.id)),
    },
  };
  let out = tick(orphaned, 1, 16);
  expect(out.flip?.phase).toBe("resume");
  for (let i = 0; i < FLIP_RESUME_GENS; i++) out = tick(out, 1, 16 * i);
  expect(out.flip).toBeNull();
});

test("a stage with no flips never leaves the corridor", () => {
  let w = flipWorld({ name: "test", entries: [] });
  for (let i = 0; i < 400; i++) w = tick(w, 1, 16 * i);
  expect(w.flip).toBeNull();
  expect(ARENA.wrapY).toBe(false);
});
