import { describe, expect, test } from "bun:test";
import { applyOp, HULL_OPS_TOOL, type HullOp } from "~/drydock/ops";
import type { HullDef } from "~/drydock/store";

const hull = (): HullDef => ({
  parts: [
    {
      prim: { kind: "slab", tx: 0.5, tz: 0.5 },
      scale: [1, 1, 1],
      pos: [0, 0, 0],
      color: "bone",
    },
    {
      prim: { kind: "orb" },
      scale: [0.2, 0.2, 0.2],
      pos: [0, 0.5, 0],
      color: "eye",
    },
  ],
  engines: [{ pos: [0, -1.2, 0], w: 0.12 }],
  articulation: { amp: 0.1, freq: 3.5, speed: 1, headStiff: 0.4, segLen: 0 },
});

describe("applyOp reducer", () => {
  test("addPart appends and reports the new index", () => {
    const h = hull();
    const log = applyOp(h, {
      op: "addPart",
      part: {
        prim: { kind: "hex", taper: 0.7 },
        scale: [0.2, 0.5, 0.2],
        pos: [0, -1, 0],
        color: "acid",
      },
    });
    expect(h.parts).toHaveLength(3);
    expect(h.parts[2].color).toBe("acid");
    expect(log).toContain("2");
  });

  test("field ops mutate the targeted part", () => {
    const h = hull();
    applyOp(h, { op: "setScale", index: 0, scale: [2, 3, 4] });
    applyOp(h, { op: "setColor", index: 0, color: "carapace" });
    applyOp(h, { op: "setSeg", index: 0, seg: 5 });
    expect(h.parts[0].scale).toEqual([2, 3, 4]);
    expect(h.parts[0].color).toBe("carapace");
    expect(h.parts[0].seg).toBe(5);
  });

  test("out-of-range index is skipped, not applied", () => {
    const h = hull();
    expect(
      applyOp(h, { op: "setScale", index: 9, scale: [2, 2, 2] }),
    ).toBeNull();
    expect(h.parts[0].scale).toEqual([1, 1, 1]);
  });

  test("malformed vector is rejected", () => {
    const h = hull();
    const bad = { op: "setPos", index: 0, pos: [1, 2] } as unknown as HullOp;
    expect(applyOp(h, bad)).toBeNull();
    expect(h.parts[0].pos).toEqual([0, 0, 0]);
  });

  test("unknown op is a no-op", () => {
    const h = hull();
    expect(applyOp(h, { op: "bogus" } as unknown as HullOp)).toBeNull();
    expect(h.parts).toHaveLength(2);
  });
});

describe("applyOp reducer — engines, articulation, guards", () => {
  test("removePart refuses to empty the hull", () => {
    const h: HullDef = { ...hull(), parts: [hull().parts[0]] };
    expect(applyOp(h, { op: "removePart", index: 0 })).toBeNull();
    expect(h.parts).toHaveLength(1);
  });

  test("setArticulation applies a partial patch", () => {
    const h = hull();
    applyOp(h, { op: "setArticulation", params: { amp: 0.25, segLen: 0.3 } });
    expect(h.articulation.amp).toBe(0.25);
    expect(h.articulation.segLen).toBe(0.3);
    expect(h.articulation.freq).toBe(3.5); // untouched
  });

  test("setEngine updates only provided fields", () => {
    const h = hull();
    applyOp(h, { op: "setEngine", index: 0, w: 0.2 });
    expect(h.engines[0].w).toBe(0.2);
    expect(h.engines[0].pos).toEqual([0, -1.2, 0]);
  });
});

describe("HULL_OPS_TOOL schema", () => {
  test("exposes every op kind the reducer handles", () => {
    const kinds = HULL_OPS_TOOL.input_schema.properties.ops.items.properties.op
      .enum as readonly string[];
    for (const op of [
      "addPart",
      "removePart",
      "duplicatePart",
      "setPrim",
      "setScale",
      "setPos",
      "setRot",
      "setColor",
      "setMirror",
      "setSeg",
      "addEngine",
      "removeEngine",
      "setEngine",
      "setArticulation",
    ]) {
      expect(kinds).toContain(op);
    }
  });

  test("forces ops + note", () => {
    expect(HULL_OPS_TOOL.input_schema.required).toEqual(["ops", "note"]);
  });
});
