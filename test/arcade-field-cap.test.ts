import { expect, test } from "bun:test";
import { cap, capExcept, type Entity } from "~/engine/entities";
import type { MatchConfig } from "~/world";
import { initArcadeWorld } from "~/world";
import { tick } from "~/world/tick";
import {
  ARCADE_TIERS,
  MAX_ARCADE_SHIPS,
  MAX_ENEMY_SHIPS,
} from "~/world/tuning";

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

const list = (...ids: number[]) => ({
  items: ids.map((id): Entity => ({ id })),
  nextId: Math.max(0, ...ids) + 1,
});

test("capExcept keeps protected ships and drops the oldest unprotected", () => {
  const l = list(1, 2, 3, 4, 5);
  // Protect the oldest (id 1): it stays, the next-oldest unprotected go.
  expect(capExcept(l, 3, (s) => s.id === 1).items.map((s) => s.id)).toEqual([
    1, 4, 5,
  ]);
});

test("capExcept with no protection is identical to cap", () => {
  const l = list(1, 2, 3, 4, 5);
  expect(capExcept(l, 3, () => false).items).toEqual(cap(l, 3).items);
});

test("capExcept never drops protected even when they exceed the cap", () => {
  const l = list(1, 2, 3, 4, 5);
  // ids 1-3 protected, cap 2: all three protected survive, unprotected 4,5 go.
  expect(capExcept(l, 2, (s) => s.id <= 3).items.map((s) => s.id)).toEqual([
    1, 2, 3,
  ]);
});

// Regression: at high waves the requested enemy count exceeds the on-field
// budget. The wave must spawn up to MAX_ENEMY_SHIPS and hold the rest in
// `pending` — never overflowing the array cap, never inflating kills.
test("oversized waves clamp to the enemy budget and reserve the remainder", () => {
  const count = ARCADE_TIERS.normal.spawn(20).count;
  expect(count).toBeGreaterThan(MAX_ENEMY_SHIPS); // precondition: wave overflows

  let w = initArcadeWorld(42, arcadeConfig());
  const pilot = w.controlledShipId;
  w = {
    ...w,
    // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
    arcade: { ...w.arcade!, wave: 20, waveRemaining: 0, pending: 0 },
  };

  w = tick(w, 1, 16);

  const enemies = w.ships.items.filter((s) => s.colorName !== "cyan");
  const a = w.arcade;
  expect(a).not.toBeNull();
  // On-field enemies clamped to the budget; the rest wait in reserve.
  expect(enemies.length).toBe(MAX_ENEMY_SHIPS);
  expect(a?.pending).toBe(count - MAX_ENEMY_SHIPS);
  // Array cap respected; the pilot is still on the field.
  expect(w.ships.items.length).toBeLessThanOrEqual(MAX_ARCADE_SHIPS);
  expect(w.ships.items.some((s) => s.id === pilot)).toBe(true);
  // Nothing died, so no phantom kills were banked by the muster.
  expect(a?.kills).toBe(0);
});
