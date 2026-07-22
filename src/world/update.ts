import { assertNever } from "@onrails/pattern";
import { wrapDelta } from "~/engine/physics";
import { nextInt } from "~/engine/rng";
import { type AugmentId, augCount, augMul } from "~/world/augments";
import {
  hurtShip,
  rollShip,
  spawnBullet,
  spawnEmpMissile,
  spawnMissile,
} from "./factory";
import { initArcadeWorld, initWorld, spawnShip } from "./init";
import { cycleLock } from "./lock";
import { wrap } from "./math";
import { tick } from "./tick";
import {
  carriesMissiles,
  fireCooldownFor,
  MINE_ARM,
  MINE_LIFE,
  maxHpFor,
  NOVA_ARC,
  NOVA_ARC_STEP,
  NOVA_DAMAGE,
  NOVA_DAMAGE_STEP,
  NOVA_FUEL_COST,
  NOVA_RADIUS,
  NOVA_RADIUS_STEP,
  OVERCHARGE_MULT,
  SCORE_KILL,
  shieldForLevel,
  shipRadius,
  speedForLevel,
  weaponFor,
} from "./tuning";
import {
  ARENA,
  BURST_EXPLOSION,
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
// Mutable working copies of every pool a manual action can touch, plus their id
// cursors. Handlers mutate this in place; handleUserAction freezes it back.
type ActionPools = {
  ships: LightCycle[];
  bullets: Bullet[];
  missiles: Missile[];
  mines: Mine[];
  bursts: Burst[];
  idBullets: number;
  idMissiles: number;
  idMines: number;
  idBursts: number;
  scoreGain: number; // points banked this action (nova kills)
};

type NovaCone = { cosArc: number; radius: number; dmg: number };

// An enemy caught in the pilot's nova cone → a damage-applied copy, or null when
// it's an ally, out of reach, or outside the facing arc.
const novaStrike = (
  s: LightCycle,
  e: LightCycle,
  cone: NovaCone,
): LightCycle | null => {
  if (e.colorName === s.colorName) return null;
  const ex = wrapDelta(s.x, e.x, ARENA.w);
  const ey = wrapDelta(s.y, e.y, ARENA.h);
  const dist = Math.hypot(ex, ey);
  if (dist < 1 || dist > cone.radius) return null;
  if ((ex * s.dx + ey * s.dy) / dist < cone.cosArc) return null;
  const wounded = { ...e };
  hurtShip(wounded, cone.dmg);
  return wounded;
};

const novaBurst = (id: number, e: LightCycle): Burst => ({
  id,
  x: Math.floor(e.x),
  y: Math.floor(e.y),
  kind: BURST_EXPLOSION,
  rgb: e.color,
  rot: 0,
  start: performance.now(),
  variant: 0,
});

// Apply the nova cone across the ship list: survivors (with the pilot's fuel
// docked), plus the enemies it killed (for bursts + score).
const applyNova = (
  s: LightCycle,
  ships: readonly LightCycle[],
  cone: NovaCone,
): { survivors: LightCycle[]; dead: LightCycle[] } => {
  const survivors: LightCycle[] = [];
  const dead: LightCycle[] = [];
  for (const e of ships) {
    if (e.id === s.id) {
      survivors.push({ ...e, fuel: Math.max(0, e.fuel - NOVA_FUEL_COST) });
      continue;
    }
    const struck = novaStrike(s, e, cone);
    if (!struck || struck.hp > 0) survivors.push(struck ?? e);
    else dead.push(e);
  }
  return { survivors, dead };
};

// Nova (arcade): a fuel-gated forward-cone blast. Damages every enemy inside the
// pilot's facing arc within reach; each stack widens the arc and adds reach +
// damage, so fuel is the only rate limit. Kills are removed here and counted by
// the arcade wave machine's death-diff next tick (see advanceWave).
function handleNova(world: World, s: LightCycle, p: ActionPools): void {
  const stacks = world.arcade ? augCount(world.arcade.augments, "nova") : 0;
  if (stacks <= 0 || s.fuel < NOVA_FUEL_COST) return;
  const cone: NovaCone = {
    cosArc: Math.cos(
      Math.min(Math.PI, NOVA_ARC + (stacks - 1) * NOVA_ARC_STEP),
    ),
    radius: NOVA_RADIUS + (stacks - 1) * NOVA_RADIUS_STEP,
    dmg: NOVA_DAMAGE + (stacks - 1) * NOVA_DAMAGE_STEP,
  };
  const { survivors, dead } = applyNova(s, p.ships, cone);
  p.ships = survivors;
  for (const e of dead) p.bursts.push(novaBurst(p.idBursts++, e));
  p.scoreGain += dead.length * SCORE_KILL;
}

/** Route one manual action to its handler, mutating `p` in place. */
function dispatchAction(
  world: World,
  s: LightCycle,
  idx: number,
  actionId: number,
  p: ActionPools,
): void {
  switch (actionId) {
    case 1:
      [p.idBullets, p.idBursts] = handleFire(
        s,
        p.ships,
        idx,
        p.bullets,
        p.bursts,
        p.idBullets,
        p.idBursts,
      );
      break;
    case 2:
      handleMine(s, p.ships, idx, p.mines, p.idMines++);
      break;
    case 3:
      p.idMissiles = handleMissile(
        s,
        p.ships,
        idx,
        p.missiles,
        p.idMissiles,
        world.ships.items,
      );
      break;
    case 9:
      handleNova(world, s, p);
      break;
    default:
      handleBuffs(s, p.ships, idx, actionId);
  }
}

function handleUserAction(world: World, actionId: number): World {
  if (world.controlledShipId === null) return world;
  const ships = world.ships.items;
  const idx = ships.findIndex((s) => s.id === world.controlledShipId);
  if (idx === -1) return world;
  const s = ships[idx];
  if (s.fuel <= 0) return world;

  const p: ActionPools = {
    ships: [...ships],
    bullets: [...world.bullets.items],
    missiles: [...world.missiles.items],
    mines: [...world.mines.items],
    bursts: [...world.bursts.items],
    idBullets: world.bullets.nextId,
    idMissiles: world.missiles.nextId,
    idMines: world.mines.nextId,
    idBursts: world.bursts.nextId,
    scoreGain: 0,
  };
  dispatchAction(world, s, idx, actionId, p);

  return {
    ...world,
    ships: { ...world.ships, items: p.ships },
    bullets: { ...world.bullets, items: p.bullets, nextId: p.idBullets },
    missiles: { ...world.missiles, items: p.missiles, nextId: p.idMissiles },
    mines: { ...world.mines, items: p.mines, nextId: p.idMines },
    bursts: { ...world.bursts, items: p.bursts, nextId: p.idBursts },
    score:
      p.scoreGain > 0
        ? {
            ...world.score,
            [s.colorName]: (world.score[s.colorName] ?? 0) + p.scoreGain,
          }
        : world.score,
  };
}

// A pending wave-clear offer freezes the sim: ticks and manual actions are
// identity until the pilot picks. Enforced at the sim's interface so no caller
// can keep the fight running under the offer dialog. World-replacing msgs
// (pickAugment, reset, …) still pass.
const frozenByOffer = (msg: Msg, world: World): boolean =>
  world.arcade?.offer != null && (msg.kind === "tick" || msg.kind === "action");

export function update(msg: Msg, world: World): World {
  if (frozenByOffer(msg, world)) return world;
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
    case "reset": {
      const [seed] = nextInt(world.seed, 2 ** 31);
      return world.config.format === "arcade"
        ? initArcadeWorld(seed, world.config)
        : initWorld(seed, world.config);
    }
    case "replenish":
      return reinforceUnderdog(world);
    case "control":
      return {
        ...world,
        controlledShipId: msg.shipId,
        lockedTargetId: null, // re-acquired by the tick for the new pilot
        controlKeys: {
          up: false,
          down: false,
          left: false,
          right: false,
          space: false,
        },
      };
    case "cycleTarget":
      return { ...world, lockedTargetId: cycleLock(world, msg.dir) };
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
    case "arcadeSkipIntermission":
      return world.arcade && world.arcade.phase === "intermission"
        ? { ...world, arcade: { ...world.arcade, phase: "fight" } }
        : world;
    case "pickAugment":
      return pickAugment(world, msg.id);
    default:
      return assertNever(msg);
  }
}

// Bank a wave-clear augment pick into the run's stack and clear the offer (which
// un-freezes the sim and lets the next wave muster). The live pilot's caps are
// re-baked from the level tables × the new stack — always from the base table,
// never compounding on the stored value — and topped off, since the pick is a
// reward. Offense augments (damage/cooldown/speed/regen) apply at their per-use
// read sites, so only hp/shield need baking here.
function pickAugment(world: World, id: AugmentId): World {
  const a = world.arcade;
  if (!a?.offer?.includes(id)) return world;
  const augments = { ...a.augments, [id]: (a.augments[id] ?? 0) + 1 };
  const hpMul = augMul(augments, "hp");
  const shMul = augMul(augments, "shield");
  const items = world.ships.items.map((s) => {
    if (s.id !== world.controlledShipId) return s;
    const maxHp = Math.round(maxHpFor(s.archetype, s.level) * hpMul);
    const maxShield = Math.round(shieldForLevel(s.level) * shMul);
    return { ...s, maxHp, maxShield, hp: maxHp, shield: maxShield };
  });
  return {
    ...world,
    ships: { ...world.ships, items },
    arcade: { ...a, augments, offer: null },
  };
}
