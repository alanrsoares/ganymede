import { expect, test } from "bun:test";
import type { MatchConfig } from "~/world";
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

// Regression: once the pilot razes the enemy bases, baseless-team elimination
// used to annihilate every freshly-mustered wave the tick after it spawned,
// producing a runaway that blew through hundreds of waves in a flash. Arcade
// bases are just spawn anchors, so a razed base must NOT wipe its team.
test("razed enemy bases do not cause a runaway wave cascade", () => {
  let w = initArcadeWorld(12345, arcadeConfig());
  w = { ...w, baseHp: { ...w.baseHp, orange: 0, emerald: 0 } };

  const startWave = w.arcade?.wave ?? 0;
  let now = 0;
  for (let i = 0; i < 600; i++) {
    now += 16;
    w = tick(w, 1, now);
  }

  // 600 ticks should advance only a handful of waves at most (the pilot AI here
  // is idle, so realistically zero) — never a cascade of tens/hundreds.
  expect((w.arcade?.wave ?? 0) - startWave).toBeLessThan(5);
  // Enemies mustered from razed bases must survive to fight, not vanish.
  expect(w.ships.items.length).toBeGreaterThan(1);
});
