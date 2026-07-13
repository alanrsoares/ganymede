// Unit tests for the pure core of the WebGPU game (no GPU/DOM needed). These are
// the modules the architecture review flagged as testable-but-untested.
import { expect, test } from "bun:test";
import {
  angleTo,
  easeAngle,
  elastic,
  normalize,
  rotate,
  wrapDelta,
} from "~/engine/physics";
import { nextFloat } from "~/engine/rng";
import { makeAsteroidMesh, makeSphereMesh } from "~/mesh";
import { instanceLayout } from "~/mesh-pass";
import { shipSize } from "~/overlay/ships";
import {
  ASTEROID_VARIANTS,
  asteroidLayer,
  CLIP,
  clipLayer,
  SPRITE_LAYER_COUNT,
  SPRITE_URLS,
} from "~/sprites";
import {
  ARENA,
  CENTER_PAD,
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  HEAL_PADS,
  PORTALS,
  setGridBounds,
  setOrbitPhase,
  TEAM_BASES,
} from "~/world";
import {
  acquireTarget,
  applyHit,
  fireCooldownForLevel,
  focusEnemy,
  hurtShip,
  maxHpForLevel,
  nearestEnemy,
  rollShip,
  shipRadius,
  toroidalDist,
  wrap,
} from "~/world/factory";

const close = (a: number, b: number, eps = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

// --- physics -----------------------------------------------------------------
test("wrapDelta takes the short way around the torus", () => {
  expect(wrapDelta(1, 9, 10)).toBe(-2); // 8 forward → -2 backward is shorter
  expect(wrapDelta(9, 1, 10)).toBe(2);
  expect(wrapDelta(2, 5, 100)).toBe(3);
});

test("normalize returns a unit vector and falls back on zero", () => {
  const [x, y] = normalize([3, 4]);
  close(x, 0.6);
  close(y, 0.8);
  expect(normalize([0, 0], [0, 1])).toEqual([0, 1]);
});

test("angleTo uses the sim's atan2(x,y) convention", () => {
  close(angleTo([0, 1]), 0);
  close(angleTo([1, 0]), Math.PI / 2);
});

test("rotate turns a vector by the given angle", () => {
  const [x, y] = rotate([1, 0], Math.PI / 2);
  close(x, 0, 1e-9);
  close(y, 1, 1e-9);
});

test("easeAngle takes the shortest arc across the ±π seam", () => {
  // From just under +π toward just over -π: should step forward, not unwind.
  const r = easeAngle(3.0, -3.0, 0.5);
  expect(r).toBeGreaterThan(3.0); // moved past +π, not back toward 0
});

test("elastic is a no-op when the pair is already separating", () => {
  const [va, vb] = elastic([-1, 0], [1, 0], [1, 0], 1, 1); // a left, b right
  expect(va).toEqual([-1, 0]);
  expect(vb).toEqual([1, 0]);
});

test("elastic conserves momentum on a head-on equal-mass hit", () => {
  const [va, vb] = elastic([1, 0], [-1, 0], [1, 0], 1, 1);
  close(va[0] + vb[0], 0); // total momentum preserved
  expect(va[0]).toBeLessThan(vb[0]); // they push apart
});

// --- rng ---------------------------------------------------------------------
test("nextFloat is deterministic for a given seed", () => {
  expect(nextFloat(42)).toEqual(nextFloat(42));
  const [v] = nextFloat(42);
  expect(v).toBeGreaterThanOrEqual(0);
  expect(v).toBeLessThan(1);
});

// --- factory -----------------------------------------------------------------
test("toroidalDist / wrap wrap the field", () => {
  expect(toroidalDist(1, 9, 10)).toBe(2);
  expect(wrap(-1, 10)).toBe(9);
  expect(wrap(11, 10)).toBe(1);
});

test("applyHit spends shield before hull; hurtShip lights the flare", () => {
  const s = { shield: 2, hp: 3, hitFlash: 0 };
  applyHit(s, 1);
  expect(s.shield).toBe(1);
  expect(s.hp).toBe(3);
  applyHit(s, 2); // 1 soaked by shield, 1 spills to hull
  expect(s.shield).toBe(0);
  expect(s.hp).toBe(2);
  hurtShip(s, 1);
  expect(s.hitFlash).toBeGreaterThan(0);
});

test("per-level tables scale with rank", () => {
  expect(maxHpForLevel(1)).toBe(2);
  expect(maxHpForLevel(5)).toBe(6);
  expect(fireCooldownForLevel(1)).toBeGreaterThan(fireCooldownForLevel(5));
});

test("rollShip is deterministic and honors forceColor", () => {
  const [a] = rollShip(7, 1, 10, 20, 2, "cyan");
  const [b] = rollShip(7, 1, 10, 20, 2, "cyan");
  expect(a).toEqual(b);
  expect(a.colorName).toBe("cyan");
  expect(a.level).toBe(2);
});

test("nearestEnemy finds the closest other-team ship, skipping removed", () => {
  const [self] = rollShip(1, 1, 0, 0, 1, "cyan");
  const [near] = rollShip(2, 2, 10, 0, 1, "orange");
  const [far] = rollShip(3, 3, 50, 0, 1, "orange");
  const [ally] = rollShip(4, 4, 5, 0, 1, "cyan");
  const ships = [self, near, far, ally];
  const hit = nearestEnemy(self, ships, new Set());
  expect(hit?.ship.id).toBe(2);
  // Skipping the near enemy falls through to the far one.
  const hit2 = nearestEnemy(self, ships, new Set([2]));
  expect(hit2?.ship.id).toBe(3);
  // No enemies → null.
  expect(nearestEnemy(self, [self, ally], new Set())).toBeNull();
});

test("focus fire picks the weakest enemy in range; solo picks nearest", () => {
  const [self] = rollShip(1, 1, 0, 0, 3, "cyan"); // L3 coordinates
  const [near] = rollShip(2, 2, 10, 0, 3, "orange"); // near, healthy
  const [rolled] = rollShip(3, 3, 40, 0, 3, "orange"); // farther, hurt
  const woundedFar = { ...rolled, hp: 1 };
  const ships = [self, near, woundedFar];
  // focus fire converges on the wounded one even though it's farther.
  expect(focusEnemy(self, ships, 100, new Set())?.ship.id).toBe(3);
  // acquireTarget for an L3 coordinates (weakest); an L1 just takes nearest.
  expect(acquireTarget(self, ships, 100, new Set())?.ship.id).toBe(3);
  const [rookie] = rollShip(4, 4, 0, 0, 1, "cyan");
  expect(acquireTarget(rookie, ships, 100, new Set())?.ship.id).toBe(2);
  // out of range → no focus target.
  expect(focusEnemy(self, ships, 5, new Set())).toBeNull();
});

// --- mesh --------------------------------------------------------------------
test("makeAsteroidMesh yields a non-indexed triangle soup", () => {
  const m = makeAsteroidMesh(0); // base icosahedron: 20 faces
  expect(m.vertexCount).toBe(20 * 3);
  expect(m.data.length).toBe(m.vertexCount * 6); // pos(3)+normal(3)
});

test("makeSphereMesh has unit-length smooth normals", () => {
  const m = makeSphereMesh(1);
  for (let i = 0; i < m.vertexCount; i++) {
    const o = i * 6;
    const len = Math.hypot(m.data[o + 3], m.data[o + 4], m.data[o + 5]);
    close(len, 1, 1e-5);
  }
});

// --- mesh-pass layout --------------------------------------------------------
test("instanceLayout derives floats, vec4 attrs, and named offsets", () => {
  const L = instanceLayout(["a", "b", "c", "d", "e", "f", "g", "h"]);
  expect(L.floats).toBe(8);
  expect(L.attrs).toHaveLength(2);
  expect(L.attrs[1]).toMatchObject({ shaderLocation: 1, offset: 16 });
  expect(L.idx.e).toBe(4);
});

// --- sprites atlas -----------------------------------------------------------
test("SPRITE_URLS length matches the layer count", () => {
  expect(SPRITE_URLS.length).toBe(SPRITE_LAYER_COUNT);
});

test("every atlas layer index is in range", () => {
  for (let v = 0; v < ASTEROID_VARIANTS; v++) {
    expect(asteroidLayer(v)).toBeLessThan(SPRITE_LAYER_COUNT);
    expect(asteroidLayer(v)).toBeGreaterThanOrEqual(0);
  }
  // clipLayer loops a looping clip and stays within its frame band.
  const a = clipLayer(CLIP.mine, 0, 0);
  const b = clipLayer(CLIP.mine, 0, CLIP.mine.frameMs * CLIP.mine.frames);
  expect(a).toBe(b); // wrapped a full cycle
});

// --- dynamic aspect ratio / grid bounds --------------------------------------
test("dynamic grid bounds resizing", () => {
  try {
    setOrbitPhase(0); // pin the ring to zero rotation (shared module global)
    // Check default values
    expect(ARENA.w).toBe(480);
    expect(ARENA.h).toBe(270);

    // Check center pad is at center
    expect(CENTER_PAD.x).toBe(240);
    expect(CENTER_PAD.y).toBe(135);

    // Set new bounds (e.g. 21:9 ultrawide with locked height of 270)
    setGridBounds(630, 270);

    expect(ARENA.w).toBe(630);
    expect(ARENA.h).toBe(270);

    // Check center pad dynamically shifted to the new center
    expect(CENTER_PAD.x).toBe(315);
    expect(CENTER_PAD.y).toBe(135);

    // Harmonic ring: every body (bases, portals, heal pads) is ~the same radius
    // from the star, capped by the short axis and re-centred on resize. The
    // organic micro-drift (radial breathing + centre wander, a few px) means
    // "near", not exact — DRIFT_ENVELOPE bounds the total deviation.
    const R = Math.min(630, 270) / 2 - 22; // 113
    const DRIFT_ENVELOPE = 8; // px: radius breathing (~2%) + centre wander (3px)
    const distFromStar = (b: { x: number; y: number }) =>
      Math.hypot(b.x - CENTER_PAD.x, b.y - CENTER_PAD.y);
    for (const body of [...PORTALS, ...HEAL_PADS, ...TEAM_BASES]) {
      expect(Math.abs(distFromStar(body) - R)).toBeLessThanOrEqual(
        DRIFT_ENVELOPE,
      );
    }
    // Portals sit on the E/W poles — near the star's row, mirrored across it.
    expect(Math.abs(PORTALS[0].y - 135)).toBeLessThanOrEqual(DRIFT_ENVELOPE);
    expect(Math.abs(PORTALS[1].y - 135)).toBeLessThanOrEqual(DRIFT_ENVELOPE);
    expect(PORTALS[0].x).toBeLessThan(315);
    expect(PORTALS[1].x).toBeGreaterThan(315);
  } finally {
    // Reset back to defaults so later tests have clean environment
    setGridBounds(DEFAULT_GRID_W, DEFAULT_GRID_H);
  }
  expect(ARENA.w).toBe(480);
});

test("ship sizes: biggest ship is not more than 3x the smallest ship size", () => {
  const levels = [1, 2, 3, 4, 5];
  const radiusSizes = levels.map(shipRadius);
  const minRadius = Math.min(...radiusSizes);
  const maxRadius = Math.max(...radiusSizes);
  expect(maxRadius).toBeLessThanOrEqual(3 * minRadius);

  const visualSizes = levels.map(shipSize);
  const minVisual = Math.min(...visualSizes);
  const maxVisual = Math.max(...visualSizes);
  expect(maxVisual).toBeLessThanOrEqual(3 * minVisual);
});
