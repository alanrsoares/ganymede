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
// The beat is punctuated rather than cut: the corridor brakes to a stop before
// the topology swaps and winds back up after it (see `FlipPhase` in types.ts
// and the easing in scroll.ts). The camera follows the field origin, so the
// brake *is* the camera ease; the audio crossfade and the banner hang off the
// same three phases from the runtime side.

import { inField } from "./math";
import { FLIP_HALT_GENS, FLIP_RESUME_GENS } from "./scroll";
import { buildFormation, stageTravelled } from "./stage";
import type { FlipState, StageFlip, World } from "./types";

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
const clearOffscreen = (world: World): World => {
  const items = world.ships.items.filter(
    // Margin 0, not the cull's: the beat's cast is what is *on screen*, and
    // the cull's slack is exactly the band a ship would fold in from.
    (s) => s.id === world.controlledShipId || inField(s.x, s.y, 0),
  );
  const alive = new Set(items.map((s) => s.id));
  return {
    ...world,
    ships: { ...world.ships, items },
    // A reward is for shooting the formation down. One cleared off the field to
    // make room for the beat was not shot down by anyone, and `escaped` won't
    // catch it — that only rejects the wake, and this formation was ahead of
    // the window. So the debt goes with the ships.
    stageDrops: world.stageDrops.filter((d) =>
      d.ids.some((id) => alive.has(id)),
    ),
  };
};

/**
 * Start braking. Nothing about the arena is up yet — the window is still
 * sliding, so the ambush has nowhere fixed to stand and the corridor has no
 * reason to be cleared of anything. All this does is claim the beat off the
 * script (the cursor moves here, so it can never be read twice) and start the
 * clock the halt runs on.
 */
const beginHalt = (world: World, beat: StageFlip): World => ({
  ...world,
  flipCursor: world.flipCursor + 1,
  flip: {
    phase: "halt",
    gens: 0,
    maxGens: beat.maxGens,
    banner: beat.banner,
    spawns: beat.spawns,
    ids: [],
  },
});

/** Plant the beat's ambush in the now-stopped window and open act two. */
const openFight = (world: World, live: FlipState): World => {
  const cleared = clearOffscreen(world);
  let nextId = cleared.ships.nextId;
  const items = [...cleared.ships.items];
  const ids: number[] = [];
  for (const spawn of live.spawns) {
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
    flip: { ...live, phase: "fight", gens: 0, ids },
  };
};

/** True once nothing the beat is waiting on is still flying. */
const ambushWiped = (world: World, ids: readonly number[]): boolean =>
  !world.ships.items.some((s) => ids.includes(s.id));

/**
 * Carry a live beat forward one tick: run the clock on the current phase and
 * hand over to the next one when it is done.
 */
const advanceBeat = (world: World, live: FlipState, steps: number): World => {
  const gens = live.gens + steps;
  const stepped: World = { ...world, flip: { ...live, gens } };
  switch (live.phase) {
    // The corridor has stopped: swap the topology and plant the ambush.
    case "halt":
      return gens >= FLIP_HALT_GENS ? openFight(world, live) : stepped;
    // Wiped is the deal the pilot is playing to; the cap is only there so a
    // survivor that can't be reached never hangs the run.
    case "fight":
      return ambushWiped(world, live.ids) || gens >= live.maxGens
        ? { ...world, flip: { ...live, phase: "resume", gens: 0 } }
        : stepped;
    // Back up to rate, and then the beat is simply over.
    case "resume":
      return gens >= FLIP_RESUME_GENS ? { ...world, flip: null } : stepped;
  }
};

/**
 * Open or close the flip beat for this tick. Runs before the scroll advances
 * and before the field is synced, so a tick either scrolls or is fought in the
 * arena — never half of each.
 */
export const flipStep = (world: World, steps: number): World => {
  if (world.config.format !== "scroll" || world.run?.over) return world;

  // Closing a beat asks nothing of the script: a flip that is up has already
  // been read, and a world whose script went away mid-beat (a reset, a config
  // swap) must still be able to end it rather than hold the scroll forever.
  const live = world.flip;
  if (live) return advanceBeat(world, live, steps);

  const next = world.config.run?.stage?.flips?.[world.flipCursor];
  if (!next || next.at > stageTravelled(world)) return world;
  return beginHalt(world, next);
};
