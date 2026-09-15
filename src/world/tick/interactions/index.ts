import { spawnDroneBolt } from "~/world/factory";
import { hasArenaFurniture, hasBaseObjective } from "~/world/field";
import { gridNeighbors } from "~/world/tick/broadphase";
import type { TickCtx } from "~/world/tick/context";
import type { MotionState } from "~/world/tick/motion";
import { DRONE_FIRE_COOLDOWN } from "~/world/tuning";
import { ARENA, type LightCycle, type Mutable } from "~/world/types";
import {
  AURA_BAND,
  applyForceFieldAuras,
  leechCarrierFuel,
  shareCarrierFuel,
  shareReconIntel,
} from "./auras";
import {
  applyBaseGravity,
  applyStarGravity,
  dockAtHomeBase,
  dropMine,
  finishAtCenterPad,
  healAtPad,
  pullTowardPortalHorizon,
  teleportThroughPortal,
} from "./field";
import { collectPickups, nearestEnemyToDrone } from "./pickups";
import type { InteractionState } from "./state";
import { fireArc, fireMissile, fireWeapon } from "./weapons";

export {
  applyForceFieldAuras,
  leechCarrierFuel,
  shareCarrierFuel,
  shareReconIntel,
} from "./auras";
export { resolveFieldEffects } from "./field";
export { createInteractionState, type InteractionState } from "./state";

// Everything one ship gets from the ring of furniture it is flying around: pad
// healing, portal and base gravity, the portal hop. The ring is centred on the
// field, so a scrolling corridor has none of it and the flip beat has all of it
// — the pull has to be as present or absent as the picture is.
const resolveTerrain = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  steps: number,
): void => {
  healAtPad(s, steps);
  pullTowardPortalHorizon(s, steps);
  applyBaseGravity(ctx, s, steps);
  applyStarGravity(s, steps);
  teleportThroughPortal(s);
};

// The raid on top of the terrain: promoting at the centre pad and docking at
// home to refuel and cash in. Arena only — the flip beat borrows the arena's
// furniture for a fight, not its economy (hasBaseObjective), and a world with
// the raid on always has the terrain it sits on.
const resolveFurniture = (
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  steps: number,
  raid: boolean,
): void => {
  resolveTerrain(ctx, s, steps);
  if (!raid) return;
  finishAtCenterPad(ctx, s, steps);
  dockAtHomeBase(ctx, s, steps);
};

/** Weapons, pickups, portals, mines, home base, and force-field auras. */
export const resolveInteractions = (
  ctx: TickCtx,
  motion: MotionState,
  interactions: InteractionState,
) => {
  const { moved, removed, steps } = ctx;
  const { bubbles, mines, bullets, missiles, drones } = motion;
  const { takenPickups } = interactions;
  let seed = ctx.seed;
  let { bulletId, missileId, mineId } = motion;
  const terrain = hasArenaFurniture(ctx.world);
  const raid = hasBaseObjective(ctx.world);

  for (const s of moved) {
    if (removed.has(s.id)) continue;
    bulletId = fireWeapon(ctx, s, bullets, bulletId);
    [missileId, seed] = fireMissile(ctx, s, missiles, missileId, seed);
    seed = fireArc(ctx, s, seed);
    missileId = collectPickups(
      ctx,
      s,
      bubbles,
      takenPickups,
      missiles,
      missileId,
    );
    if (terrain) resolveFurniture(ctx, s, steps, raid);
    [mineId, seed] = dropMine(ctx, s, mines, mineId, seed, steps);
  }

  // Escort drones auto-fire at the nearest enemy in range (bolts go through the
  // normal bullet pipeline, so they hit/credit like any bolt).
  for (const d of drones) {
    if (d.fireCooldown > 0) continue;
    const foe = nearestEnemyToDrone(d, moved, removed);
    if (!foe) continue;
    bullets.push(spawnDroneBolt(bulletId, d, foe.x, foe.y));
    bulletId += 1;
    d.fireCooldown = DRONE_FIRE_COOLDOWN;
  }

  // One neighbour grid over the (now settled) ship positions for every aura pass.
  const nbr = gridNeighbors(moved, ARENA, AURA_BAND);
  applyForceFieldAuras(ctx, nbr);
  shareCarrierFuel(ctx, nbr);
  leechCarrierFuel(ctx, nbr);
  shareReconIntel(ctx, nbr);

  ctx.seed = seed;
  motion.bulletId = bulletId;
  motion.missileId = missileId;
  motion.mineId = mineId;
};
