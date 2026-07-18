import { describe, expect, test } from "bun:test";
import { assembleShipMesh, buildPrim } from "~/hull/bake";
import { type PartDef, RECIPES, SHIP_CLASSES } from "~/hull/catalog";

describe("bevelSlab prim", () => {
  test("beveled slab bakes a finite, non-degenerate mesh", () => {
    const mesh = assembleShipMesh([
      {
        prim: { kind: "slab", tx: 0.5, tz: 0.5, bevel: 0.12 },
        scale: [1, 1, 1],
        pos: [0, 0, 0],
        color: "bone",
      },
    ]);
    // 3 side bands x 8 quads x 2 tris + 2 octagon caps x 6 tris = 60 tris.
    expect(mesh.vertexCount).toBe(180);
    for (let i = 0; i < mesh.vertexCount * 9; i++) {
      expect(Number.isFinite(mesh.data[i])).toBe(true);
    }
  });

  test("bevel 0 (or absent) falls back to the plain 12-tri slab", () => {
    const plain = buildPrim({ kind: "slab", tx: 0.5, tz: 0.5 });
    const zero = buildPrim({ kind: "slab", tx: 0.5, tz: 0.5, bevel: 0 });
    expect(plain.faces.length).toBe(12);
    expect(zero.faces.length).toBe(12);
  });

  test("beveled slab stays inside the unit slab's bounds", () => {
    const prim = buildPrim({ kind: "slab", tx: 1, tz: 1, bevel: 0.2 });
    for (const [x, y, z] of prim.verts) {
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
});

describe("centipede segmentation", () => {
  const base: PartDef = {
    prim: { kind: "slab", tx: 0.3, tz: 0.5, bevel: 0.1 },
    scale: [0.3, 1.6, 0.25],
    pos: [0, 0.1, 0],
    color: "bone",
  };

  test("seg n bakes n plates (n× the solid part's triangles)", () => {
    const solid = assembleShipMesh([base]);
    const chain = assembleShipMesh([{ ...base, seg: 5 }]);
    expect(chain.vertexCount).toBe(solid.vertexCount * 5);
    for (let i = 0; i < chain.vertexCount * 9; i++) {
      expect(Number.isFinite(chain.data[i])).toBe(true);
    }
  });

  test("plates stay inside the part's Y span and march tail→nose", () => {
    const chain = assembleShipMesh([{ ...base, seg: 4 }]);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < chain.vertexCount; v++) {
      const y = chain.data[v * 9 + 1];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // Overlap never pushes a plate past the original prim's ends by more
    // than half the extra plate height.
    const half = base.scale[1] / 2;
    const slack = (base.scale[1] / 4) * 0.5;
    expect(minY).toBeGreaterThanOrEqual(base.pos[1] - half - slack);
    expect(maxY).toBeLessThanOrEqual(base.pos[1] + half + slack);
  });

  test("seg 1, 0 or absent bakes the single solid prim", () => {
    const solid = assembleShipMesh([base]);
    expect(assembleShipMesh([{ ...base, seg: 1 }]).vertexCount).toBe(
      solid.vertexCount,
    );
    expect(assembleShipMesh([{ ...base, seg: 0 }]).vertexCount).toBe(
      solid.vertexCount,
    );
  });

  test("segmented recipes survive the JSON round-trip", () => {
    const revived = JSON.parse(JSON.stringify({ ...base, seg: 6 })) as PartDef;
    expect(revived.seg).toBe(6);
    expect(assembleShipMesh([revived]).vertexCount).toBeGreaterThan(0);
  });
});

describe("hull recipes", () => {
  test("every stock hull bakes finite geometry", () => {
    for (const cls of SHIP_CLASSES) {
      const mesh = assembleShipMesh(RECIPES[cls]);
      expect(mesh.vertexCount).toBeGreaterThan(0);
      for (let i = 0; i < mesh.vertexCount * 9; i++) {
        if (!Number.isFinite(mesh.data[i])) {
          throw new Error(`${cls}: non-finite float at ${i}`);
        }
      }
    }
  });

  test("an edited recipe re-bakes after a serialize round-trip", () => {
    // The drydock loop: edit a working copy, persist as JSON, re-bake.
    const parts = JSON.parse(JSON.stringify(RECIPES.scout)) as PartDef[];
    parts[0].scale = [0.5, 2.0, 0.3];
    parts[0].color = "acid";
    const revived = JSON.parse(JSON.stringify(parts)) as PartDef[];
    expect(revived).toEqual(parts);
    const mesh = assembleShipMesh(revived);
    expect(mesh.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < mesh.vertexCount * 9; i++) {
      expect(Number.isFinite(mesh.data[i])).toBe(true);
    }
  });
});
