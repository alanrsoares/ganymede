// Target lock for the piloted ship (arcade / manual control). The tick auto-
// acquires the nearest in-range enemy and auto-advances when it dies or leaves
// range (resolveLock); the player cycles manually (cycleLock). Fire hard-locks
// onto the result. All deterministic — pure functions of world + positions.
import { wrapDelta } from "~/engine/physics";
import type { EntityList } from "../engine/entities";
import { ARENA, type LightCycle, type World } from "./types";

export const LOCK_RANGE = 260; // px; only enemies this close can be locked

const dist = (a: LightCycle, b: LightCycle): number =>
  Math.hypot(wrapDelta(a.x, b.x, ARENA.w), wrapDelta(a.y, b.y, ARENA.h));

// Live enemies of `me` within lock range, nearest first (id breaks ties so the
// order is stable across ticks and cycling is predictable).
const lockable = (
  me: LightCycle,
  ships: EntityList<LightCycle>,
): LightCycle[] =>
  ships.items
    .filter((e) => e.colorName !== me.colorName && dist(me, e) <= LOCK_RANGE)
    .sort((a, b) => dist(me, a) - dist(me, b) || a.id - b.id);

// Keep the current lock while it stays valid + in range, otherwise fall to the
// nearest enemy (or null). Drives both auto-lock and auto-advance.
export const resolveLock = (
  world: World,
  ships: EntityList<LightCycle>,
): number | null => {
  const me =
    world.controlledShipId == null
      ? null
      : ships.items.find((s) => s.id === world.controlledShipId);
  if (!me) return null;
  const list = lockable(me, ships);
  return world.lockedTargetId != null &&
    list.some((e) => e.id === world.lockedTargetId)
    ? world.lockedTargetId
    : (list[0]?.id ?? null);
};

// Cycle to the next lockable enemy relative to the current lock (dir +1 / -1).
export const cycleLock = (world: World, dir: 1 | -1): number | null => {
  const me =
    world.controlledShipId == null
      ? null
      : world.ships.items.find((s) => s.id === world.controlledShipId);
  if (!me) return world.lockedTargetId;
  const list = lockable(me, world.ships);
  if (list.length === 0) return null;
  const idx = list.findIndex((e) => e.id === world.lockedTargetId);
  if (idx === -1) return (dir === 1 ? list[0] : list[list.length - 1]).id;
  return list[(idx + dir + list.length) % list.length].id;
};
