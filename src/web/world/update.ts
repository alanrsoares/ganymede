import { assertNever } from "@onrails/pattern";
import { nextInt } from "../engine/rng";
import { MATCH_REINFORCE_GENS, rollShip, speedForLevel } from "./factory";
import { initWorld, spawnShip } from "./init";
import { tick } from "./tick";
import {
  baseByName,
  type Cmd,
  GRID_H,
  GRID_W,
  type Msg,
  TEAMS,
  type World,
} from "./types";

const launchSpec = (
  dir: "a" | "b" | "c" | "d",
): { x: number; y: number; color: string; dx: number; dy: number } => {
  switch (dir) {
    case "a":
      return { x: 15, y: 135, color: "cyan", dx: 1, dy: 0 };
    case "b":
      return { x: GRID_W - 15, y: 70, color: "orange", dx: -1, dy: 0 };
    case "c":
      return { x: 240, y: 15, color: "emerald", dx: 0, dy: 1 };
    default:
      return { x: 300, y: GRID_H - 15, color: "yellow", dx: 0, dy: -1 };
  }
};

/** Launch a fresh L1 ship from the requested edge, heading inward. */
const launchShip = (world: World, dir: "a" | "b" | "c" | "d"): World => {
  const spec = launchSpec(dir);
  const cruise = speedForLevel(1);
  return spawnShip(world, spec.x, spec.y, spec.color, {
    dx: spec.dx,
    dy: spec.dy,
    vx: spec.dx * cruise,
    vy: spec.dy * cruise,
    angle: Math.atan2(spec.dx, spec.dy),
  });
};

/** The eligible (base alive) team with the fewest ships, tiebroken by low score. */
const underdogTeam = (world: World): string | null => {
  const eligible = TEAMS.filter((t) => (world.baseHp[t.name] ?? 0) > 0);
  if (eligible.length === 0) return null;
  const counts = new Map<string, number>(eligible.map((t) => [t.name, 0]));
  for (const s of world.ships.items) {
    if (counts.has(s.colorName))
      counts.set(s.colorName, (counts.get(s.colorName) ?? 0) + 1);
  }
  return [...eligible].sort((a, b) => {
    const dc = (counts.get(a.name) ?? 0) - (counts.get(b.name) ?? 0);
    return dc !== 0
      ? dc
      : (world.score[a.name] ?? 0) - (world.score[b.name] ?? 0);
  })[0].name;
};

/** Spawn one reinforcement onto the underdog team's base (no-op in sudden death). */
const reinforceUnderdog = (world: World): World => {
  if (world.age >= MATCH_REINFORCE_GENS) return world;
  const name = underdogTeam(world);
  if (name === null) return world;
  const [ship, seed] = rollShip(world.seed, world.ships.nextId, 0, 0, 1, name);
  const base = baseByName.get(ship.colorName);
  const placed = base ? { ...ship, x: base.x, y: base.y } : ship;
  return {
    ...world,
    seed,
    ships: {
      items: [...world.ships.items, placed],
      nextId: world.ships.nextId + 1,
    },
  };
};

export const update = (msg: Msg, world: World): [World, Cmd[]] => {
  switch (msg.kind) {
    case "tick":
      return tick(world, msg.steps, msg.now);
    case "launch":
      return [launchShip(world, msg.dir), []];
    case "drop":
      return [spawnShip(world, msg.x, msg.y), []];
    case "reset":
      return [initWorld(nextInt(world.seed, 2 ** 31)[0]), []];
    case "replenish":
      return [reinforceUnderdog(world), []];
    default:
      return assertNever(msg);
  }
};
