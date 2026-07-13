// view: field hazards + pickups — asteroids, mines, shrapnel and power-up
// orbs. Pure — reads world, animation is derived from `now`.

import { clamp01 } from "../engine/physics";
import { MAX_ORBS, MAX_ROCKS, ROCK_LAYOUT, SHIELD_LAYOUT } from "../gpu";
import { CLIP, clipLayer, SHAPE } from "../sprites";
import type { World } from "../world";
import { SHRAPNEL_LIFE } from "../world/tuning";
import type { PushFn } from "./push";

export const PICKUP_RGB: readonly (readonly [number, number, number])[] = [
  [0.3, 1.0, 0.5],
  [0.4, 0.78, 1.0],
  [1.0, 0.8, 0.35],
  [1.0, 0.5, 0.15],
  [0.4, 0.95, 1.0],
  [1.0, 0.85, 0.3],
  [0.72, 0.45, 1.0],
  [0.85, 0.6, 1.0], // 7 force field — bright violet
  [1.0, 0.65, 0.1], // 8 fuel cell — amber
];

// Drifting asteroids are drawn by the 3D mesh pass (rockInstances), not the
// sprite pass. Pack a per-rock transform: screen center, pixel radius, a
// 3-axis tumble (rz reuses the sim spin; rx/ry animate off the clock), and a
// grey base that reddens as the rock loses integrity.
export function drawRocks(
  rockInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
): number {
  let rockCount = 0;
  for (const rock of world.asteroids.items) {
    if (rockCount >= MAX_ROCKS) break;
    const frac = clamp01(rock.hp / Math.max(1, rock.maxHp));
    const o = rockCount * ROCK_LAYOUT.floats;
    const R = ROCK_LAYOUT.idx;
    rockInstances[o + R.cx] = (rock.x + 0.5) * cellPx;
    rockInstances[o + R.cy] = (rock.y + 0.5) * cellPy;
    rockInstances[o + R.radius] = rock.size * cellPx;
    rockInstances[o + R.rx] = now * 0.0006 + rock.id * 1.3;
    rockInstances[o + R.ry] = now * 0.0009 + rock.id * 2.1;
    rockInstances[o + R.rz] = rock.spin; // sim tumble
    rockInstances[o + R.r] = 0.52 + (1 - frac) * 0.28; // reddens when hurt
    rockInstances[o + R.g] = 0.53 - (1 - frac) * 0.08;
    rockInstances[o + R.b] = 0.6 - (1 - frac) * 0.18;
    rockInstances[o + R.damage] = 1 - frac;
    rockCount++;
  }
  return rockCount;
}

// Proximity mines — team-tinted tumbling sprite; blinks once armed.
export function drawMines(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  const mineLayer = clipLayer(CLIP.mine, 0, now);
  for (const m of world.mines.items) {
    const armed = m.arm <= 0;
    const blink = armed ? 0.55 + 0.45 * Math.sin(now / 90) : 0.4;
    push(
      (m.x + 0.5) * cellPx,
      (m.y + 0.5) * cellPy,
      3.6 * cellPx,
      3.6 * cellPy,
      m.spin,
      SHAPE.tintsprite,
      [m.rgb[0], m.rgb[1], m.rgb[2], blink],
      mineLayer,
    );
  }
}

// Shrapnel fragments — now drawn in 3D rock pass as tiny spinning, cooling rock chips.
export function drawShrapnel(
  rockInstances: Float32Array<ArrayBuffer>,
  rockCount: number,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
): number {
  for (const f of world.projectiles.items) {
    if (rockCount >= MAX_ROCKS) break;
    const o = rockCount * ROCK_LAYOUT.floats;
    const R = ROCK_LAYOUT.idx;
    rockInstances[o + R.cx] = (f.x + 0.5) * cellPx;
    rockInstances[o + R.cy] = (f.y + 0.5) * cellPy;
    // Radius of shrapnel: make them small rock fragments
    rockInstances[o + R.radius] = 1.0 * cellPx;
    // rx and ry tumble over time, rz matches the sim spin
    rockInstances[o + R.rx] = now * 0.0012 + f.id * 1.7;
    rockInstances[o + R.ry] = now * 0.0016 + f.id * 2.5;
    rockInstances[o + R.rz] = f.spin;

    // Shrapnel is hot when born (glowing orange) and cools down to grey rock color
    const ageFrac = clamp01(f.life / SHRAPNEL_LIFE); // 1 fresh, 0 dying
    const rVal = 0.52 + ageFrac * 0.28; // starts at 0.8 (hot), cools to 0.52 (grey)
    const gVal = 0.53 - ageFrac * 0.08; // starts at 0.45, cools to 0.53
    const bVal = 0.6 - ageFrac * 0.18; // starts at 0.42, cools to 0.60

    rockInstances[o + R.r] = rVal;
    rockInstances[o + R.g] = gVal;
    rockInstances[o + R.b] = bVal;
    rockInstances[o + R.damage] = ageFrac;

    rockCount++;
  }
  return rockCount;
}

// Power-ups: a solid glossy 3D orb (its own lit pass) bobbing over a
// pulsing ground ring, tinted by kind — heal=green, shield=blue,
// speed=amber, overcharge=orange, EMP=cyan, rank-up=gold, cloak=violet.
export function drawPickupOrbs(
  push: PushFn,
  orbInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
): number {
  let orbCount = 0;
  for (const pk of world.pickups.items) {
    const c = PICKUP_RGB[pk.kind] ?? PICKUP_RGB[0];
    const bob = Math.sin(now / 300 + pk.bob) * 0.8;
    const px = (pk.x + 0.5) * cellPx;
    const py = (pk.y + 0.5 + bob) * cellPy;
    const ring = 0.5 + 0.5 * Math.sin(now / 240 + pk.bob);
    push(
      px,
      (pk.y + 0.5) * cellPy,
      5.5 * cellPx,
      5.5 * cellPy,
      now / 700,
      SHAPE.ring,
      [c[0], c[1], c[2], 0.3 + 0.35 * ring],
    );
    if (orbCount < MAX_ORBS) {
      const o = orbCount * SHIELD_LAYOUT.floats;
      const S = SHIELD_LAYOUT.idx;
      orbInstances[o + S.cx] = px;
      orbInstances[o + S.cy] = py;
      orbInstances[o + S.radius] = 4.0 * cellPx;
      orbInstances[o + S.r] = c[0];
      orbInstances[o + S.g] = c[1];
      orbInstances[o + S.b] = c[2];
      orbCount++;
    }
  }
  return orbCount;
}
