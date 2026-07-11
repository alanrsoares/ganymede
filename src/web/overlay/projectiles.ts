// view: weapon effects — bolts, missiles and blast bursts. Pure — reads
// world, animation is derived from `now`.

import {
  type AnimClip,
  CLIP,
  clipLayer,
  explosionClip,
  SHAPE,
} from "../sprites";
import {
  BURST_DETONATION,
  BURST_IMPACT,
  BURST_MUZZLE,
  type Burst,
  type World,
} from "../world";
import type { PushFn, Rgba } from "./push";

// Weapon bolts — one shader-drawn plasma streak per bullet, thin + long and
// rotated to heading. The bolt shape paints a hot core + team glow +
// tapered tips, so a single quad replaces old flat dots.
export function drawBolts(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  world: World,
) {
  const boltW = 1.15;
  const boltL = 4.6;
  for (const b of world.bullets.items) {
    push(
      (b.x + 0.5) * cellPx,
      (b.y + 0.5) * cellPy,
      boltW * cellPx,
      boltL * cellPy,
      b.angle,
      SHAPE.bolt,
      [b.rgb[0], b.rgb[1], b.rgb[2], 1.0],
    );
  }
}

// Seeking missiles — vapor trail receding behind a pulsing exhaust,
// team-tinted plasma body, white-hot warhead tip (which the bloom pass
// flares). All oriented to the missile's heading.
export function drawMissiles(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
  exhaustL: number,
) {
  for (const mi of world.missiles.items) {
    const mx = (mi.x + 0.5) * cellPx;
    const my = (mi.y + 0.5) * cellPy;
    const hx = Math.sin(mi.angle);
    const hy = Math.cos(mi.angle);
    const px = -hy; // perpendicular, for trail wobble
    const py = hx;
    // Vapor trail: soft grey puffs fading back along the flight path.
    for (let k = 1; k <= 5; k++) {
      const d = k * 2.3;
      const fade = 1 - k / 6;
      const wob = Math.sin(now * 0.02 + k + mi.id) * k * 0.35;
      const psz = (1.6 + k * 0.55) * cellPx;
      push(
        mx - hx * d * cellPx + px * wob * cellPx,
        my - hy * d * cellPy + py * wob * cellPy,
        psz,
        psz,
        0,
        SHAPE.solid,
        [0.72, 0.74, 0.82, 0.22 * fade],
      );
    }
    // Pulsing exhaust flare at the tail.
    const flare = 2.2 + 0.6 * Math.sin(now * 0.05 + mi.id);
    push(
      mx - hx * 2.6 * cellPx,
      my - hy * 2.6 * cellPy,
      flare * cellPx,
      flare * cellPy,
      mi.angle,
      SHAPE.sprite,
      [1.0, 0.6, 0.2, 0.95],
      exhaustL,
    );
    // Plasma body.
    push(mx, my, 1.5 * cellPx, 3.6 * cellPy, mi.angle, SHAPE.bolt, [
      mi.rgb[0],
      mi.rgb[1],
      mi.rgb[2],
      1.0,
    ]);
    // White-hot tip.
    push(
      mx + hx * 1.6 * cellPx,
      my + hy * 1.6 * cellPy,
      1.1 * cellPx,
      1.1 * cellPy,
      0,
      SHAPE.solid,
      [1.0, 1.0, 1.0, 1.0],
    );
  }
}

interface BurstStyle {
  clip: AnimClip;
  bsize: number;
  shape: number;
  tint: Rgba;
}

// Explosions + detonations use the FX sprite (soft radial edge fade so the
// glow never hard-cuts into a square); muzzle/impact use tintsprite so
// SHAPE.tintsprite can multiply the vulcan flare by the shooter's team
// color. Explosions + mine detonations use fixed fire/proton tints.
export function burstStyle(burst: Burst): BurstStyle {
  if (burst.kind === BURST_DETONATION) {
    return {
      clip: CLIP.detonation,
      bsize: 9,
      shape: SHAPE.fxsprite,
      tint: [0.7, 0.9, 1.0, 1.0],
    };
  }
  if (burst.kind === BURST_MUZZLE || burst.kind === BURST_IMPACT) {
    const c = burst.rgb ?? [1, 1, 1];
    return {
      clip: CLIP.vulcan,
      bsize: burst.kind === BURST_MUZZLE ? 5.5 : 4.5,
      shape: SHAPE.tintsprite,
      tint: [c[0], c[1], c[2], 1.0],
    };
  }
  return {
    clip: explosionClip(burst.variant),
    bsize: 14,
    shape: SHAPE.fxsprite,
    tint: [1.0, 0.85, 0.6, 1.0],
  };
}

// Animated blast FX at their sites.
export function drawBursts(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  for (const burst of world.bursts.items) {
    const style = burstStyle(burst);
    const layer = clipLayer(style.clip, burst.start, now);
    if (layer < 0) continue;
    push(
      (burst.x + 0.5) * cellPx,
      (burst.y + 0.5) * cellPy,
      style.bsize * cellPx,
      style.bsize * cellPy,
      burst.rot ?? 0, // muzzle flash points along the shot
      style.shape,
      style.tint,
      layer,
    );
  }
}
