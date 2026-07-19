import { expect, test } from "bun:test";
import { rollOffer } from "~/world/augments";

test("an offer is 3 distinct augments", () => {
  const { offer } = rollOffer(42, {});
  expect(offer.length).toBe(3);
  expect(new Set(offer).size).toBe(3);
});

test("capstones stay locked below their tier", () => {
  let seed = 12345;
  for (let i = 0; i < 60; i++) {
    const r = rollOffer(seed, {}); // tier 0
    seed = r.seed;
    expect(r.offer).not.toContain("aegis");
    expect(r.offer).not.toContain("overdrive");
  }
});

test("capstones can appear once the run is deep enough", () => {
  let seed = 999;
  let sawCapstone = false;
  for (let i = 0; i < 120; i++) {
    const r = rollOffer(seed, { hull: 6 }); // tier 6 → capstones unlocked
    seed = r.seed;
    if (r.offer.includes("aegis") || r.offer.includes("overdrive")) {
      sawCapstone = true;
      break;
    }
  }
  expect(sawCapstone).toBe(true);
});
