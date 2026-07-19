import { expect, test } from "bun:test";
import type { LightCycle, MatchConfig, World } from "~/world";
import { initArcadeWorld, update } from "~/world";
import { ARCADE_TIERS, NOVA_FUEL_COST, SCORE_KILL } from "~/world/tuning";

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

// Orient the pilot at a known spot facing +x with the Nova augment + fuel, and
// plant three orange enemies: one in the forward cone, one directly behind, one
// out of reach ahead.
const scene = (novaStacks: number, fuel: number): [World, number, number[]] => {
  let w = initArcadeWorld(42, arcadeConfig());
  // biome-ignore lint/style/noNonNullAssertion: arcade world always has a pilot
  const pilotId = w.controlledShipId!;
  const oriented = w.ships.items.map((s) =>
    s.id === pilotId ? { ...s, x: 100, y: 75, dx: 1, dy: 0, fuel } : s,
  );
  // biome-ignore lint/style/noNonNullAssertion: pilot is in the list
  const pilot = oriented.find((s) => s.id === pilotId)!;
  const enemy = (id: number, x: number, y: number, hp: number): LightCycle => ({
    ...pilot,
    id,
    colorName: "orange",
    x,
    y,
    hp,
    shield: 0,
    invulnTime: 0,
  });
  const n = w.ships.nextId;
  const front = enemy(n, 120, 75, 1); // in cone, low hp → dies
  const behind = enemy(n + 1, 80, 75, 5); // opposite the facing → spared
  const far = enemy(n + 2, 180, 75, 5); // beyond reach → spared
  w = {
    ...w,
    // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
    arcade: { ...w.arcade!, augments: { nova: novaStacks } },
    ships: { items: [...oriented, front, behind, far], nextId: n + 3 },
  };
  return [w, pilotId, [n, n + 1, n + 2]];
};

test("Nova clears enemies in the forward cone, spares those outside it", () => {
  let [w, pilotId, [front, behind, far]] = scene(1, 1400);
  w = update({ kind: "action", actionId: 9 }, w);

  const ids = new Set(w.ships.items.map((s) => s.id));
  expect(ids.has(front)).toBe(false); // in-cone enemy destroyed
  expect(ids.has(behind)).toBe(true); // behind the pilot — untouched
  expect(ids.has(far)).toBe(true); // out of reach — untouched
  const pilot = w.ships.items.find((s) => s.id === pilotId);
  expect(pilot?.fuel).toBe(1400 - NOVA_FUEL_COST); // fuel spent
  expect(w.score.cyan).toBeGreaterThanOrEqual(SCORE_KILL); // kill scored
});

test("Nova is inert without the augment (no fuel spent)", () => {
  let [w, pilotId, [front]] = scene(0, 1400);
  w = update({ kind: "action", actionId: 9 }, w);
  const ids = new Set(w.ships.items.map((s) => s.id));
  expect(ids.has(front)).toBe(true); // nothing happened
  expect(w.ships.items.find((s) => s.id === pilotId)?.fuel).toBe(1400);
});

test("Nova needs enough fuel to fire", () => {
  let [w, pilotId, [front]] = scene(1, NOVA_FUEL_COST - 1);
  w = update({ kind: "action", actionId: 9 }, w);
  expect(w.ships.items.some((s) => s.id === front)).toBe(true); // no blast
  expect(w.ships.items.find((s) => s.id === pilotId)?.fuel).toBe(
    NOVA_FUEL_COST - 1,
  );
});
