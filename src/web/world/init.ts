import { empty } from "../engine/entities";
import type { Seed } from "../engine/rng";
import {
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
import type { LightCycle, World } from "./types";

const INITIAL_SHIPS = 6;

/** Initial world: six ships scattered across the field, seeded from `seed0`. */
export const initWorld = (seed0: Seed): World => {
  const [items, s1] = rollMany(INITIAL_SHIPS, seed0, (s, i) => {
    const [x, y, sp] = rollPosition(s);
    return rollShip(sp, i + 1, x, y, 1);
  });
  const [rocks, s2] = rollMany(NUM_ASTEROIDS, s1, (s, i) =>
    rollAsteroid(s, i + 1),
  );
  const [bubbles, seed] = rollMany(NUM_PICKUPS, s2, (s, i) =>
    rollPickup(s, i + 1),
  );
  return {
    ships: { items, nextId: INITIAL_SHIPS + 1 },
    bursts: empty(),
    asteroids: { items: rocks, nextId: NUM_ASTEROIDS + 1 },
    pickups: { items: bubbles, nextId: NUM_PICKUPS + 1 },
    projectiles: empty(),
    mines: empty(),
    bullets: empty(),
    missiles: empty(),
    seed,
    score: zeroScores(),
    baseHp: fullBaseHp(),
    age: 0,
    winner: null,
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
