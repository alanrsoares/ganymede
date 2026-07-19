// Arcade phase machine: pilot-first wave survival, run as a pure World→World
// transform after the tick pipeline commits (see tick/index.ts). Owns wave
// spawning, wave-clear detection, and player death → lives/respawn/game-over.
// No-op unless `world.config.format === "arcade"`. See docs/arcade-mode-plan.md.

import { nextRange } from "~/engine/rng";
import { augCount, augMul, rollOffer } from "~/world/augments";
import { rollShip } from "~/world/factory";
import {
  activeTeams,
  BASE_MAX_HP,
  HANDICAP_ADAPT_MAX,
  HANDICAP_CLEAN_STEP,
  HANDICAP_DEATH_STEP,
  MAX_ENEMY_SHIPS,
  SPAWN_INVULN_GENS,
  WING_MAX,
  WING_RESPAWN_CD,
} from "~/world/tuning";
import {
  type ArcadeConfig,
  type ArcadeState,
  baseByName,
  type LightCycle,
  MAX_LEVEL,
  type World,
} from "~/world/types";

// Half-width of the square a spawned ship scatters in around its base (cells).
const SPAWN_SPREAD = 7;

/** Alive ships whose team is in `teams`. */
const countTeams = (
  ships: readonly LightCycle[],
  teams: ReadonlySet<string>,
): number => ships.reduce((n, s) => (teams.has(s.colorName) ? n + 1 : n), 0);

/** Append one ship rolled for `color` at level `lvl`, docked at that base. */
function spawnAt(
  world: World,
  color: string,
  lvl: number,
  archetype?: LightCycle["archetype"],
  invuln = 0,
): { world: World; id: number } {
  const id = world.ships.nextId;
  const [ship, s1] = rollShip(
    world.seed,
    id,
    0,
    0,
    lvl,
    color,
    archetype,
    activeTeams(world.config),
  );
  const base = baseByName.get(color);
  const [ox, s2] = nextRange(s1, -SPAWN_SPREAD, SPAWN_SPREAD);
  const [oy, seed] = nextRange(s2, -SPAWN_SPREAD, SPAWN_SPREAD);
  const spot = base
    ? { ...ship, x: base.x + ox, y: base.y + oy, invulnTime: invuln }
    : { ...ship, invulnTime: invuln };
  // Player-team spawns inherit the run's hull/plating augments (fleet-wide:
  // pilot, respawns, mustered escorts). Empty stack = identity, so this is a
  // no-op until a pick lands. Offense augments apply at the pilot's per-shot
  // read sites, not here.
  const stacks =
    world.arcade && color === world.config.arcade?.playerTeam
      ? world.arcade.augments
      : null;
  const placed = stacks
    ? {
        ...spot,
        maxHp: Math.round(spot.maxHp * augMul(stacks, "hp")),
        hp: Math.round(spot.hp * augMul(stacks, "hp")),
        maxShield: Math.round(spot.maxShield * augMul(stacks, "shield")),
        shield: Math.round(spot.shield * augMul(stacks, "shield")),
      }
    : spot;
  return {
    world: {
      ...world,
      seed,
      ships: { items: [...world.ships.items, placed], nextId: id + 1 },
    },
    id,
  };
}

/** Spawn `count` enemies split round-robin across the enemy teams. */
function spawnWave(
  world: World,
  cfg: ArcadeConfig,
  count: number,
  maxLevel: number,
): World {
  let next = world;
  for (let i = 0; i < count; i++) {
    const team = cfg.enemyTeams[i % cfg.enemyTeams.length];
    // Roll a level in [1, maxLevel] off the world seed (deterministic).
    const [lvlF, seed] = nextRange(next.seed, 1, maxLevel + 0.999);
    next = spawnAt({ ...next, seed }, team, Math.floor(lvlF)).world;
  }
  return next;
}

/** Respawn the player at `lvl` at their base (with i-frames) and hand control. */
function respawnPlayer(world: World, cfg: ArcadeConfig, lvl: number): World {
  const { world: next, id } = spawnAt(
    world,
    cfg.playerTeam,
    lvl,
    cfg.playerArchetype,
    SPAWN_INVULN_GENS,
  );
  return { ...next, controlledShipId: id };
}

/** True while the controlled ship is still on the field. */
const playerAlive = (world: World): boolean =>
  world.controlledShipId !== null &&
  world.ships.items.some((s) => s.id === world.controlledShipId);

/** Burn a life; respawn the pilot, or latch game-over when lives run out. */
function loseLife(world: World, a: ArcadeState, cfg: ArcadeConfig): World {
  const lives = a.lives - 1;
  if (lives <= 0) return { ...world, arcade: { ...a, lives: 0, over: true } };
  // Respawn at the rank the pilot had reached — dying costs a life, not progress —
  // and nudge the adaptive handicap up (and mark the wave wounded).
  const adapt = Math.min(HANDICAP_ADAPT_MAX, a.adapt + HANDICAP_DEATH_STEP);
  return {
    ...respawnPlayer(world, cfg, a.playerLevel),
    arcade: { ...a, lives, adapt, woundedWave: true },
  };
}

/**
 * Fight-phase wave machine: muster the current wave when the field is clear,
 * otherwise track kills and advance the wave once the last enemy falls.
 */
function advanceWave(
  world: World,
  a: ArcadeState,
  cfg: ArcadeConfig,
  enemyCount: number,
): World {
  // Muster a fresh wave: field clear of enemies AND none held in reserve AND no
  // augment offer pending (the wave-clear pick freezes progression until the
  // player chooses). Spawn up to the on-field budget; the rest wait in `pending`
  // and trickle in below as enemies die, so late waves stay dense.
  if (
    a.waveRemaining === 0 &&
    a.pending === 0 &&
    a.offer === null &&
    enemyCount === 0
  ) {
    const { count, maxLevel } = cfg.waves.spawn(a.wave);
    const now = Math.min(count, MAX_ENEMY_SHIPS);
    const spawned = spawnWave(world, cfg, now, maxLevel);
    return {
      ...spawned,
      arcade: {
        ...a,
        waveRemaining: now,
        pending: count - now,
        waveMaxLevel: maxLevel,
      },
    };
  }
  // Enemies only leave the field by dying now (the ship trim guards them from
  // eviction), so a drop in the live count is a real kill — no phantom kills.
  const kills = a.kills + Math.max(0, a.waveRemaining - enemyCount);

  // Trickle: refill open slots from the reserve as the front thins.
  let next = world;
  let alive = enemyCount;
  let pending = a.pending;
  if (pending > 0) {
    const room = Math.min(pending, Math.max(0, MAX_ENEMY_SHIPS - enemyCount));
    if (room > 0) {
      next = spawnWave(world, cfg, room, a.waveMaxLevel);
      alive = enemyCount + room;
      pending = pending - room;
    }
  }

  if (alive === 0 && pending === 0 && a.waveRemaining > 0) {
    // Wave cleared → advance and offer an augment. The offer freezes the next
    // muster (see the gate above) until the player picks. A clean clear (no
    // death this wave) eases the adaptive handicap back toward the base.
    const adapt = a.woundedWave
      ? a.adapt
      : Math.max(0, a.adapt - HANDICAP_CLEAN_STEP);
    const { offer, seed } = rollOffer(next.seed);
    return {
      ...next,
      seed,
      // The lull between waves is a yard-crew moment: whatever the wave chipped
      // off the home base is patched back to full before the next muster.
      baseHp: { ...next.baseHp, [cfg.playerTeam]: BASE_MAX_HP },
      arcade: {
        ...a,
        wave: a.wave + 1,
        waveRemaining: 0,
        pending: 0,
        kills,
        adapt,
        woundedWave: false,
        offer,
      },
    };
  }
  return { ...next, arcade: { ...a, waveRemaining: alive, pending, kills } };
}

// Roll one escort drone at the player base and flag it a droneShip (a small,
// short-firing AI wingman). Reuses spawnAt so it inherits the fleet's hull/
// plating augments and the base-spawn spread.
const spawnWingDrone = (
  world: World,
  cfg: ArcadeConfig,
  level: number,
): World => {
  const { world: w2, id } = spawnAt(
    world,
    cfg.playerTeam,
    level,
    "scout",
    SPAWN_INVULN_GENS,
  );
  return {
    ...w2,
    ships: {
      ...w2.ships,
      items: w2.ships.items.map((s) =>
        s.id === id ? { ...s, droneShip: true } : s,
      ),
    },
  };
};

// Keep the escort wing (Wing augment) staffed: hold up to WING_MAX drones at the
// pilot's side, respawning one on a cooldown when the count drops. Stacks past
// the cap level the drones up instead of adding more. No-op without the augment.
const maintainWing = (world: World, cfg: ArcadeConfig): World => {
  const a = world.arcade;
  if (!a) return world;
  const wing = augCount(a.augments, "wing");
  if (wing <= 0) return world;
  const target = Math.min(wing, WING_MAX);
  const alive = world.ships.items.filter(
    (s) =>
      s.droneShip &&
      s.colorName === cfg.playerTeam &&
      s.id !== world.controlledShipId,
  ).length;
  if (alive >= target) return world;
  if (a.wingCd > 0) return { ...world, arcade: { ...a, wingCd: a.wingCd - 1 } };
  const level = Math.min(MAX_LEVEL, 1 + Math.max(0, wing - WING_MAX));
  const spawned = spawnWingDrone(world, cfg, level);
  return {
    ...spawned,
    arcade: { ...a, wingCd: WING_RESPAWN_CD },
  };
};

export function arcadeStep(world: World): World {
  const a = world.arcade;
  const cfg = world.config.arcade;
  if (!a || !cfg || a.over) return world;

  if (!playerAlive(world)) return maintainWing(loseLife(world, a, cfg), cfg);

  // Stash the live pilot's rank so a respawn can restore it (see loseLife).
  const me = world.ships.items.find((s) => s.id === world.controlledShipId);
  const a2 =
    me && me.level !== a.playerLevel ? { ...a, playerLevel: me.level } : a;

  const enemyCount = countTeams(world.ships.items, new Set(cfg.enemyTeams));
  // Intermission (a2.phase === "intermission") arrives in Phase 2.
  const stepped =
    a2.phase === "fight"
      ? advanceWave(world, a2, cfg, enemyCount)
      : { ...world, arcade: a2 };
  return maintainWing(stepped, cfg);
}
