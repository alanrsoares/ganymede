// The offer-freeze invariant, pinned at the sim's interface: while a wave-clear
// augment offer is pending, `update` treats "tick" and "action" msgs as
// identity — no caller can keep the fight running under the offer dialog.
// The runtime's own freeze predicate (main.ts) is presentation-only on top.

import { expect, test } from "bun:test";
import type { MatchConfig } from "~/world";
import { initArcadeWorld, update } from "~/world";
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

/** Arcade world ticked once past a wave clear, so an offer is pending. */
const worldWithOffer = () => {
  let w = initArcadeWorld(42, arcadeConfig());
  // biome-ignore lint/style/noNonNullAssertion: arcade world always has state
  w = { ...w, arcade: { ...w.arcade!, waveRemaining: 3 } };
  w = update({ kind: "tick", steps: 1, now: 16 }, w); // field empty → clear
  expect(w.arcade?.offer?.length).toBe(3);
  return w;
};

test("a pending offer makes tick msgs identity", () => {
  const w = worldWithOffer();
  const next = update({ kind: "tick", steps: 1, now: 32 }, w);
  expect(next).toBe(w); // same reference — the world did not advance
  expect(next.age).toBe(w.age); // generation counter proves no drift
});

test("a pending offer makes action msgs identity", () => {
  const w = worldWithOffer();
  const next = update({ kind: "action", actionId: 1 }, w);
  expect(next).toBe(w);
});

test("pickAugment clears the offer and the next tick advances again", () => {
  let w = worldWithOffer();
  // biome-ignore lint/style/noNonNullAssertion: offer was just rolled
  const id = w.arcade!.offer![0];
  w = update({ kind: "pickAugment", id }, w);
  expect(w.arcade?.offer).toBeNull();

  const age = w.age;
  w = update({ kind: "tick", steps: 1, now: 32 }, w);
  expect(w.age).toBe(age + 1); // un-frozen: the generation counter moves
});
