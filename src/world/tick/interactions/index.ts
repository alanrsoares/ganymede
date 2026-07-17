import { spawnDroneBolt } from "~/world/factory";
import { gridNeighbors } from "~/world/tick/broadphase";
import type { TickCtx } from "~/world/tick/context";
import type { MotionState } from "~/world/tick/motion";
import { DRONE_FIRE_COOLDOWN } from "~/world/tuning";
import { ARENA } from "~/world/types";
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
    healAtPad(s, steps);
    finishAtCenterPad(ctx, s, steps);
    pullTowardPortalHorizon(s, steps);
    applyBaseGravity(ctx, s, steps);
    applyStarGravity(s, steps);
    teleportThroughPortal(s);
    [mineId, seed] = dropMine(ctx, s, mines, mineId, seed, steps);
    dockAtHomeBase(ctx, s, steps);
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
