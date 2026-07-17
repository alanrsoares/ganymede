// view: projects the immutable World into a flat sprite instance buffer for
// gpu.ts. Pure — it only reads world — animation is derived from `now`.

import {
  FLOATS_PER_INSTANCE,
  MAX_BASES,
  MAX_CENTER_PADS,
  MAX_INSTANCES,
  MAX_MESH_SHIPS,
  MAX_ORBS,
  MAX_PLUMES,
  MAX_ROCKS,
  MAX_SHIELDS,
  PLUME_LAYOUT,
  ROCK_LAYOUT,
  SHIELD_LAYOUT,
  SHIP_LAYOUT,
  type ShipBuckets,
} from "~/render/gpu";
import { CLIP, clipLayer } from "~/render/sprites";
import { SHIP_CLASSES, type ShipClass } from "~/ship-parts";
import type { World } from "~/world";
import {
  drawBases,
  drawCenterPad,
  drawHealPads,
  drawLockReticle,
  drawPortals,
  drawRallyBeacon,
} from "./field";
import { drawMines, drawPickupOrbs, drawRocks, drawShrapnel } from "./hazards";
import { drawBolts, drawBursts, drawDrones, drawMissiles } from "./projectiles";
import { createPusher, type PushFn } from "./push";
import { drawShips } from "./ships";
import { drawWhips } from "./whips";

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
    ships: ShipBuckets;
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
  drawLockReticle(push, cellPx, cellPy, now, world);
  return { baseCount, centerPadCount };
};

const drawDynamicEntities = (
  push: PushFn,
  rockInstances: Float32Array<ArrayBuffer>,
  shieldInstances: Float32Array<ArrayBuffer>,
  orbInstances: Float32Array<ArrayBuffer>,
  ships: ShipBuckets,
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
  drawBolts(push, cellPx, cellPy, now, world);

  const exhaustL = clipLayer(CLIP.exhaust, 0, now);
  drawMissiles(push, cellPx, cellPy, now, world, exhaustL);
  const shieldCount = drawShips(
    push,
    shieldInstances,
    ships,
    cellPx,
    cellPy,
    now,
    world,
    showHp,
  );
  drawWhips(push, cellPx, cellPy, now, world);
  drawDrones(push, cellPx, cellPy, now, world);
  drawBursts(push, cellPx, cellPy, now, world);

  return { rockCount, orbCount, shieldCount };
};

// Per-class hull instance buffers for the 3D ship passes.
const createShipBuckets = (): ShipBuckets => ({
  instances: Object.fromEntries(
    SHIP_CLASSES.map((cls) => [
      cls,
      new Float32Array(MAX_MESH_SHIPS * SHIP_LAYOUT.floats),
    ]),
  ) as Record<ShipClass, Float32Array<ArrayBuffer>>,
  counts: Object.fromEntries(SHIP_CLASSES.map((cls) => [cls, 0])) as Record<
    ShipClass,
    number
  >,
  plumes: new Float32Array(MAX_PLUMES * PLUME_LAYOUT.floats),
  plumeCount: 0,
});

// One frame's worth of reusable instance arrays (overwritten every build).
// Key names match the build() return shape so the frame can spread them.
const createOverlayBuffers = () => ({
  instances: new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE),
  rockInstances: new Float32Array(MAX_ROCKS * ROCK_LAYOUT.floats),
  shieldInstances: new Float32Array(MAX_SHIELDS * SHIELD_LAYOUT.floats),
  orbInstances: new Float32Array(MAX_ORBS * SHIELD_LAYOUT.floats),
  baseInstances: new Float32Array(MAX_BASES * ROCK_LAYOUT.floats),
  centerPadInstances: new Float32Array(MAX_CENTER_PADS * ROCK_LAYOUT.floats),
  ships: createShipBuckets(),
});

export const createOverlay = (): Overlay => {
  const bufs = createOverlayBuffers();
  const { push, reset, getCount } = createPusher(bufs.instances);

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
        bufs.baseInstances,
        bufs.centerPadInstances,
        cellPx,
        cellPy,
        now,
        world,
      );
      const { rockCount, orbCount, shieldCount } = drawDynamicEntities(
        push,
        bufs.rockInstances,
        bufs.shieldInstances,
        bufs.orbInstances,
        bufs.ships,
        cellPx,
        cellPy,
        now,
        world,
        showHp,
      );

      return {
        ...bufs,
        count: getCount(),
        portalCount,
        rockCount,
        shieldCount,
        orbCount,
        baseCount,
        centerPadCount,
      };
    },
  };
};
