import type { World } from "../types";
import { arcadeStep } from "./arcade";
import { createTickCtx } from "./context";
import { finalizeTick } from "./finalize";
import {
  createHazardState,
  resolveHazardCollisions,
} from "./hazard-collisions";
import {
  createInteractionState,
  resolveFieldEffects,
  resolveInteractions,
} from "./interactions";
import { advanceMotion } from "./motion";
import { createProjectileState, resolveProjectiles } from "./projectiles";
import {
  eliminateBaselessTeams,
  resolveShipCollisions,
  shipCollisionPairs,
} from "./ship-collisions";
import { resolveWhips } from "./whips";

/** Advance the entity world by `steps` generations; returns the next world. */
export const tick = (world: World, steps: number, now: number): World => {
  const ctx = createTickCtx(world, steps, now);
  const motion = advanceMotion(ctx);
  const hazards = createHazardState();
  const interactions = createInteractionState();
  const projectiles = createProjectileState();

  // Ship×ship dogfights run through the spatial-hash broad-phase (candidate
  // pairs → live narrow-phase), bit-identical to the old nested loop but O(n)
  // once the ship cap lifts. A GPU pair list drops in here later.
  resolveShipCollisions(ctx, shipCollisionPairs(ctx));
  resolveHazardCollisions(ctx, motion, hazards);
  resolveInteractions(ctx, motion, interactions);
  resolveFieldEffects(ctx, motion, interactions, hazards);
  resolveProjectiles(ctx, motion, hazards, projectiles);
  resolveWhips(ctx, motion.whips);
  eliminateBaselessTeams(ctx);

  const next = finalizeTick(ctx, motion, hazards, interactions, projectiles);
  // Arcade rules run on the committed world (no-op in autobattle).
  return arcadeStep(next);
};
