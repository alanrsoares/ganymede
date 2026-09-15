// The all-range flip beat (#31): the thesis of the whole slice.
//
// Mid-stage the scroll stops, the corridor closes into the toroidal arena, and
// act two is the game Ganymede has always been — the same 480x270 torus, the
// same ring of furniture, a stage-length up the y axis. No entity coordinate
// moves across the flip. Six numbers on ARENA change (see field.ts) and every
// rule that reads them follows: the walls the pilot was held inside become
// wraps, the cull that killed the wake stops rejecting anything, and the ring
// re-centres on the window.
//
// The beat ends when the ambush is wiped, and the corridor resumes from exactly
// where it stopped. This module owns entry and exit; everything else about the
// flip is a consequence of `World.flip` being non-null.
//
// Not here yet, and owed before the verdict in #32: the camera ease, the audio
// crossfade (`sceneFor` in main.ts), and putting `flip.banner` on screen. This
// is the hard cut — the topology swap, flown, on its own.

import { inField } from "./math";
import { buildFormation, stageTravelled } from "./stage";
import type { StageFlip, World } from "./types";

/**
 * Clear the corridor as the beat opens. Formations already flying beyond the
 * window would otherwise wrap in from the far edge the instant both axes close
 * — a ship materialising at the bottom of the screen with no run-in. The wake
 * behind the camera is the same problem mirrored. So the window's contents are
 * act two's cast, and the rest of the corridor is dropped the way the cull
 * would have dropped it a moment later anyway.
 *
 * Read while the field is still the open corridor, so `inField` still has an
 * outside to reject.
 */
const clearOffscreen = (world: World): World => ({
  ...world,
  ships: {
    ...world.ships,
    items: world.ships.items.filter(
      // Margin 0, not the cull's: the beat's cast is what is *on screen*, and
      // the cull's slack is exactly the band a ship would fold in from.
      (s) => s.id === world.controlledShipId || inField(s.x, s.y, 0),
    ),
  },
});

/** Plant the beat's ambush in the window and open the state that holds it up. */
const openFlip = (world: World, beat: StageFlip): World => {
  const cleared = clearOffscreen(world);
  let nextId = cleared.ships.nextId;
  const items = [...cleared.ships.items];
  const ids: number[] = [];
  for (const spawn of beat.spawns) {
    // `spawn.y` is measured down from the window's top edge; the window's top
    // edge is the live scroll position, which is where it stops for the beat.
    const flight = buildFormation(
      cleared,
      spawn,
      nextId,
      world.scrollY + spawn.y,
    );
    items.push(...flight);
    ids.push(...flight.map((s) => s.id));
    nextId += spawn.count;
  }
  return {
    ...cleared,
    ships: { items, nextId },
    flipCursor: cleared.flipCursor + 1,
    flip: {
      gens: 0,
      maxGens: beat.maxGens,
      banner: beat.banner,
      ids,
    },
  };
};

/** True once nothing the beat is waiting on is still flying. */
const ambushWiped = (world: World, ids: readonly number[]): boolean =>
  !world.ships.items.some((s) => ids.includes(s.id));

/**
 * Open or close the flip beat for this tick. Runs before the scroll advances
 * and before the field is synced, so a tick either scrolls or is fought in the
 * arena — never half of each.
 */
export const flipStep = (world: World, steps: number): World => {
  if (world.config.format !== "scroll" || world.run?.over) return world;
  const script = world.config.run?.stage;
  if (!script?.flips) return world;

  const live = world.flip;
  if (live) {
    const gens = live.gens + steps;
    // Wiped is the deal the pilot is playing to; the cap is only there so a
    // survivor that can't be reached never hangs the run.
    if (ambushWiped(world, live.ids) || gens >= live.maxGens)
      return { ...world, flip: null };
    return { ...world, flip: { ...live, gens } };
  }

  const next = script.flips[world.flipCursor];
  if (!next || next.at > stageTravelled(world)) return world;
  return openFlip(world, next);
};
