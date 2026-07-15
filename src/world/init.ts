import { empty } from "../engine/entities";
import { nextRange, type Seed } from "../engine/rng";
import {
  ARCADE_LIVES,
  activeTeams,
  DEFAULT_CONFIG,
  fullBaseHp,
  NUM_ASTEROIDS,
  NUM_PICKUPS,
  rollAsteroid,
  rollMany,
  rollPickup,
  rollShip,
  zeroScores,
} from "./factory";
import { SPAWN_INVULN_GENS } from "./tuning";
import {
  type ArcadeConfig,
  type ArcadeState,
  baseByName,
  type LightCycle,
  type MatchConfig,
  setOrbitPhase,
  type World,
} from "./types";

// The arcade pilot starts a rank up (3 HP, not the 2-HP L1 glass) so the
// opening wave isn't a two-hit death; respawns keep whatever rank they reached.
const PILOT_START_LEVEL = 2;

// Fresh arcade run bookkeeping (lives/wave/phase) for a new pilot run.
const initArcadeRun = (cfg: ArcadeConfig): ArcadeState => ({
  lives: cfg.defeat.kind === "lives" ? cfg.defeat.count : ARCADE_LIVES,
  wave: 1,
  waveRemaining: 0,
  phase: "fight",
  intermissionGens: 0,
  kills: 0,
  startAge: 0,
  over: false,
  playerLevel: PILOT_START_LEVEL,
  adapt: 0,
  woundedWave: false,
});

// Half-width of the square each fresh ship spawns in, centred on its team base
// (cells). Small enough to read as "docked at base", wide enough to not stack.
const SPAWN_SPREAD = 9;

/** Initial world: `config.initialShips` mustered at their team bases from `seed0`. */
export function initWorld(
  seed0: Seed,
  config: MatchConfig = DEFAULT_CONFIG,
): World {
  // Fresh match: age 0, so the ring sits at its zero-phase orientation while we
  // muster ships onto their bases (a "reset" mid-match would otherwise carry the
  // old world's rotation into these base reads).
  setOrbitPhase(0);
  const teams = activeTeams(config);
  const initialShips = config.initialShips;
  // Roll each ship (its team is drawn from the seed), then plant it at that
  // team's base with a small jitter so a fleet musters at home, not scattered.
  const [items, s1] = rollMany(initialShips, seed0, (s, i) => {
    const [ship, s2] = rollShip(s, i + 1, 0, 0, 1, undefined, undefined, teams);
    const base = baseByName.get(ship.colorName);
    if (!base) return [ship, s2];
    const [ox, s3] = nextRange(s2, -SPAWN_SPREAD, SPAWN_SPREAD);
    const [oy, s4] = nextRange(s3, -SPAWN_SPREAD, SPAWN_SPREAD);
    return [{ ...ship, x: base.x + ox, y: base.y + oy }, s4];
  });
  const [rocks, s2] = rollMany(NUM_ASTEROIDS, s1, (s, i) =>
    rollAsteroid(s, i + 1),
  );
  const [bubbles, seed] = rollMany(NUM_PICKUPS, s2, (s, i) =>
    rollPickup(s, i + 1),
  );
  return {
    ships: { items, nextId: initialShips + 1 },
    bursts: empty(),
    asteroids: { items: rocks, nextId: NUM_ASTEROIDS + 1 },
    pickups: { items: bubbles, nextId: NUM_PICKUPS + 1 },
    projectiles: empty(),
    mines: empty(),
    bullets: empty(),
    missiles: empty(),
    whips: empty(),
    seed,
    score: zeroScores(),
    baseHp: fullBaseHp(config),
    rally: null,
    age: 0,
    winner: null,
    config,
    arcade: null,
    controlledShipId: null,
    lockedTargetId: null,
    controlKeys: {
      up: false,
      down: false,
      left: false,
      right: false,
      space: false,
    },
  };
}

const NO_KEYS = {
  up: false,
  down: false,
  left: false,
  right: false,
  space: false,
} as const;

/**
 * Arcade world: one player ship docked at its base with control handed over, a
 * fresh run state (lives/wave), and the standard rock/pickup field. Enemy waves
 * are mustered lazily by `arcadeStep` on the first tick. `config.arcade` required.
 */
export function initArcadeWorld(seed0: Seed, config: MatchConfig): World {
  setOrbitPhase(0);
  const cfg = config.arcade;
  if (!cfg) throw new Error("initArcadeWorld: config.arcade is required");
  const teams = activeTeams(config);
  const playerId = 1;
  const [player, s1] = rollShip(
    seed0,
    playerId,
    0,
    0,
    PILOT_START_LEVEL,
    cfg.playerTeam,
    cfg.playerArchetype,
    teams,
  );
  const base = baseByName.get(cfg.playerTeam);
  const placed = {
    ...player,
    invulnTime: SPAWN_INVULN_GENS, // spawn-in mercy window
    ...(base ? { x: base.x, y: base.y } : {}),
  };
  const [rocks, s2] = rollMany(NUM_ASTEROIDS, s1, (s, i) =>
    rollAsteroid(s, i + 1),
  );
  const [bubbles, seed] = rollMany(NUM_PICKUPS, s2, (s, i) =>
    rollPickup(s, i + 1),
  );
  return {
    ships: { items: [placed], nextId: playerId + 1 },
    bursts: empty(),
    asteroids: { items: rocks, nextId: NUM_ASTEROIDS + 1 },
    pickups: { items: bubbles, nextId: NUM_PICKUPS + 1 },
    projectiles: empty(),
    mines: empty(),
    bullets: empty(),
    missiles: empty(),
    whips: empty(),
    seed,
    score: zeroScores(),
    baseHp: fullBaseHp(config),
    rally: null,
    age: 0,
    winner: null,
    config,
    arcade: initArcadeRun(cfg),
    controlledShipId: playerId,
    lockedTargetId: null,
    controlKeys: { ...NO_KEYS },
  };
}

export function spawnShip(
  world: World,
  x: number,
  y: number,
  forceColor?: string,
  override?: Partial<LightCycle>,
): World {
  const [ship, seed] = rollShip(
    world.seed,
    world.ships.nextId,
    x,
    y,
    1,
    forceColor,
    undefined,
    activeTeams(world.config),
  );
  const placed = override ? { ...ship, ...override } : ship;
  return {
    ...world,
    ships: {
      items: [...world.ships.items, placed],
      nextId: world.ships.nextId + 1,
    },
    seed,
  };
}
