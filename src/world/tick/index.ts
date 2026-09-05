import { syncField } from "~/world/field";
import { advanceScroll, scrollStep } from "~/world/scroll";
import type { World } from "~/world/types";
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

/** Advance the entity world by `steps` generations; returns the next world. */
export const tick = (world: World, steps: number, now: number): World => {
  // Stage first, then the field it implies: everything below wraps and culls
  // against a field that already reflects this tick's scroll position.
  const scrolled = advanceScroll(world, steps);
  syncField(scrolled);
  const ctx = createTickCtx(scrolled, steps, now);
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
  eliminateBaselessTeams(ctx);

  const next = finalizeTick(ctx, motion, hazards, interactions, projectiles);
  // Arcade rules run on the committed world (no-op in autobattle); a scroll
  // stage feeds itself enemies the same way, having no bases to muster from.
  return scrollStep(arcadeStep(next), steps);
};
