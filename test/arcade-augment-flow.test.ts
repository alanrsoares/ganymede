import { expect, test } from "bun:test";
import type { MatchConfig } from "~/world";
import { initArcadeWorld, update } from "~/world";
import { AUGMENTS } from "~/world/augments";
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

const enemiesOf = (w: ReturnType<typeof initArcadeWorld>) =>
  w.ships.items.filter((s) => s.colorName !== "cyan").length;

test("a wave clear rolls a 3-augment offer and freezes the next muster", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
  w = { ...w, arcade: { ...w.arcade!, waveRemaining: 3 } };

  w = tick(w, 1, 16); // field empty + waveRemaining>0 → wave clears
  expect(w.arcade?.offer?.length).toBe(3);
  expect(enemiesOf(w)).toBe(0);

  w = tick(w, 1, 32); // offer still pending → no new wave musters
  expect(w.arcade?.offer?.length).toBe(3);
  expect(enemiesOf(w)).toBe(0);
});

test("picking an augment banks it, clears the offer, and resumes muster", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
  w = { ...w, arcade: { ...w.arcade!, waveRemaining: 3 } };
  w = tick(w, 1, 16);
  // biome-ignore lint/style/noNonNullAssertion: offer was just rolled
  const id = w.arcade!.offer![0];

  w = update({ kind: "pickAugment", id }, w);
  expect(w.arcade?.augments[id]).toBe(1);
  expect(w.arcade?.offer).toBeNull();

  w = tick(w, 1, 32); // offer cleared → next wave musters
  expect(enemiesOf(w)).toBeGreaterThan(0);
});

test("the Hull augment compounds the pilot's max HP and heals to it", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  const base =
    w.ships.items.find((s) => s.id === w.controlledShipId)?.maxHp ?? 0;
  expect(base).toBeGreaterThan(0);

  // Offer Hull twice and stack it — compounding, not additive.
  for (let i = 0; i < 2; i++) {
    // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
    w = { ...w, arcade: { ...w.arcade!, offer: ["hull"] } };
    w = update({ kind: "pickAugment", id: "hull" }, w);
  }

  const pilot = w.ships.items.find((s) => s.id === w.controlledShipId);
  expect(w.arcade?.augments.hull).toBe(2);
  expect(pilot?.maxHp).toBe(Math.round(base * AUGMENTS.hull.mul ** 2));
  expect(pilot?.hp).toBe(pilot?.maxHp); // topped off on pick
});

test("a picked augment survives the run on arcade state (not the ship)", () => {
  let w = initArcadeWorld(42, arcadeConfig());
  // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
  w = { ...w, arcade: { ...w.arcade!, offer: ["caliber"] } };
  w = update({ kind: "pickAugment", id: "caliber" }, w);
  // The stack lives on arcade state, so it persists across ship death/respawn
  // (loseLife spreads it forward). Just assert it's banked and offer cleared.
  expect(w.arcade?.augments.caliber).toBe(1);
  expect(w.arcade?.offer).toBeNull();
});
