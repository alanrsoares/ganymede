// Arcade phase machine: pilot-first wave survival, run as a pure World→World
// transform after the tick pipeline commits (see tick/index.ts). Owns wave
// spawning, wave-clear detection, and player death → lives/respawn/game-over.
// No-op unless `world.config.format === "arcade"`. See docs/arcade-mode-plan.md.

import { nextRange } from "../../engine/rng";
import { activeTeams, rollShip } from "../factory";
import {
  HANDICAP_ADAPT_MAX,
  HANDICAP_CLEAN_STEP,
  HANDICAP_DEATH_STEP,
  SPAWN_INVULN_GENS,
} from "../tuning";
import {
  type ArcadeConfig,
  type ArcadeState,
  baseByName,
  type LightCycle,
  type World,
} from "../types";

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
  const placed = base
    ? { ...ship, x: base.x + ox, y: base.y + oy, invulnTime: invuln }
    : { ...ship, invulnTime: invuln };
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
  if (a.waveRemaining === 0 && enemyCount === 0) {
    const { count, maxLevel } = cfg.waves.spawn(a.wave);
    const spawned = spawnWave(world, cfg, count, maxLevel);
    return { ...spawned, arcade: { ...a, waveRemaining: count } };
  }
  const kills = a.kills + Math.max(0, a.waveRemaining - enemyCount);
  if (enemyCount === 0 && a.waveRemaining > 0) {
    // Wave cleared → advance; next tick musters the harder wave. A clean clear
    // (no death this wave) eases the adaptive handicap back toward the base.
    const adapt = a.woundedWave
      ? a.adapt
      : Math.max(0, a.adapt - HANDICAP_CLEAN_STEP);
    return {
      ...world,
      arcade: {
        ...a,
        wave: a.wave + 1,
        waveRemaining: 0,
        kills,
        adapt,
        woundedWave: false,
      },
    };
  }
  return { ...world, arcade: { ...a, waveRemaining: enemyCount, kills } };
}

export function arcadeStep(world: World): World {
  const a = world.arcade;
  const cfg = world.config.arcade;
  if (!a || !cfg || a.over) return world;

  if (!playerAlive(world)) return loseLife(world, a, cfg);

  // Stash the live pilot's rank so a respawn can restore it (see loseLife).
  const me = world.ships.items.find((s) => s.id === world.controlledShipId);
  const a2 =
    me && me.level !== a.playerLevel ? { ...a, playerLevel: me.level } : a;

  const enemyCount = countTeams(world.ships.items, new Set(cfg.enemyTeams));
  // Intermission (a2.phase === "intermission") arrives in Phase 2.
  return a2.phase === "fight"
    ? advanceWave(world, a2, cfg, enemyCount)
    : { ...world, arcade: a2 };
}
