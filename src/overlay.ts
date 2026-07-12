// view: projects the immutable World into a flat sprite instance buffer for
// gpu.ts. Pure — it only reads world — animation is derived from `now`.

import {
  FLOATS_PER_INSTANCE,
  MAX_BASES,
  MAX_CENTER_PADS,
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
import { createPusher, type PushFn } from "./overlay/push";
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
    portalCount: number;
    rockInstances: Float32Array<ArrayBuffer>;
    rockCount: number;
    shieldInstances: Float32Array<ArrayBuffer>;
    shieldCount: number;
    orbInstances: Float32Array<ArrayBuffer>;
    orbCount: number;
    baseInstances: Float32Array<ArrayBuffer>;
    baseCount: number;
    centerPadInstances: Float32Array<ArrayBuffer>;
    centerPadCount: number;
  };
}

const drawFieldFurniture = (
  push: PushFn,
  baseInstances: Float32Array<ArrayBuffer>,
  centerPadInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) => {
  const baseCount = drawBases(baseInstances, cellPx, cellPy, now, world, push);
  drawHealPads(push, cellPx, cellPy, now);
  const centerPadCount = drawCenterPad(
    centerPadInstances,
    cellPx,
    cellPy,
    now,
    push,
    world,
  );
  drawRallyBeacon(push, cellPx, cellPy, now, world);
  return { baseCount, centerPadCount };
};

const drawDynamicEntities = (
  push: PushFn,
  rockInstances: Float32Array<ArrayBuffer>,
  shieldInstances: Float32Array<ArrayBuffer>,
  orbInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
  showHp: boolean,
) => {
  let rockCount = drawRocks(rockInstances, cellPx, cellPy, now, world);
  drawMines(push, cellPx, cellPy, now, world);
  rockCount = drawShrapnel(
    rockInstances,
    rockCount,
    cellPx,
    cellPy,
    now,
    world,
  );
  const orbCount = drawPickupOrbs(
    push,
    orbInstances,
    cellPx,
    cellPy,
    now,
    world,
  );
  drawBolts(push, cellPx, cellPy, world);

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

  return { rockCount, orbCount, shieldCount };
};

export const createOverlay = (): Overlay => {
  const instances = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  const rockInstances = new Float32Array(MAX_ROCKS * ROCK_LAYOUT.floats);
  const shieldInstances = new Float32Array(MAX_SHIELDS * SHIELD_LAYOUT.floats);
  const orbInstances = new Float32Array(MAX_ORBS * SHIELD_LAYOUT.floats);
  const baseInstances = new Float32Array(MAX_BASES * ROCK_LAYOUT.floats);
  const centerPadInstances = new Float32Array(
    MAX_CENTER_PADS * ROCK_LAYOUT.floats,
  );
  const { push, reset, getCount } = createPusher(instances);

  return {
    build: ({ w, h, gridW, gridH, now, world, showHp }) => {
      reset();
      const cellPx = w / gridW;
      const cellPy = h / gridH;

      // Portals go FIRST so they occupy the leading instances: the renderer
      // draws that slice before the 3D passes, letting objects fly over them.
      drawPortals(push, cellPx, cellPy, now);
      const portalCount = getCount();

      const { baseCount, centerPadCount } = drawFieldFurniture(
        push,
        baseInstances,
        centerPadInstances,
        cellPx,
        cellPy,
        now,
        world,
      );
      const { rockCount, orbCount, shieldCount } = drawDynamicEntities(
        push,
        rockInstances,
        shieldInstances,
        orbInstances,
        cellPx,
        cellPy,
        now,
        world,
        showHp,
      );

      return {
        instances,
        count: getCount(),
        portalCount,
        rockInstances,
        rockCount,
        shieldInstances,
        shieldCount,
        orbInstances,
        orbCount,
        baseInstances,
        baseCount,
        centerPadInstances,
        centerPadCount,
      };
    },
  };
};
