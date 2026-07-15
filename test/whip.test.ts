import { expect, test } from "bun:test";
import type { LightCycle, MatchConfig } from "~/world";
import { initArcadeWorld, update } from "~/world";
import { tick } from "~/world/tick";
import { ARCADE_TIERS, WHIP_FUEL_COST, WHIP_LIFE } from "~/world/tuning";

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
      waves: { intermissionMinGens: tier.intermissionGens, spawn: tier.spawn },
      enemyTeams: ["orange", "emerald"],
    },
  };
};

const pilotOf = (w: ReturnType<typeof initArcadeWorld>): LightCycle => {
  const p = w.ships.items.find((s) => s.id === w.controlledShipId);
  if (!p) throw new Error("no pilot");
  return p;
};

// Isolate the arena to just the pilot + one enemy clone parked a few cells off
// the pilot's nose, so the lash unambiguously aims at and lands on it.
const pilotVsEnemy = (
  w: ReturnType<typeof initArcadeWorld>,
  offset: number,
): ReturnType<typeof initArcadeWorld> => {
  const p = pilotOf(w);
  const enemy: LightCycle = {
    ...p,
    id: 9001,
    colorName: "orange",
    x: p.x + p.dx * offset,
    y: p.y + p.dy * offset,
    invulnTime: 0, // clear inherited spawn i-frames so a lash actually lands
  };
  return {
    ...w,
    ships: { ...w.ships, items: [p, enemy], nextId: 9002 },
  };
};

test("whip special spawns, costs fuel, and expires after its life", () => {
  let w = initArcadeWorld(1, arcadeConfig());
  const fuel0 = pilotOf(w).fuel;
  expect(fuel0).toBeGreaterThanOrEqual(WHIP_FUEL_COST);

  w = update({ kind: "action", actionId: 8 }, w);
  expect(w.whips.items.length).toBe(1);
  expect(pilotOf(w).fuel).toBeCloseTo(fuel0 - WHIP_FUEL_COST, 3);

  // One whip per ship at a time — a second crack while active is inert.
  const before = w.whips.items.length;
  w = update({ kind: "action", actionId: 8 }, w);
  expect(w.whips.items.length).toBe(before);

  // It retracts and clears within its life window.
  for (let i = 0; i <= WHIP_LIFE + 4; i++) w = tick(w, 1, i * 16);
  expect(w.whips.items.length).toBe(0);
});

test("whip lashes a nearby enemy for damage", () => {
  let w = initArcadeWorld(2, arcadeConfig());
  w = pilotVsEnemy(w, 3);
  const hp0 = (() => {
    const e = w.ships.items.find((s) => s.id === 9001);
    if (!e) throw new Error("no enemy");
    return e.hp + e.shield;
  })();

  w = update({ kind: "action", actionId: 8 }, w);
  for (let i = 0; i < 8; i++) w = tick(w, 1, i * 16);

  const e = w.ships.items.find((s) => s.id === 9001);
  const hp1 = e ? e.hp + e.shield : 0; // gone = fully lashed down
  expect(hp1).toBeLessThan(hp0);
});
