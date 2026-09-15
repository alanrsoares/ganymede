import { syncField } from "~/world/field";
import { flipSlice, flipStep } from "~/world/flip";
import { advanceScroll, scrollStep } from "~/world/scroll";
import { stageStep } from "~/world/stage";
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

const tickOnce = (world: World, steps: number, now: number): World => {
  // Stage first, then the field it implies: everything below wraps and culls
  // against a field that already reflects this tick's scroll position. The flip
  // beat (#31) is settled before the scroll moves, so a tick is either scrolled
  // or fought in the arena — a halted scroll simply has nowhere to advance to.
  const scrolled = advanceScroll(flipStep(world, steps), steps);
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
  // stage feeds itself enemies the same way, having no bases to muster from —
  // from its authored script if it has one, from the trickle if it does not.
  return stageStep(scrollStep(arcadeStep(next), steps));
};

/**
 * Advance the entity world by `steps` generations; returns the next world.
 *
 * A tick normally takes its whole batch in one pass — every rule below scales
 * linearly in `steps`, so a dropped frame costs nothing in fidelity. The flip
 * beat is the exception (see `flipSlice`): its brake is a curve and its phases
 * have boundaries, so across one the batch is cut into slices that are each
 * exact, and the tick runs once per slice. Off a beat there is exactly one.
 */
export const tick = (world: World, steps: number, now: number): World => {
  let w = world;
  for (let left = steps; left > 0; ) {
    const slice = flipSlice(w, left);
    w = tickOnce(w, slice, now);
    left -= slice;
  }
  // A zero-step tick still resolves collisions on the world as it stands.
  return steps > 0 ? w : tickOnce(world, steps, now);
};
