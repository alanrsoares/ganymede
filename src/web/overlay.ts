// view: projects the immutable World into a flat sprite instance buffer for
// gpu.ts. Pure — it only reads world — animation is derived from `now`.

import {
  FLOATS_PER_INSTANCE,
  MAX_INSTANCES,
  MAX_ORBS,
  MAX_ROCKS,
  MAX_SHIELDS,
  ROCK_LAYOUT,
  SHIELD_LAYOUT,
} from "./gpu";
import {
  drawBases,
  drawCenterPad,
  drawHealPads,
  drawPortals,
  drawRallyBeacon,
} from "./overlay/field";
import {
  drawMines,
  drawPickupOrbs,
  drawRocks,
  drawShrapnel,
} from "./overlay/hazards";
import { drawBolts, drawBursts, drawMissiles } from "./overlay/projectiles";
import { createPusher } from "./overlay/push";
import { drawShips } from "./overlay/ships";
import { CLIP, clipLayer } from "./sprites";
import type { World } from "./world";

export interface OverlayFrame {
  w: number;
  h: number;
  gridW: number;
  gridH: number;
  now: number;
  world: World;
  showHp: boolean;
}

export interface Overlay {
  build(frame: OverlayFrame): {
    instances: Float32Array<ArrayBuffer>;
    count: number;
    rockInstances: Float32Array<ArrayBuffer>;
    rockCount: number;
    shieldInstances: Float32Array<ArrayBuffer>;
    shieldCount: number;
    orbInstances: Float32Array<ArrayBuffer>;
    orbCount: number;
  };
}

export const createOverlay = (): Overlay => {
  const instances = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  const rockInstances = new Float32Array(MAX_ROCKS * ROCK_LAYOUT.floats);
  const shieldInstances = new Float32Array(MAX_SHIELDS * SHIELD_LAYOUT.floats);
  const orbInstances = new Float32Array(MAX_ORBS * SHIELD_LAYOUT.floats);
  const { push, reset, getCount } = createPusher(instances);

  return {
    build: ({ w, h, gridW, gridH, now, world, showHp }) => {
      reset();
      const cellPx = w / gridW;
      const cellPy = h / gridH;

      drawBases(push, cellPx, cellPy, now, world);
      drawPortals(push, cellPx, cellPy, now);
      drawHealPads(push, cellPx, cellPy, now);
      drawCenterPad(push, cellPx, cellPy, now);
      drawRallyBeacon(push, cellPx, cellPy, now, world);
      const rockCount = drawRocks(rockInstances, cellPx, cellPy, now, world);
      drawMines(push, cellPx, cellPy, now, world);
      drawShrapnel(push, cellPx, cellPy, world);
      const orbCount = drawPickupOrbs(
        push,
        orbInstances,
        cellPx,
        cellPy,
        now,
        world,
      );
      drawBolts(push, cellPx, cellPy, world);

      // Free-running exhaust clip frame shared by every ship + missile.
      const exhaustL = clipLayer(CLIP.exhaust, 0, now);
      drawMissiles(push, cellPx, cellPy, now, world, exhaustL);
      const shieldCount = drawShips(
        push,
        shieldInstances,
        cellPx,
        cellPy,
        now,
        world,
        showHp,
        exhaustL,
      );
      drawBursts(push, cellPx, cellPy, now, world);

      return {
        instances,
        count: getCount(),
        rockInstances,
        rockCount,
        shieldInstances,
        shieldCount,
        orbInstances,
        orbCount,
      };
    },
  };
};
