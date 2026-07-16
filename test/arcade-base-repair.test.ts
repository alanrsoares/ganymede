import { expect, test } from "bun:test";
import type { MatchConfig } from "~/world";
import { initArcadeWorld } from "~/world";
import { tick } from "~/world/tick";
import { createTickCtx, damageBase } from "~/world/tick/context";
import { ARCADE_TIERS, BASE_MAX_HP } from "~/world/tuning";
import { MUSTER_KIND } from "~/world/types";

const arcadeConfig = (): MatchConfig => {
  const tier = ARCADE_TIERS.normal;
  return {
    teams: 3,
    initialShips: 0,
    reinforceRate: 0,
    tempo: 52,
    reinforceGens: 0,
    format: "arcade",
    arcade: {
      playerRole: "pilot",
      difficulty: "normal",
      playerTeam: "cyan",
      playerArchetype: "fighter",
      victory: { kind: "none" },
      defeat: { kind: "lives", count: tier.lives },
      waves: {
        intermissionMinGens: tier.intermissionGens,
        spawn: tier.spawn,
      },
      enemyTeams: ["orange", "emerald"],
    },
  };
};

test("arcade player base floors at 1 HP; enemy bases still raze to 0", () => {
  const w = initArcadeWorld(42, arcadeConfig());
  const ctx = createTickCtx(w, 1, 0);
  damageBase(ctx, "cyan", 999);
  damageBase(ctx, "orange", 999);
  expect(ctx.baseHp.cyan).toBe(1);
  expect(ctx.baseHp.orange).toBe(0);
});

// Regression: arcade configs set reinforceGens to 0, which flags every tick as
// sudden death — the sudden-death guard in dockAtHomeBase silently disabled
// base repair for the whole mode.
test("docked pilot repairs the home base in arcade", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  w = { ...w, baseHp: { ...w.baseHp, cyan: 5 } };

  // The pilot spawns docked; idle ticks should climb base HP, not stall it.
  let now = 0;
  for (let i = 0; i < 40; i++) {
    now += 16;
    w = tick(w, 1, now);
  }
  expect(w.baseHp.cyan).toBeGreaterThan(5);
});

test("wave clear restores the player base to full", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  if (!w.arcade) throw new Error("arcade state missing");
  // Pretend a wave was mustered and the last enemy just fell: no enemy ships
  // on the field, waveRemaining still > 0 → the next tick clears the wave.
  w = {
    ...w,
    baseHp: { ...w.baseHp, cyan: 5 },
    arcade: { ...w.arcade, waveRemaining: 3 },
  };
  const wave = w.arcade?.wave ?? 0;

  w = tick(w, 1, 16);

  expect(w.arcade?.wave).toBe(wave + 1);
  expect(w.baseHp.cyan).toBe(BASE_MAX_HP);
});

test("muster pickup spawns two pint-sized scout drone ships", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  const me = w.ships.items[0];
  w = {
    ...w,
    pickups: {
      items: [
        { id: 1, x: me.x, y: me.y, vx: 0, vy: 0, kind: MUSTER_KIND, bob: 0 },
      ],
      nextId: 2,
    },
  };

  w = tick(w, 1, 16);

  const escorts = w.ships.items.filter(
    (s) => s.colorName === "cyan" && s.id !== w.controlledShipId,
  );
  expect(escorts.length).toBe(2);
  for (const e of escorts) {
    expect(e.archetype).toBe("scout");
    expect(e.droneShip).toBe(true);
  }
});
