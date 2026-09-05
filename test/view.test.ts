import { describe, expect, test } from "bun:test";
import {
  orthoPixels,
  project,
  screenToWorld,
  unproject,
  type ViewProj,
  worldToScreen,
} from "~/render/view";

const W = 1280;
const H = 720;
const DEPTH_SCALE = 0.0016;
const VIEW = orthoPixels(W, H, DEPTH_SCALE);

// What every shader hardcoded before the matrix existed. The identity view must
// still agree with it, or the hero capture moves.
const legacyClip = (x: number, y: number, z: number) => ({
  x: (x / W) * 2 - 1,
  y: -((y / H) * 2 - 1),
  z: Math.max(0, Math.min(1, 0.5 - z * DEPTH_SCALE)),
});

const shifted = (m: ViewProj, dx: number, dy: number): ViewProj => {
  const out = new Float32Array(m);
  out[12] += (2 / W) * dx;
  out[13] += -(2 / H) * dy;
  return out;
};

describe("orthoPixels is the transform the passes hardcoded", () => {
  const points = [
    [0, 0, 0],
    [W, H, 0],
    [W / 2, H / 2, 0],
    [17.5, 933.25, 42],
    [640, 360, -60],
  ] as const;

  test.each(points)("matches legacy clip math at (%p, %p, %p)", (x, y, z) => {
    const want = legacyClip(x, y, z);
    const got = project(VIEW, x, y, z);
    expect(got.x).toBeCloseTo(want.x, 6);
    expect(got.y).toBeCloseTo(want.y, 6);
    // The shader clamps after the matrix; the matrix itself is unclamped.
    expect(Math.max(0, Math.min(1, got.z))).toBeCloseTo(want.z, 6);
  });

  test("maps the drawing buffer onto the full NDC box", () => {
    // f32 storage, so the corners land within an ulp rather than exactly.
    const origin = project(VIEW, 0, 0);
    const far = project(VIEW, W, H);
    expect(origin.x).toBeCloseTo(-1, 6);
    expect(origin.y).toBeCloseTo(1, 6);
    expect(far.x).toBeCloseTo(1, 6);
    expect(far.y).toBeCloseTo(-1, 6);
  });

  test("centre of the screen sits at mid depth", () => {
    expect(project(VIEW, W / 2, H / 2, 0).z).toBeCloseTo(0.5, 6);
  });
});

describe("un-projection", () => {
  test("round-trips world pixels through NDC", () => {
    for (const [x, y] of [
      [0, 0],
      [W, H],
      [321.5, 88.25],
    ]) {
      const ndc = project(VIEW, x, y);
      const back = unproject(VIEW, ndc.x, ndc.y);
      expect(back.x).toBeCloseTo(x, 4);
      expect(back.y).toBeCloseTo(y, 4);
    }
  });

  test("identity view reproduces the old pointer ratio", () => {
    // Old input math: offset / clientSize * gridSize, with world px = grid *
    // (bufferSize / gridSize). Under identity the two must agree exactly.
    const cssW = 640;
    const cssH = 360;
    const p = screenToWorld(VIEW, 160, 90, cssW, cssH);
    expect(p.x).toBeCloseTo((160 / cssW) * W, 4);
    expect(p.y).toBeCloseTo((90 / cssH) * H, 4);
  });

  test("screenToWorld and worldToScreen invert each other", () => {
    const back = worldToScreen(VIEW, 400, 250, 800, 450);
    const fwd = screenToWorld(VIEW, back.x, back.y, 800, 450);
    expect(fwd.x).toBeCloseTo(400, 4);
    expect(fwd.y).toBeCloseTo(250, 4);
  });
});

describe("a non-identity view moves the scene coherently", () => {
  const moved = shifted(VIEW, -120, -45);

  test("every point shifts by the same world delta", () => {
    for (const [x, y] of [
      [0, 0],
      [W, H],
      [500, 120],
    ]) {
      const before = project(VIEW, x, y);
      const after = project(moved, x, y);
      expect(after.x - before.x).toBeCloseTo((2 / W) * -120, 6);
      expect(after.y - before.y).toBeCloseTo(-(2 / H) * -45, 6);
    }
  });

  test("pointer un-projection follows the camera", () => {
    const still = screenToWorld(VIEW, 320, 180, 640, 360);
    const panned = screenToWorld(moved, 320, 180, 640, 360);
    expect(panned.x - still.x).toBeCloseTo(120, 4);
    expect(panned.y - still.y).toBeCloseTo(45, 4);
  });
});
