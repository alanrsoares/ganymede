import { expect, test } from "bun:test";
import type { LightCycle, MatchConfig, World } from "~/world";
import { initArcadeWorld } from "~/world";
import { tick } from "~/world/tick";
import { ARCADE_TIERS } from "~/world/tuning";

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

// Ready the pilot to fire this tick: hold space and clear its cooldown.
const armPilot = (w: World): World => ({
  ...w,
  controlKeys: { ...w.controlKeys, space: true },
  ships: {
    ...w.ships,
    items: w.ships.items.map((s: LightCycle) =>
      s.id === w.controlledShipId ? { ...s, fireCooldown: 0 } : s,
    ),
  },
});

test("baseline pilot fire is the fighter's 2 parallel barrels", () => {
  let w = armPilot(initArcadeWorld(42, arcadeConfig()));
  const pilot = w.controlledShipId;
  w = tick(w, 1, 16);
  const fired = w.bullets.items.filter((b) => b.owner === pilot);
  expect(fired.length).toBe(2);
});

test("the Spread augment fans extra barrels into a diverging cone", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  w = {
    ...w,
    // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
    arcade: { ...w.arcade!, augments: { spread: 2 } },
  };
  w = armPilot(w);
  const pilot = w.controlledShipId;

  w = tick(w, 1, 16);
  const fired = w.bullets.items.filter((b) => b.owner === pilot);
  // fighter's 2 barrels + 2 Spread stacks = 4 bolts…
  expect(fired.length).toBe(4);
  // …and they diverge (a real cone, not a parallel wall of equal angles).
  const angles = fired.map((b) => b.angle);
  expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(0.1);
});
