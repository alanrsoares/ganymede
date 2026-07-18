// Articulation math tests: the TS mirror of ship.wgsl's spineDeform must obey
// the deformation contract (rigid head, full-amp tail, rigid hinge segments)
// and the stock catalog values must stay serializable per-class data.
import { describe, expect, test } from "bun:test";
import { BODY_TAIL, spineOffset, spineY } from "~/hull/articulation";
import { ARTICULATION, SHIP_CLASSES } from "~/hull/catalog";

const ART = { amp: 0.1, freq: 3.5, speed: 1, headStiff: 0.4, segLen: 0 };

describe("spineOffset", () => {
  test("head is rigid: zero offset for any y at or above headStiff", () => {
    for (const y of [ART.headStiff, 0.6, 0.9, 1.1]) {
      expect(spineOffset(y, 1.23, 0, ART)).toBe(0);
    }
  });

  test("envelope reaches full amplitude at the tail", () => {
    // Pick a phase that puts the sine at its crest exactly at BODY_TAIL.
    const phase = BODY_TAIL * ART.freq - Math.PI / 2;
    expect(spineOffset(BODY_TAIL, phase, 0, ART)).toBeCloseTo(ART.amp, 10);
  });

  test("turn lean is zero at the head boundary and grows aft", () => {
    const rigid = { ...ART, amp: 0 };
    expect(spineOffset(ART.headStiff, 0, 0.3, rigid)).toBe(0);
    const near = Math.abs(spineOffset(0.2, 0, 0.3, rigid));
    const far = Math.abs(spineOffset(-0.9, 0, 0.3, rigid));
    expect(far).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(0);
  });

  test("segLen > 0 gives one shared offset per rigid segment", () => {
    const hinged = { ...ART, segLen: 0.3 };
    // Same segment → identical offsets; adjacent segment → different.
    expect(spineOffset(-0.61, 2, 0.1, hinged)).toBe(
      spineOffset(-0.89, 2, 0.1, hinged),
    );
    expect(spineOffset(-0.61, 2, 0.1, hinged)).not.toBe(
      spineOffset(-0.31, 2, 0.1, hinged),
    );
  });

  test("spineY snaps to segment centres", () => {
    expect(spineY(-0.65, 0.3)).toBeCloseTo(-0.75, 10);
    expect(spineY(-0.65, 0)).toBe(-0.65);
  });
});

describe("ARTICULATION catalog", () => {
  test("covers every ship class with serializable data", () => {
    for (const cls of SHIP_CLASSES) {
      expect(ARTICULATION[cls]).toBeDefined();
      expect(ARTICULATION[cls].amp).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.parse(JSON.stringify(ARTICULATION))).toEqual(ARTICULATION);
  });
});
