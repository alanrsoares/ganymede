// FrameInstances projection tests: the overlay → renderer seam is a plain
// value, so the whole World → instance-buffer projection runs under bun:test
// with no GPUDevice. A seeded World ticked N times must pack deterministic,
// cap-respecting, correctly ordered instance data.

import { expect, test } from "bun:test";
import { createOverlay } from "~/render/overlay";
import {
  FLOATS_PER_INSTANCE,
  type FrameInstances,
  MAX_BASES,
  MAX_CENTER_PADS,
  MAX_INSTANCES,
  MAX_MESH_SHIPS,
  MAX_ORBS,
  MAX_PLUMES,
  MAX_ROCKS,
  MAX_SHIELDS,
  PLUME_LAYOUT,
  ROCK_LAYOUT,
  SHIELD_LAYOUT,
  SHIP_LAYOUT,
} from "~/render/overlay/frame";
import { SHIP_CLASSES } from "~/ship-parts";
import { ARENA, initWorld, setOrbitPhase, update } from "~/world";

const NOW = 5000;

// A seeded World ticked N times, projected through a fresh overlay.
const buildFrame = (seed: number, steps: number): FrameInstances => {
  let w = initWorld(seed);
  w = update({ kind: "tick", steps, now: NOW }, w);
  setOrbitPhase(w.age);
  return createOverlay().build({
    w: 1280,
    h: 720,
    gridW: ARENA.w,
    gridH: ARENA.h,
    now: NOW,
    world: w,
    showHp: true,
  });
};

test("buffers are sized by the caps and layouts", () => {
  const f = buildFrame(42, 30);
  expect(f.instances.length).toBe(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  expect(f.rockInstances.length).toBe(MAX_ROCKS * ROCK_LAYOUT.floats);
  expect(f.shieldInstances.length).toBe(MAX_SHIELDS * SHIELD_LAYOUT.floats);
  expect(f.orbInstances.length).toBe(MAX_ORBS * SHIELD_LAYOUT.floats);
  expect(f.baseInstances.length).toBe(MAX_BASES * ROCK_LAYOUT.floats);
  expect(f.centerPadInstances.length).toBe(
    MAX_CENTER_PADS * ROCK_LAYOUT.floats,
  );
  for (const cls of SHIP_CLASSES) {
    expect(f.ships.instances[cls].length).toBe(
      MAX_MESH_SHIPS * SHIP_LAYOUT.floats,
    );
  }
  expect(f.ships.plumes.length).toBe(MAX_PLUMES * PLUME_LAYOUT.floats);
});

test("counts stay within their caps and reflect the seeded field", () => {
  const f = buildFrame(42, 30);
  expect(f.count).toBeGreaterThan(0);
  expect(f.count).toBeLessThanOrEqual(MAX_INSTANCES);
  // A fresh world seeds NUM_ASTEROIDS rocks and an initial fleet.
  expect(f.rockCount).toBeGreaterThan(0);
  expect(f.rockCount).toBeLessThanOrEqual(MAX_ROCKS);
  expect(f.shieldCount).toBeLessThanOrEqual(MAX_SHIELDS);
  expect(f.orbCount).toBeLessThanOrEqual(MAX_ORBS);
  expect(f.baseCount).toBeGreaterThan(0);
  expect(f.baseCount).toBeLessThanOrEqual(MAX_BASES);
  expect(f.centerPadCount).toBeLessThanOrEqual(MAX_CENTER_PADS);
  let hullCount = 0;
  for (const cls of SHIP_CLASSES) {
    expect(f.ships.counts[cls]).toBeLessThanOrEqual(MAX_MESH_SHIPS);
    hullCount += f.ships.counts[cls];
  }
  expect(hullCount).toBeGreaterThan(0);
  expect(f.ships.plumeCount).toBeLessThanOrEqual(MAX_PLUMES);
});

test("portals pack first so the renderer can draw them under the 3D passes", () => {
  const f = buildFrame(7, 12);
  expect(f.portalCount).toBeGreaterThan(0);
  expect(f.portalCount).toBeLessThan(f.count);
  // Every leading (portal) sprite record carries a real quad half-size.
  for (let i = 0; i < f.portalCount; i++) {
    expect(f.instances[i * FLOATS_PER_INSTANCE + 2]).toBeGreaterThan(0);
  }
});

test("counted records carry real packed data", () => {
  const f = buildFrame(42, 30);
  const rockRadius = ROCK_LAYOUT.idx.radius;
  for (let i = 0; i < f.rockCount; i++) {
    expect(
      f.rockInstances[i * ROCK_LAYOUT.floats + rockRadius],
    ).toBeGreaterThan(0);
  }
  const shipRadius = SHIP_LAYOUT.idx.radius;
  for (const cls of SHIP_CLASSES) {
    for (let i = 0; i < f.ships.counts[cls]; i++) {
      expect(
        f.ships.instances[cls][i * SHIP_LAYOUT.floats + shipRadius],
      ).toBeGreaterThan(0);
    }
  }
  // Sprite quads: posSize = [cx, cy, hx, hy] — hx must be a real half-size.
  for (let i = 0; i < f.count; i++) {
    expect(f.instances[i * FLOATS_PER_INSTANCE + 2]).toBeGreaterThan(0);
  }
});

test("projection is deterministic: same seed + now → identical frame", () => {
  const a = buildFrame(1234, 60);
  const b = buildFrame(1234, 60);
  expect(b.count).toBe(a.count);
  expect(b.portalCount).toBe(a.portalCount);
  expect(b.rockCount).toBe(a.rockCount);
  expect(b.shieldCount).toBe(a.shieldCount);
  expect(b.orbCount).toBe(a.orbCount);
  expect(b.baseCount).toBe(a.baseCount);
  expect(b.centerPadCount).toBe(a.centerPadCount);
  expect(b.instances).toEqual(a.instances);
  expect(b.rockInstances).toEqual(a.rockInstances);
  expect(b.shieldInstances).toEqual(a.shieldInstances);
  expect(b.orbInstances).toEqual(a.orbInstances);
  expect(b.baseInstances).toEqual(a.baseInstances);
  expect(b.centerPadInstances).toEqual(a.centerPadInstances);
  expect(b.ships.counts).toEqual(a.ships.counts);
  expect(b.ships.plumeCount).toBe(a.ships.plumeCount);
  for (const cls of SHIP_CLASSES) {
    expect(b.ships.instances[cls]).toEqual(a.ships.instances[cls]);
  }
  expect(b.ships.plumes).toEqual(a.ships.plumes);
});
