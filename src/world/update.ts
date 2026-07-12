import { assertNever } from "@onrails/pattern";
import { nextInt } from "../engine/rng";
import { rollShip, speedForLevel } from "./factory";
import { initWorld, spawnShip } from "./init";
import { tick } from "./tick";
import {
  baseByName,
  type Cmd,
  GRID_H,
  GRID_W,
  type Msg,
  type RallyBeacon,
  TEAMS,
  type World,
} from "./types";

const RALLY_TTL = 360; // ~8s at 45 gen/s

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
      return { x: 240, y: GRID_H - 15, color: "pink", dx: 0, dy: -1 };
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
  if (world.age >= world.config.reinforceGens) return world;
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

const rallyCandidate = (
  team: string,
  ox: number,
  oy: number,
  x: number,
  y: number,
): { team: string; d2: number } => {
  const dx = ox - x;
  const dy = oy - y;
  return { team, d2: dx * dx + dy * dy };
};

const nearestRallyTeam = (
  world: World,
  x: number,
  y: number,
): string | null => {
  const live = (team: string) => (world.baseHp[team] ?? 0) > 0;
  const candidates = [
    ...world.ships.items
      .filter((s) => live(s.colorName))
      .map((s) => rallyCandidate(s.colorName, s.x, s.y, x, y)),
    ...[...baseByName.values()]
      .filter((base) => live(base.name))
      .map((base) => rallyCandidate(base.name, base.x, base.y, x, y)),
  ];
  return candidates.sort((a, b) => a.d2 - b.d2)[0]?.team ?? null;
};

const rallyTeam = (world: World, x: number, y: number): World => {
  const team = nearestRallyTeam(world, x, y);
  if (!team) return world;
  const rally: RallyBeacon = {
    team,
    x: Math.max(0, Math.min(GRID_W - 1, x)),
    y: Math.max(0, Math.min(GRID_H - 1, y)),
    ttl: RALLY_TTL,
  };
  return { ...world, rally };
};

export const update = (msg: Msg, world: World): [World, Cmd[]] => {
  switch (msg.kind) {
    case "tick":
      return tick(world, msg.steps, msg.now);
    case "launch":
      return [launchShip(world, msg.dir), []];
    case "drop":
      return [spawnShip(world, msg.x, msg.y), []];
    case "rally":
      return [rallyTeam(world, msg.x, msg.y), []];
    case "reset":
      return [initWorld(nextInt(world.seed, 2 ** 31)[0], world.config), []];
    case "replenish":
      return [reinforceUnderdog(world), []];
    default:
      return assertNever(msg);
  }
};
