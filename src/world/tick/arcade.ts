// Arcade phase machine: pilot-first wave survival, run as a pure World→World
// transform after the tick pipeline commits (see tick/index.ts). Owns wave
// spawning, wave-clear detection, and player death → lives/respawn/game-over.
// No-op unless `world.config.format === "arcade"`. See docs/arcade-mode-plan.md.

import { nextRange } from "../../engine/rng";
import { activeTeams, rollShip } from "../factory";
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
  const placed = base ? { ...ship, x: base.x + ox, y: base.y + oy } : ship;
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

/** Respawn the player fresh at their base and hand back control. */
function respawnPlayer(world: World, cfg: ArcadeConfig): World {
  const { world: next, id } = spawnAt(
    world,
    cfg.playerTeam,
    1,
    cfg.playerArchetype,
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
  return { ...respawnPlayer(world, cfg), arcade: { ...a, lives } };
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
    // Wave cleared → advance; next tick musters the harder wave.
    return {
      ...world,
      arcade: { ...a, wave: a.wave + 1, waveRemaining: 0, kills },
    };
  }
  return { ...world, arcade: { ...a, waveRemaining: enemyCount, kills } };
}

export function arcadeStep(world: World): World {
  const a = world.arcade;
  const cfg = world.config.arcade;
  if (!a || !cfg || a.over) return world;

  if (!playerAlive(world)) return loseLife(world, a, cfg);

  const enemyCount = countTeams(world.ships.items, new Set(cfg.enemyTeams));
  // Intermission (a.phase === "intermission") arrives in Phase 2.
  return a.phase === "fight" ? advanceWave(world, a, cfg, enemyCount) : world;
}
