import { empty } from "../engine/entities";
import { nextRange, type Seed } from "../engine/rng";
import {
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
import {
  baseByName,
  type LightCycle,
  type MatchConfig,
  setOrbitPhase,
  type World,
} from "./types";

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
    seed,
    score: zeroScores(),
    baseHp: fullBaseHp(config),
    rally: null,
    age: 0,
    winner: null,
    config,
    controlledShipId: null,
    controlKeys: {
      up: false,
      down: false,
      left: false,
      right: false,
      space: false,
    },
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
