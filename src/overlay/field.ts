// view: background furniture — bases, portals, heal pads, the center pad and
// the rally beacon. Pure — reads world, animation is derived from `now`.

import { clamp01 } from "../engine/physics";
import { MAX_BASES, ROCK_LAYOUT } from "../gpu";
import { SHAPE } from "../sprites";
import {
  CENTER_PAD,
  HEAL_PADS,
  PORTALS,
  TEAM_BASES,
  teamByName,
  type World,
} from "../world";
import {
  BASE_MAX_HP,
  type CenterPadPhase,
  centerPadPhase,
} from "../world/factory";
import { drawForceField, type FieldDir } from "./effects";
import type { PushFn, Rgba } from "./push";

// Integrity bar under a base (green→red), hidden once razed.
function drawBaseIntegrityBar(
  push: PushFn,
  bx: number,
  by: number,
  cellPx: number,
  cellPy: number,
  hpFrac: number,
) {
  const barW = 16 * cellPx;
  const barY = by + 8 * cellPy;
  push(
    bx,
    barY,
    barW / 2,
    1.1 * cellPy,
    0,
    SHAPE.rect,
    [0.05, 0.05, 0.08, 0.7],
  );
  push(
    bx - barW / 2 + (barW * hpFrac) / 2,
    barY,
    (barW * hpFrac) / 2,
    1.1 * cellPy,
    0,
    SHAPE.rect,
    [1 - hpFrac, 0.2 + 0.7 * hpFrac, 0.2, 0.9],
  );
}
// A hex-prism "energy platform" — the shared visual spine of both team bases and
// the center pad. It writes one 3D dais instance and layers the 2D glow over it:
// a soft halo, a force-field ring wave, a counter-rotating boundary ring and a
// bright core. Every 2D radius derives from `scale` (the platform radius in
// cells), so a base and the ~2× center pad are the same composition at a
// different size, tint and field direction. `intensity` (0..1) fades the whole
// 2D glow at once — a base passes its hpFrac (razed → only the 3D rubble left);
// the pad passes 1.
interface PlatformSpec {
  gx: number; // cell-space centre
  gy: number;
  scale: number; // platform radius in cells; drives every 2D radius
  tint: readonly [number, number, number]; // 2D glow colour
  dir: FieldDir; // "in" pulls (base), "out" repels (pad)
  intensity: number; // 0..1 glow multiplier
  seed: number; // per-instance phase offset (spin + pulse)
  meshRgb: readonly [number, number, number]; // 3D dais colour
  damage: number; // 3D crack amount, 0..1
}

// Write the 3D metal dais instance: flat to the camera with a small fixed tilt
// for rim depth and a slow Z spin drifting its running lights.
function writePlatformDais(
  instances: Float32Array<ArrayBuffer>,
  slot: number,
  px: number,
  py: number,
  radius: number,
  now: number,
  spec: PlatformSpec,
): void {
  const R = ROCK_LAYOUT.idx;
  const o = slot * ROCK_LAYOUT.floats;
  instances[o + R.cx] = px;
  instances[o + R.cy] = py;
  instances[o + R.radius] = radius;
  instances[o + R.rx] = 0.2;
  instances[o + R.ry] = -0.12;
  instances[o + R.rz] = now * 0.00025 + spec.seed;
  instances[o + R.r] = spec.meshRgb[0];
  instances[o + R.g] = spec.meshRgb[1];
  instances[o + R.b] = spec.meshRgb[2];
  instances[o + R.damage] = spec.damage;
}

function drawEnergyPlatform(
  push: PushFn,
  instances: Float32Array<ArrayBuffer>,
  slot: number,
  cellPx: number,
  cellPy: number,
  now: number,
  spec: PlatformSpec,
): void {
  const { scale: s, tint, intensity: I, seed } = spec;
  const px = (spec.gx + 0.5) * cellPx;
  const py = (spec.gy + 0.5) * cellPy;
  const pulse = 0.5 + 0.4 * Math.sin(now / 560 + seed);
  const lit = (k: number, a: number): Rgba => [
    tint[0] + (1 - tint[0]) * k,
    tint[1] + (1 - tint[1]) * k,
    tint[2] + (1 - tint[2]) * k,
    a * I,
  ];

  writePlatformDais(instances, slot, px, py, s * cellPx, now, spec);

  // 2D glow, every radius a fixed fraction of the platform scale.
  push(
    px,
    py,
    s * 1.6 * cellPx,
    s * 1.6 * cellPy,
    -now / 800,
    SHAPE.ring,
    lit(0, 0.25 * pulse),
  ); // halo
  drawForceField(push, px, py, cellPx, cellPy, s * 1.5, now, tint, {
    dir: spec.dir,
    alpha: 0.55 * I,
  });
  push(
    px,
    py,
    s * 0.645 * cellPx,
    s * 0.645 * cellPy,
    -now / 1900,
    SHAPE.ring,
    lit(0.65, 0.5 + 0.3 * pulse),
  ); // boundary
  push(
    px,
    py,
    s * 0.26 * cellPx,
    s * 0.26 * cellPy,
    0,
    SHAPE.solid,
    lit(0.8, 0.72 + 0.25 * pulse),
  ); // core
}

// A team base: the energy platform tinted to the team with an inward (pulling)
// field, its glow and 3D dais both fading as integrity falls, plus an HP bar.
function drawBase(
  push: PushFn,
  instances: Float32Array<ArrayBuffer>,
  slot: number,
  base: (typeof TEAM_BASES)[number],
  cellPx: number,
  cellPy: number,
  now: number,
  hpFrac: number,
) {
  const dead = hpFrac <= 0;
  const dim = 0.45 + 0.55 * hpFrac;
  const meshRgb: readonly [number, number, number] = dead
    ? [0.25, 0.25, 0.25]
    : [base.rgb[0] * dim, base.rgb[1] * dim, base.rgb[2] * dim];
  drawEnergyPlatform(push, instances, slot, cellPx, cellPy, now, {
    gx: base.x,
    gy: base.y,
    scale: 6.2,
    tint: base.rgb,
    dir: "in",
    intensity: hpFrac, // razed → glow vanishes, only the 3D rubble remains
    seed: base.x,
    meshRgb,
    damage: dead ? 1 : 1 - hpFrac,
  });
  if (!dead) {
    const bx = (base.x + 0.5) * cellPx;
    const by = (base.y + 0.5) * cellPy;
    drawBaseIntegrityBar(push, bx, by, cellPx, cellPy, hpFrac);
  }
}

// Team bases (furthest back).
export function drawBases(
  baseInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
  push: PushFn,
): number {
  let baseCount = 0;
  for (const base of TEAM_BASES) {
    const hpFrac = Math.max(
      0,
      Math.min(1, (world.baseHp[base.name] ?? 0) / BASE_MAX_HP),
    );
    if (hpFrac <= 0 && world.age > 0) continue; // razed or an inactive team (< 4 players)
    if (baseCount >= MAX_BASES) break;
    drawBase(push, baseInstances, baseCount, base, cellPx, cellPy, now, hpFrac);
    baseCount++;
  }
  return baseCount;
}

// Portals (background). Lime-green procedural vortex (portal-gun swirl) framed
// by a bright ring. Both gates share the same tint; counter-rotation (layer =
// spin sign) distinguishes the pair.
const PORTAL_LIME: Rgba = [0.25, 1.0, 0.18, 0.95];

export function drawPortals(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  PORTALS.forEach((gate, i) => {
    const px = (gate.x + 0.5) * cellPx;
    const py = (gate.y + 0.5) * cellPy;
    const dir = i === 0 ? 1 : -1;
    push(
      px,
      py,
      gate.r * 1.15 * cellPx,
      gate.r * 1.15 * cellPy,
      0,
      SHAPE.vortex,
      PORTAL_LIME,
      dir,
    );
    push(
      px,
      py,
      gate.r * 1.3 * cellPx,
      gate.r * 1.3 * cellPy,
      (now / 900) * dir,
      SHAPE.ring,
      PORTAL_LIME,
    );
  });
}

// Healing pads (background). Green pulsing rings on the field.
export function drawHealPads(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 380);
  for (const pad of HEAL_PADS) {
    push(
      (pad.x + 0.5) * cellPx,
      (pad.y + 0.5) * cellPy,
      pad.r * cellPx,
      pad.r * cellPy,
      now / 1000,
      SHAPE.ring,
      [0.25, 1.0, 0.5, 0.35 + 0.35 * pulse],
    );
  }
}

// The resource the center pad currently dispenses drives its ring colour, so a
// glance tells you what holding it is worth right now (matches the pickup hues).
const PHASE_COLOR: Record<CenterPadPhase, readonly [number, number, number]> = {
  hp: [0.3, 1.0, 0.5], // green — health
  fuel: [1.0, 0.65, 0.1], // amber — fuel
  shield: [0.4, 0.78, 1.0], // blue — shield
};

// The center pad (foreground furniture): the same energy platform as a base, but
// ~2× scale, a neutral-gold pristine dais, and an outward (repelling) field. Its
// glow tint tracks the active resource phase (hp/fuel/shield) — the one piece of
// state a base doesn't have — so it reads as "the prize" and signals its yield.
export function drawCenterPad(
  centerPadInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  push: PushFn,
  world: World,
): number {
  drawEnergyPlatform(push, centerPadInstances, 0, cellPx, cellPy, now, {
    gx: CENTER_PAD.x,
    gy: CENTER_PAD.y,
    scale: 13.0, // ~2× a base; boundary ring lands at CENTER_PAD.r * 0.42
    tint: PHASE_COLOR[centerPadPhase(world.age)],
    dir: "out",
    intensity: 1,
    seed: 0,
    meshRgb: [1.0, 0.78, 0.35], // neutral gold — the prize dais, not a fourth base
    damage: 0, // pristine: clean running lights, no cracks
  });
  return 1;
}

// Hostile-red reticle over the piloted ship's locked target: two counter-
// rotating rings so it reads as an active lock, not scenery.
export function drawLockReticle(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  if (world.lockedTargetId == null) return;
  const t = world.ships.items.find((s) => s.id === world.lockedTargetId);
  if (!t) return;
  const px = (t.x + 0.5) * cellPx;
  const py = (t.y + 0.5) * cellPy;
  const pulse = 0.5 + 0.5 * Math.sin(now / 120);
  const r = (7 + pulse * 1.6) * cellPx;
  push(px, py, r, r, now / 380, SHAPE.ring, [1, 0.28, 0.3, 0.9]);
  push(px, py, r * 1.5, r * 1.5, -now / 560, SHAPE.ring, [
    1,
    0.45,
    0.4,
    0.3 + pulse * 0.3,
  ]);
}

export function drawRallyBeacon(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  if (!world.rally) return;
  const team = teamByName.get(world.rally.team);
  const rgb = team?.rgb ?? [0.8, 0.9, 1.0];
  const px = (world.rally.x + 0.5) * cellPx;
  const py = (world.rally.y + 0.5) * cellPy;
  const fade = clamp01(world.rally.ttl / 360);
  const pulse = 0.5 + 0.5 * Math.sin(now / 140);
  const radius = (13 + pulse * 5) * cellPx;
  push(px, py, radius, radius, now / 650, SHAPE.ring, [
    rgb[0],
    rgb[1],
    rgb[2],
    (0.42 + pulse * 0.32) * fade,
  ]);
  push(px, py, 2.6 * cellPx, 2.6 * cellPy, Math.PI / 4, SHAPE.rect, [
    rgb[0],
    rgb[1],
    rgb[2],
    0.9 * fade,
  ]);
}
