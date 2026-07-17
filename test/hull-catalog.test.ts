// Catalog-only tests: the hull data must stay plain serializable JSON so the
// drydock can edit, persist and clipboard it. No mesh code imported here.
import { describe, expect, test } from "bun:test";
import { ENGINES, PALETTE, RECIPES, SHIP_CLASSES } from "~/hull/catalog";

describe("hull catalog", () => {
  test("SHIP_CLASSES mirrors the recipe keys, each with engine anchors", () => {
    expect(SHIP_CLASSES).toEqual(Object.keys(RECIPES) as typeof SHIP_CLASSES);
    for (const cls of SHIP_CLASSES) {
      expect(ENGINES[cls].length).toBeGreaterThan(0);
    }
  });

  test("recipes and engine anchors survive a JSON round-trip verbatim", () => {
    expect(JSON.parse(JSON.stringify(RECIPES))).toEqual(RECIPES);
    expect(JSON.parse(JSON.stringify(ENGINES))).toEqual(ENGINES);
  });

  test("every part references a palette colour that exists", () => {
    for (const cls of SHIP_CLASSES) {
      for (const part of RECIPES[cls]) {
        expect(PALETTE[part.color]).toBeDefined();
      }
    }
  });
});
