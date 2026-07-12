import { empty } from "../engine/entities";
import type { Seed } from "../engine/rng";
import {
  activeTeams,
  DEFAULT_CONFIG,
  fullBaseHp,
  NUM_ASTEROIDS,
  NUM_PICKUPS,
  rollAsteroid,
  rollMany,
  rollPickup,
  rollPosition,
  rollShip,
  zeroScores,
} from "./factory";
import type { LightCycle, MatchConfig, World } from "./types";

/** Initial world: `config.initialShips` scattered across the field from `seed0`. */
export const initWorld = (
  seed0: Seed,
  config: MatchConfig = DEFAULT_CONFIG,
): World => {
  const teams = activeTeams(config);
  const initialShips = config.initialShips;
  const [items, s1] = rollMany(initialShips, seed0, (s, i) => {
    const [x, y, sp] = rollPosition(s);
    return rollShip(sp, i + 1, x, y, 1, undefined, undefined, teams);
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
  };
};

export const spawnShip = (
  world: World,
  x: number,
  y: number,
  forceColor?: string,
  override?: Partial<LightCycle>,
): World => {
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
};
