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
import { BASE_MAX_HP } from "../world/factory";
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

  // Vertical energy beam rising from base center
  const beamPulse = 0.7 + 0.3 * Math.sin(now / 200 + base.x);
  push(
    bx,
    by - 7 * cellPy, // rising from dock
    1.6 * cellPx,
    9 * cellPy,
    0,
    SHAPE.beam,
    [base.rgb[0], base.rgb[1], base.rgb[2], 0.65 * beamPulse * hpFrac],
  );

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

  // Portal base: slow flat spin on Z, slight 3D tilt on X/Y
  baseInstances[o + R.rx] = 0.55;
  baseInstances[o + R.ry] = 0.28;
  baseInstances[o + R.rz] = now * 0.0003 + base.x;

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
    // Ring 1: Clockwise
    const angle1 = now / 600 + (i * Math.PI * 2) / numCenterSparks;
    const dist1 = (r * 0.85 + 1.2 * Math.sin(now / 300 + i)) * cellPx;
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
      -(now / 450) + (i * Math.PI * 2) / numCenterSparks + Math.PI / 4;
    const dist2 = (r * 0.55 + 0.8 * Math.cos(now / 250 + i)) * cellPx;
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

// The neutral center pad (foreground furniture): a gold/white platform under a
// double pulsing ring — visually distinct from the green heal pads. It heals
// ships over it and is the level-up finish line, so it reads as "the prize."
export function drawCenterPad(
  centerPadInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  push: PushFn,
): number {
  const cx = (CENTER_PAD.x + 0.5) * cellPx;
  const cy = (CENTER_PAD.y + 0.5) * cellPy;
  const pulse = 0.5 + 0.5 * Math.sin(now / 300);
  const gold: readonly [number, number, number] = [1.0, 0.82, 0.3];

  // 3D Crystal Obelisk Instance
  const o = 0;
  const R = ROCK_LAYOUT.idx;
  centerPadInstances[o + R.cx] = cx;
  centerPadInstances[o + R.cy] = cy;
  centerPadInstances[o + R.radius] = CENTER_PAD.r * 1.15 * cellPx;

  // Floating crystal rotation: rotate on Y and Z axis
  centerPadInstances[o + R.rx] = 0.35 + 0.1 * Math.sin(now / 1000);
  centerPadInstances[o + R.ry] = now * 0.0006;
  centerPadInstances[o + R.rz] = now * 0.0008;

  centerPadInstances[o + R.r] = gold[0];
  centerPadInstances[o + R.g] = gold[1];
  centerPadInstances[o + R.b] = gold[2];
  centerPadInstances[o + R.damage] = 0.2 + 0.5 * pulse; // pulsing cracks!

  // Concentric neon soundwave ripples using the custom SHAPE.pad
  push(
    cx,
    cy,
    CENTER_PAD.r * 1.25 * cellPx,
    CENTER_PAD.r * 1.25 * cellPy,
    0,
    SHAPE.pad,
    [gold[0], gold[1], gold[2], 0.7 + 0.3 * pulse],
    0.35 + 0.15 * Math.sin(now / 480), // drift parameter for the wave ripple offset
  );

  // Major golden beacon beam rising from the center pad
  const padPulse = 0.8 + 0.2 * Math.sin(now / 150);
  push(
    cx,
    cy - 12 * cellPy, // Offset vertically so it extends upward
    3.0 * cellPx, // Wide beam width
    16 * cellPy, // Tall beam height
    0,
    SHAPE.beam,
    [1.0, 0.9, 0.65, 0.58 * padPulse],
  );

  drawCenterPadSparks(push, cx, cy, cellPx, cellPy, now, CENTER_PAD.r);
  return 1;
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
