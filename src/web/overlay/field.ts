// view: background furniture — bases, portals, heal pads, the center pad and
// the rally beacon. Pure — reads world, animation is derived from `now`.

import { BASE_LAYER, PORTAL_LAYER, SHAPE } from "../sprites";
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
  }
  push(
    bx,
    by,
    9 * cellPx,
    9 * cellPy,
    0,
    SHAPE.tintsprite,
    [base.rgb[0], base.rgb[1], base.rgb[2], dead ? 0.18 : 0.4 + 0.45 * hpFrac],
    BASE_LAYER,
  );
  if (!dead) drawBaseIntegrityBar(push, bx, by, cellPx, cellPy, hpFrac);
}

// Team bases (furthest back).
export function drawBases(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  for (const base of TEAM_BASES) {
    const hpFrac = Math.max(
      0,
      Math.min(1, (world.baseHp[base.name] ?? 0) / BASE_MAX_HP),
    );
    if (hpFrac <= 0) continue; // razed or an inactive team (< 4 players)
    drawBase(push, base, cellPx, cellPy, now, hpFrac);
  }
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

// The neutral center pad (foreground furniture): a gold/white platform under a
// double pulsing ring — visually distinct from the green heal pads. It heals
// ships over it and is the level-up finish line, so it reads as "the prize."
export function drawCenterPad(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  const cx = (CENTER_PAD.x + 0.5) * cellPx;
  const cy = (CENTER_PAD.y + 0.5) * cellPy;
  const pulse = 0.5 + 0.5 * Math.sin(now / 300);
  const gold: readonly [number, number, number] = [1.0, 0.82, 0.3];
  // Inner platform.
  push(
    cx,
    cy,
    CENTER_PAD.r * 0.62 * cellPx,
    CENTER_PAD.r * 0.62 * cellPy,
    0,
    SHAPE.sprite,
    [gold[0], gold[1], gold[2], 0.22 + 0.12 * pulse],
  );
  // Two counter-rotating rings.
  push(
    cx,
    cy,
    CENTER_PAD.r * cellPx,
    CENTER_PAD.r * cellPy,
    now / 900,
    SHAPE.ring,
    [gold[0], gold[1], gold[2], 0.5 + 0.3 * pulse],
  );
  push(
    cx,
    cy,
    CENTER_PAD.r * 0.74 * cellPx,
    CENTER_PAD.r * 0.74 * cellPy,
    -now / 650,
    SHAPE.ring,
    [1.0, 1.0, 1.0, 0.28 + 0.22 * pulse],
  );
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
