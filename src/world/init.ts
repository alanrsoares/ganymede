import { empty } from "~/engine/entities";
import { nextRange, type Seed } from "~/engine/rng";
import { rollAsteroid, rollMany, rollPickup, rollShip } from "./factory";
import { syncField } from "./field";
import { fullBaseHp, zeroScores } from "./math";
import { SCROLL_FIELD_W } from "./scroll";
import {
  ARCADE_LIVES,
  activeTeams,
  DEFAULT_CONFIG,
  NUM_ASTEROIDS,
  NUM_PICKUPS,
  SPAWN_INVULN_GENS,
  speedForLevel,
} from "./tuning";
import {
  ARCADE_PICKUP_KINDS,
  baseByName,
  DEFAULT_GRID_H,
  type LightCycle,
  type MatchConfig,
  type RunConfig,
  type RunState,
  setOrbitPhase,
  type World,
} from "./types";

// The arcade pilot starts a rank up (3 HP, not the 2-HP L1 glass) so the
// opening wave isn't a two-hit death; respawns keep whatever rank they reached.
const PILOT_START_LEVEL = 2;

// Fresh run bookkeeping (lives/kills/augments) for a new pilot run. The wave
// director rides along only when the config brought a wave curve — a scroll
// stage supplies its enemies itself and leaves `waves` null.
const initArcadeRun = (cfg: RunConfig): RunState => ({
  lives: cfg.defeat.kind === "lives" ? cfg.defeat.count : ARCADE_LIVES,
  kills: 0,
  startAge: 0,
  over: false,
  playerLevel: PILOT_START_LEVEL,
  augments: {},
  offer: null,
  wingCd: 0,
  waves: cfg.waves
    ? {
        wave: 1,
        waveRemaining: 0,
        pending: 0,
        waveMaxLevel: 0,
        phase: "fight",
        intermissionGens: 0,
        adapt: 0,
        woundedWave: false,
      }
    : null,
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
  // Scenery is rolled onto the field (rollAsteroid places on its edges), so the
  // field has to describe this world before any of it is rolled — otherwise a
  // fresh match inherits wherever the last run's stage had scrolled to, and the
  // same seed stops meaning the same opening.
  syncField({ config, scrollY: 0, scrollHalted: false });
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
    drones: empty(),
    seed,
    score: zeroScores(),
    baseHp: fullBaseHp(config),
    rally: null,
    age: 0,
    winner: null,
    config,
    run: null,
    scrollY: 0,
    scrollHalted: false,
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

// Where the pilot starts. An arena run launches from its team base; a scroll
// stage has no bases, so it opens low and centred in the first window with the
// nose up-stage, the way a scroller opens. Forward is -y (see world/scroll.ts),
// so "low" is the larger y.
const pilotStart = (config: MatchConfig, team: string): Partial<LightCycle> => {
  if (config.format !== "scroll") {
    const base = baseByName.get(team);
    return base ? { x: base.x, y: base.y } : {};
  }
  return {
    x: SCROLL_FIELD_W / 2,
    y: DEFAULT_GRID_H * 0.72,
    dx: 0,
    dy: -1,
    vx: 0,
    vy: -speedForLevel(PILOT_START_LEVEL),
    angle: Math.atan2(0, -1),
  };
};

/**
 * Arcade world: one player ship docked at its base with control handed over, a
 * fresh run state (lives/wave), and the standard rock/pickup field. Enemy waves
 * are mustered lazily by `arcadeStep` on the first tick. `config.run` required.
 */
export function initArcadeWorld(seed0: Seed, config: MatchConfig): World {
  setOrbitPhase(0);
  const cfg = config.run;
  if (!cfg) throw new Error("initArcadeWorld: config.run is required");
  syncField({ config, scrollY: 0, scrollHalted: false });
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
  const placed = {
    ...player,
    invulnTime: SPAWN_INVULN_GENS, // spawn-in mercy window
    ...pilotStart(config, cfg.playerTeam),
  };
  const [rocks, s2] = rollMany(NUM_ASTEROIDS, s1, (s, i) =>
    rollAsteroid(s, i + 1),
  );
  const [bubbles, seed] = rollMany(NUM_PICKUPS, s2, (s, i) =>
    rollPickup(s, i + 1, ARCADE_PICKUP_KINDS),
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
    drones: empty(),
    seed,
    score: zeroScores(),
    baseHp: fullBaseHp(config),
    rally: null,
    age: 0,
    winner: null,
    config,
    run: initArcadeRun(cfg),
    scrollY: 0,
    scrollHalted: false,
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
