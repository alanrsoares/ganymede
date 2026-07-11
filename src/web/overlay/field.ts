// view: background furniture — bases, portals, heal pads, the center pad and
// the rally beacon. Pure — reads world, animation is derived from `now`.

import { MAX_BASES, ROCK_LAYOUT } from "../gpu";
import { PORTAL_LAYER, SHAPE } from "../sprites";
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
// A single team base: slow team-tinted portal ring encircling the dock
// platform, dimming as its integrity falls; a razed base (hp 0) shows only
// faint rubble. An HP bar sits beneath it.
function drawBaseDecorations(
  push: PushFn,
  bx: number,
  by: number,
  cellPx: number,
  cellPy: number,
  now: number,
  base: (typeof TEAM_BASES)[number],
  hpFrac: number,
) {
  // Pulse energy halo under the base
  push(bx, by, 10 * cellPx, 10 * cellPy, -now / 800, SHAPE.ring, [
    base.rgb[0],
    base.rgb[1],
    base.rgb[2],
    0.25 * (0.6 + 0.4 * Math.sin(now / 520 + base.x)) * hpFrac,
  ]);

  // Orbital sparks circulating the base
  const numSparks = 3;
  for (let i = 0; i < numSparks; i++) {
    const angle = now / 1000 + (i * Math.PI * 2) / numSparks + base.x;
    const dist = (7 + 1.5 * Math.sin(now / 350 + i)) * cellPx;
    push(
      bx + Math.cos(angle) * dist,
      by + Math.sin(angle) * dist,
      1.1 * cellPx,
      1.1 * cellPy,
      0,
      SHAPE.solid,
      [base.rgb[0], base.rgb[1], base.rgb[2], 0.75 * hpFrac],
    );
  }
}

function drawBase(
  push: PushFn,
  base: (typeof TEAM_BASES)[number],
  cellPx: number,
  cellPy: number,
  now: number,
  hpFrac: number,
) {
  const bx = (base.x + 0.5) * cellPx;
  const by = (base.y + 0.5) * cellPy;
  const dead = hpFrac <= 0;
  const bpulse = 0.6 + 0.4 * Math.sin(now / 520 + base.x);

  if (!dead) {
    // Portal base ring
    push(
      bx,
      by,
      13 * cellPx,
      13 * cellPy,
      now / 2200,
      SHAPE.tintsprite,
      [base.rgb[0], base.rgb[1], base.rgb[2], (0.35 + 0.3 * bpulse) * hpFrac],
      PORTAL_LAYER,
    );
    drawBaseDecorations(push, bx, by, cellPx, cellPy, now, base, hpFrac);
  }

  if (!dead) drawBaseIntegrityBar(push, bx, by, cellPx, cellPy, hpFrac);
}

function writeBase3DInstance(
  baseInstances: Float32Array<ArrayBuffer>,
  baseCount: number,
  base: (typeof TEAM_BASES)[number],
  cellPx: number,
  cellPy: number,
  now: number,
  hpFrac: number,
) {
  const o = baseCount * ROCK_LAYOUT.floats;
  const R = ROCK_LAYOUT.idx;
  const bx = (base.x + 0.5) * cellPx;
  const by = (base.y + 0.5) * cellPy;

  baseInstances[o + R.cx] = bx;
  baseInstances[o + R.cy] = by;
  baseInstances[o + R.radius] = 6.2 * cellPx;

  // Platform laid flat facing the camera: a small fixed tilt shows the rim for
  // depth, and a slow Z spin drifts the running lights around it.
  baseInstances[o + R.rx] = 0.2;
  baseInstances[o + R.ry] = -0.12;
  baseInstances[o + R.rz] = now * 0.00025 + base.x;

  // Color team tint
  const dead = hpFrac <= 0;
  baseInstances[o + R.r] = dead ? 0.25 : base.rgb[0] * (0.45 + 0.55 * hpFrac);
  baseInstances[o + R.g] = dead ? 0.25 : base.rgb[1] * (0.45 + 0.55 * hpFrac);
  baseInstances[o + R.b] = dead ? 0.25 : base.rgb[2] * (0.45 + 0.55 * hpFrac);
  baseInstances[o + R.damage] = dead ? 1.0 : 1.0 - hpFrac; // glow cracks scale with damage!
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

    if (baseCount < MAX_BASES) {
      writeBase3DInstance(
        baseInstances,
        baseCount,
        base,
        cellPx,
        cellPy,
        now,
        hpFrac,
      );
      baseCount++;
    }

    drawBase(push, base, cellPx, cellPy, now, hpFrac);
  }
  return baseCount;
}

// Portals (background). Two linked gates, slowly counter-rotating.
export function drawPortals(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  const portalTints: readonly Rgba[] = [
    [0.55, 0.8, 1.0, 0.95],
    [1.0, 0.6, 0.95, 0.95],
  ];
  PORTALS.forEach((gate, i) => {
    const dir = i === 0 ? 1 : -1;
    push(
      (gate.x + 0.5) * cellPx,
      (gate.y + 0.5) * cellPy,
      gate.r * 1.3 * cellPx,
      gate.r * 1.3 * cellPy,
      (now / 1400) * dir,
      SHAPE.sprite,
      portalTints[i],
      PORTAL_LAYER,
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

function drawCenterPadSparks(
  push: PushFn,
  cx: number,
  cy: number,
  cellPx: number,
  cellPy: number,
  now: number,
  r: number,
) {
  const numCenterSparks = 4;
  for (let i = 0; i < numCenterSparks; i++) {
    // Ring 1: Clockwise, slow drift
    const angle1 = now / 1600 + (i * Math.PI * 2) / numCenterSparks;
    const dist1 = (r * 0.85 + 1.2 * Math.sin(now / 900 + i)) * cellPx;
    push(
      cx + Math.cos(angle1) * dist1,
      cy + Math.sin(angle1) * dist1,
      1.4 * cellPx,
      1.4 * cellPy,
      0,
      SHAPE.solid,
      [1.0, 0.85, 0.2, 0.9],
    );

    // Ring 2: Counter-Clockwise, nested
    const angle2 =
      -(now / 1150) + (i * Math.PI * 2) / numCenterSparks + Math.PI / 4;
    const dist2 = (r * 0.55 + 0.8 * Math.cos(now / 780 + i)) * cellPx;
    push(
      cx + Math.cos(angle2) * dist2,
      cy + Math.sin(angle2) * dist2,
      1.0 * cellPx,
      1.0 * cellPy,
      0,
      SHAPE.solid,
      [1.0, 1.0, 1.0, 0.8],
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

// The neutral center pad (foreground furniture): concentric neon rings radiating
// outward like a beacon ping, around a bright pulsing core. Its colour tracks the
// active resource phase (hp/fuel/shield), so it reads as "the prize" and signals
// what it yields. Pure 2D vector; draws no 3D mesh instance (returns 0).
export function drawCenterPad(
  _centerPadInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  push: PushFn,
  world: World,
): number {
  const cx = (CENTER_PAD.x + 0.5) * cellPx;
  const cy = (CENTER_PAD.y + 0.5) * cellPy;
  const pulse = 0.5 + 0.5 * Math.sin(now / 620);
  const col = PHASE_COLOR[centerPadPhase(world.age)];
  // Core + boundary ring stay near-white but carry a hint of the phase colour.
  const lit = (k: number, a: number): Rgba => [
    col[0] + (1 - col[0]) * k,
    col[1] + (1 - col[1]) * k,
    col[2] + (1 - col[2]) * k,
    a,
  ];
  const r = CENTER_PAD.r;

  // Beacon ping: each ring eases from the core outward and fades as it goes, the
  // set staggered in phase so a new wave leaves as the last dissolves. Slow
  // period + ease-out expansion so the motion glides rather than ticks.
  const RINGS = 4;
  const period = 3200;
  for (let i = 0; i < RINGS; i++) {
    const t = (((now / period + i / RINGS) % 1) + 1) % 1;
    const eased = 1 - (1 - t) * (1 - t); // fast-out, gentle settle
    const rad = r * (0.35 + 1.2 * eased);
    // Fade in from the core and out at the rim so recycling is never visible.
    const alpha = Math.sin(t * Math.PI) * 0.7;
    push(cx, cy, rad * cellPx, rad * cellPy, now / 4200, SHAPE.ring, [
      col[0],
      col[1],
      col[2],
      alpha,
    ]);
  }

  // Steady inner boundary ring + a bright core so there is structure between
  // pings and a clear point to aim for.
  push(
    cx,
    cy,
    r * 0.42 * cellPx,
    r * 0.42 * cellPy,
    -now / 1900,
    SHAPE.ring,
    lit(0.7, 0.55 + 0.3 * pulse),
  );
  push(
    cx,
    cy,
    r * 0.16 * cellPx,
    r * 0.16 * cellPy,
    0,
    SHAPE.solid,
    lit(0.8, 0.75 + 0.25 * pulse),
  );

  drawCenterPadSparks(push, cx, cy, cellPx, cellPy, now, r);
  return 0;
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
  const fade = Math.max(0, Math.min(1, world.rally.ttl / 360));
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
