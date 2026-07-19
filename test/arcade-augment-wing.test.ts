import { expect, test } from "bun:test";
import type { MatchConfig, World } from "~/world";
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

const drones = (w: World) =>
  w.ships.items.filter(
    (s) => s.droneShip && s.colorName === "cyan" && s.id !== w.controlledShipId,
  );

const withWing = (stacks: number): World => {
  const w = initArcadeWorld(42, arcadeConfig());
  // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
  return { ...w, arcade: { ...w.arcade!, augments: { wing: stacks } } };
};

test("the Wing augment musters an escort drone", () => {
  let w = withWing(1);
  expect(drones(w).length).toBe(0);
  w = tick(w, 1, 16); // wingCd starts at 0 → drone spawns this tick
  expect(drones(w).length).toBe(1);
});

test("the wing replaces a fallen drone once its cooldown elapses", () => {
  let w = tick(withWing(1), 1, 16); // staff the first drone (sets wingCd)
  expect(drones(w).length).toBe(1);
  // The drone falls; force its respawn cooldown ready.
  w = {
    ...w,
    // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
    arcade: { ...w.arcade!, wingCd: 0 },
    ships: {
      ...w.ships,
      items: w.ships.items.filter(
        (s) => !(s.droneShip && s.colorName === "cyan"),
      ),
    },
  };
  expect(drones(w).length).toBe(0);
  w = tick(w, 1, 32);
  expect(drones(w).length).toBe(1); // replaced
});

test("no escorts without the augment", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  w = tick(w, 1, 16);
  w = tick(w, 1, 32);
  expect(drones(w).length).toBe(0);
});
