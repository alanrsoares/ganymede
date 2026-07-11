// view: field hazards + pickups — asteroids, mines, shrapnel and power-up
// orbs. Pure — reads world, animation is derived from `now`.

import { MAX_ORBS, MAX_ROCKS, ROCK_LAYOUT, SHIELD_LAYOUT } from "../gpu";
import { asteroidLayer, CLIP, clipLayer, SHAPE } from "../sprites";
import type { World } from "../world";
import type { PushFn } from "./push";

export const PICKUP_RGB: readonly (readonly [number, number, number])[] = [
  [0.3, 1.0, 0.5],
  [0.4, 0.78, 1.0],
  [1.0, 0.8, 0.35],
  [1.0, 0.5, 0.15],
  [0.4, 0.95, 1.0],
  [1.0, 0.85, 0.3],
  [0.72, 0.45, 1.0],
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
    const frac = Math.max(0, Math.min(1, rock.hp / Math.max(1, rock.maxHp)));
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

// Shrapnel fragments — tiny spinning rock chips.
export function drawShrapnel(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  world: World,
) {
  for (const f of world.projectiles.items) {
    push(
      (f.x + 0.5) * cellPx,
      (f.y + 0.5) * cellPy,
      2.4 * cellPx,
      2.4 * cellPy,
      f.spin,
      SHAPE.sprite,
      [0.85, 0.82, 0.8, 0.95],
      asteroidLayer(f.variant),
    );
  }
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
