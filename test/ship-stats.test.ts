// Read-model tests: statsFor must stay sim-accurate — the same tuning
// derivations the sim spawns ships from — so the HUD views can never drift.
import { describe, expect, test } from "bun:test";
import { COUNTERED_BY, COUNTERS, statsFor } from "~/ui/shipStats";
import { ARCHETYPES, MAX_LEVEL } from "~/world";
import {
  carriesMissiles,
  cruiseFor,
  fireCooldownFor,
  MISSILE_MIN_LEVEL,
  maxFuelFor,
  maxHpFor,
} from "~/world/tuning";

const levels = Array.from({ length: MAX_LEVEL }, (_, i) => i + 1);

describe("ship-stats read model", () => {
  test("stat rows quote the sim's own tuning derivations", () => {
    for (const a of ARCHETYPES) {
      for (const lvl of levels) {
        const byKey = Object.fromEntries(
          statsFor(a, lvl).rows.map((r) => [r.key, r.text]),
        );
        expect(byKey.hull).toBe(String(maxHpFor(a, lvl)));
        expect(byKey.spd).toBe(cruiseFor(a, lvl).toFixed(2));
        expect(byKey.fire).toBe(`${Math.round(fireCooldownFor(a, lvl))}g`);
        expect(byKey.fuel).toBe(String(maxFuelFor(a, lvl)));
      }
    }
  });

  test("meter fractions compare against the strongest class on each axis", () => {
    const keys = ["hull", "spd", "fire", "fuel"] as const;
    for (const key of keys) {
      const norms = ARCHETYPES.map(
        (a) => statsFor(a, 3).rows.find((r) => r.key === key)?.norm ?? 0,
      );
      for (const n of norms) {
        expect(n).toBeGreaterThan(0);
        expect(n).toBeLessThanOrEqual(1);
      }
      expect(Math.max(...norms)).toBeCloseTo(1, 12);
    }
  });

  test("trait chips flip from '@ L' teaser to unlocked at the gate rank", () => {
    for (const a of ARCHETYPES.filter(carriesMissiles)) {
      expect(statsFor(a, MISSILE_MIN_LEVEL - 1).traits).toContain(
        `missiles @ L${MISSILE_MIN_LEVEL}`,
      );
      expect(statsFor(a, MISSILE_MIN_LEVEL).traits).toContain("missiles");
    }
  });

  test("counter web is a total cycle and COUNTERED_BY is its inverse", () => {
    expect(new Set(Object.values(COUNTERS)).size).toBe(ARCHETYPES.length);
    for (const a of ARCHETYPES) {
      expect(COUNTERED_BY[COUNTERS[a]]).toBe(a);
    }
  });
});
