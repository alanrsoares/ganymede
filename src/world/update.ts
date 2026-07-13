import { assertNever } from "@onrails/pattern";
import { nextInt } from "../engine/rng";
import {
  carriesMissiles,
  fireCooldownFor,
  MINE_ARM,
  MINE_LIFE,
  OVERCHARGE_MULT,
  rollShip,
  shipRadius,
  spawnBullet,
  spawnEmpMissile,
  spawnMissile,
  speedForLevel,
  weaponFor,
  wrap,
} from "./factory";
import { initWorld, spawnShip } from "./init";
import { tick } from "./tick";
import {
  ARENA,
  BURST_MUZZLE,
  type Bullet,
  type Burst,
  baseByName,
  type LightCycle,
  MAX_LEVEL,
  type Mine,
  type Missile,
  type Msg,
  type RallyBeacon,
  setOrbitPhase,
  TEAMS,
  type World,
} from "./types";

const RALLY_TTL = 360; // ~8s at 45 gen/s

type LaunchSpec = {
  x: number;
  y: number;
  color: string;
  dx: number;
  dy: number;
};

function launchSpec(dir: "a" | "b" | "c" | "d"): LaunchSpec {
  switch (dir) {
    case "a":
      return { x: 15, y: 135, color: "cyan", dx: 1, dy: 0 };
    case "b":
      return { x: ARENA.w - 15, y: 70, color: "orange", dx: -1, dy: 0 };
    case "c":
      return { x: 240, y: 15, color: "emerald", dx: 0, dy: 1 };
    default:
      return { x: 240, y: ARENA.h - 15, color: "pink", dx: 0, dy: -1 };
  }
}

/** Launch a fresh L1 ship from the requested edge, heading inward. */
function launchShip(world: World, dir: "a" | "b" | "c" | "d"): World {
  const spec = launchSpec(dir);
  const cruise = speedForLevel(1);
  return spawnShip(world, spec.x, spec.y, spec.color, {
    dx: spec.dx,
    dy: spec.dy,
    vx: spec.dx * cruise,
    vy: spec.dy * cruise,
    angle: Math.atan2(spec.dx, spec.dy),
  });
}

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
function reinforceUnderdog(world: World): World {
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
}

type RallyCandidate = { team: string; d2: number };

function rallyCandidate(
  team: string,
  ox: number,
  oy: number,
  x: number,
  y: number,
): RallyCandidate {
  const dx = ox - x;
  const dy = oy - y;
  return { team, d2: dx * dx + dy * dy };
}

function nearestRallyTeam(world: World, x: number, y: number): string | null {
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
}

function rallyTeam(world: World, x: number, y: number): World {
  const team = nearestRallyTeam(world, x, y);
  if (!team) return world;
  const rally: RallyBeacon = {
    team,
    x: Math.max(0, Math.min(ARENA.w - 1, x)),
    y: Math.max(0, Math.min(ARENA.h - 1, y)),
    ttl: RALLY_TTL,
  };
  return { ...world, rally };
}

function handleFire(
  s: LightCycle,
  nextShips: LightCycle[],
  idx: number,
  nextBullets: Bullet[],
  nextBursts: Burst[],
  bulletId: number,
  burstId: number,
): [number, number] {
  if (s.fireCooldown > 0) return [bulletId, burstId];
  const wp = weaponFor(s.archetype, s.level);
  const tx = s.x + s.dx * 100;
  const ty = s.y + s.dy * 100;

  const shots = wp.pattern === "burst" ? 1 : wp.barrels;
  const mid = (shots - 1) / 2;
  let nextIdBullets = bulletId;
  let nextIdBursts = burstId;
  for (let i = 0; i < shots; i++) {
    const bolt = spawnBullet(nextIdBullets, s, tx, ty, (i - mid) * wp.spread);
    nextBullets.push(bolt);

    const muzzle = shipRadius(s.level) + 1;
    const burstAngle = bolt.angle;
    nextBursts.push({
      id: nextIdBursts++,
      x: Math.floor(wrap(s.x + Math.sin(burstAngle) * muzzle, ARENA.w)),
      y: Math.floor(wrap(s.y + Math.cos(burstAngle) * muzzle, ARENA.h)),
      kind: BURST_MUZZLE,
      rgb: s.color,
      rot: burstAngle,
      start: performance.now(),
      variant: 0,
    });
    nextIdBullets++;
  }

  const oc = s.overchargeTime > 0 ? OVERCHARGE_MULT : 1;
  const full = fireCooldownFor(s.archetype, s.level) * oc;
  let nextBurstCount = s.burstCount;
  let nextFireCooldown = full;
  if (wp.pattern === "burst") {
    nextBurstCount += 1;
    if (nextBurstCount >= wp.burstShots) {
      nextBurstCount = 0;
      nextFireCooldown = full;
    } else {
      nextFireCooldown = wp.burstGap * oc;
    }
  }

  nextShips[idx] = {
    ...s,
    fireCooldown: nextFireCooldown,
    burstCount: nextBurstCount,
  };
  return [nextIdBullets, nextIdBursts];
}

function handleMine(
  s: LightCycle,
  nextShips: LightCycle[],
  idx: number,
  nextMines: Mine[],
  mineId: number,
) {
  if (s.mines <= 0) return;
  const back = shipRadius(s.level) + 3;
  nextMines.push({
    id: mineId,
    x: wrap(s.x - s.dx * back, ARENA.w),
    y: wrap(s.y - s.dy * back, ARENA.h),
    team: s.colorName,
    rgb: s.color,
    arm: MINE_ARM,
    life: MINE_LIFE,
    spin: 0,
    spinRate: 0.06,
  });
  nextShips[idx] = {
    ...s,
    mines: s.mines - 1,
  };
}

function findNearestMissileTarget(
  s: LightCycle,
  ships: readonly LightCycle[],
): LightCycle | null {
  let bestTgt: LightCycle | null = null;
  let bestD2 = 120 * 120; // 120 is MISSILE_RANGE
  for (const other of ships) {
    if (other.id === s.id || other.colorName === s.colorName) continue;
    const dx = other.x - s.x;
    const dy = other.y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestTgt = other;
    }
  }
  return bestTgt;
}

function handleMissile(
  s: LightCycle,
  nextShips: LightCycle[],
  idx: number,
  nextMissiles: Missile[],
  missileId: number,
  ships: readonly LightCycle[],
): number {
  const carries = carriesMissiles(s.archetype) || s.level >= 3;
  if (!carries || s.fuel <= 150) return missileId;
  const bestTgt = findNearestMissileTarget(s, ships);
  if (bestTgt) {
    const launch = s.level >= MAX_LEVEL ? spawnEmpMissile : spawnMissile;
    nextMissiles.push(launch(missileId, s, bestTgt));
    nextShips[idx] = {
      ...s,
      fuel: Math.max(0, s.fuel - 150),
    };
    return missileId + 1;
  }
  return missileId;
}

function handleBuffs(
  s: LightCycle,
  nextShips: LightCycle[],
  idx: number,
  actionId: number,
) {
  if (actionId === 4 && s.fuel > 200) {
    nextShips[idx] = {
      ...s,
      boostTime: s.boostTime + 120,
      fuel: Math.max(0, s.fuel - 200),
    };
  } else if (actionId === 5 && s.fuel > 300 && s.maxShield > 0) {
    nextShips[idx] = {
      ...s,
      shield: Math.min(s.maxShield, s.shield + 2),
      fuel: Math.max(0, s.fuel - 300),
    };
  } else if (actionId === 6 && s.fuel > 400) {
    nextShips[idx] = {
      ...s,
      invulnTime: s.invulnTime + 120,
      fuel: Math.max(0, s.fuel - 400),
    };
  } else if (actionId === 7 && s.fuel > 300) {
    nextShips[idx] = {
      ...s,
      forceFieldTime: s.forceFieldTime + 120,
      fuel: Math.max(0, s.fuel - 300),
    };
  }
}

/** Execute a manually-triggered quick action on the user-controlled ship. */
function handleUserAction(world: World, actionId: number): World {
  if (world.controlledShipId === null) return world;
  const ships = world.ships.items;
  const idx = ships.findIndex((s) => s.id === world.controlledShipId);
  if (idx === -1) return world;
  const s = ships[idx];
  if (s.fuel <= 0) return world;

  const nextShips = [...ships];
  const nextBullets = [...world.bullets.items];
  const nextMissiles = [...world.missiles.items];
  const nextMines = [...world.mines.items];
  const nextBursts = [...world.bursts.items];

  let nextIdBullets = world.bullets.nextId;
  let nextIdMissiles = world.missiles.nextId;
  let nextIdMines = world.mines.nextId;
  let nextIdBursts = world.bursts.nextId;

  if (actionId === 1) {
    [nextIdBullets, nextIdBursts] = handleFire(
      s,
      nextShips,
      idx,
      nextBullets,
      nextBursts,
      nextIdBullets,
      nextIdBursts,
    );
  } else if (actionId === 2) {
    handleMine(s, nextShips, idx, nextMines, nextIdMines++);
  } else if (actionId === 3) {
    nextIdMissiles = handleMissile(
      s,
      nextShips,
      idx,
      nextMissiles,
      nextIdMissiles,
      ships,
    );
  } else {
    handleBuffs(s, nextShips, idx, actionId);
  }

  return {
    ...world,
    ships: { ...world.ships, items: nextShips },
    bullets: { ...world.bullets, items: nextBullets, nextId: nextIdBullets },
    missiles: {
      ...world.missiles,
      items: nextMissiles,
      nextId: nextIdMissiles,
    },
    mines: { ...world.mines, items: nextMines, nextId: nextIdMines },
    bursts: { ...world.bursts, items: nextBursts, nextId: nextIdBursts },
  };
}

export function update(msg: Msg, world: World): World {
  // Rotate the field furniture ring to this world's age before any handler
  // reads a base/portal/pad position (deterministic — derived only from age).
  setOrbitPhase(world.age);
  switch (msg.kind) {
    case "tick":
      return tick(world, msg.steps, msg.now);
    case "launch":
      return launchShip(world, msg.dir);
    case "drop":
      return spawnShip(world, msg.x, msg.y);
    case "rally":
      return rallyTeam(world, msg.x, msg.y);
    case "reset":
      return initWorld(nextInt(world.seed, 2 ** 31)[0], world.config);
    case "replenish":
      return reinforceUnderdog(world);
    case "control":
      return {
        ...world,
        controlledShipId: msg.shipId,
        controlKeys: {
          up: false,
          down: false,
          left: false,
          right: false,
          space: false,
        },
      };
    case "controlKeys":
      return {
        ...world,
        controlKeys: {
          up: msg.up,
          down: msg.down,
          left: msg.left,
          right: msg.right,
          space: msg.space,
        },
      };
    case "action":
      return handleUserAction(world, msg.actionId);
    default:
      return assertNever(msg);
  }
}
