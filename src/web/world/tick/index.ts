import type { Cmd, World } from "../types";
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
} from "./ship-collisions";

/** Advance the entity world by `steps` CA generations; returns [world, cmds]. */
export const tick = (
  world: World,
  steps: number,
  now: number,
): [World, Cmd[]] => {
  const ctx = createTickCtx(world, steps, now);
  const motion = advanceMotion(ctx);
  const hazards = createHazardState();
  const interactions = createInteractionState();
  const projectiles = createProjectileState();

  resolveShipCollisions(ctx);
  resolveHazardCollisions(ctx, motion, hazards);
  resolveInteractions(ctx, motion, interactions);
  resolveFieldEffects(ctx, motion, interactions, hazards);
  resolveProjectiles(ctx, motion, hazards, projectiles);
  eliminateBaselessTeams(ctx);

  return finalizeTick(ctx, motion, hazards, interactions, projectiles);
};
