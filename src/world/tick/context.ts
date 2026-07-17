import type { Seed } from "~/engine/rng";
import { nextInt } from "~/engine/rng";
import { hurtShip, rollShip } from "~/world/factory";
import { toroidalDist } from "~/world/math";
import {
  ARCADE_BASE_HP_FLOOR,
  ARCHETYPE_MODS,
  arcadeHandicap,
  armorFor,
  BASE_RAID_XP,
  isRammer,
  killXp,
  levelUpScale,
  maxHpFor,
  minesFor,
  PIERCE_COUNTER_MULT,
  RAM_SHOCK_DAMAGE,
  RAM_SHOCK_RADIUS,
  SCORE_KILL,
  SCORE_MERGE,
  shieldForLevel,
  xpForLevel,
} from "~/world/tuning";
import {
  ARENA,
  BURST_COUNTER,
  BURST_EMP,
  BURST_EXPLOSION,
  baseByName,
  type DamageType,
  type Drone,
  type LightCycle,
  MAX_LEVEL,
  type Mutable,
  type Rgb,
  TEAMS,
  type World,
} from "~/world/types";

export type BurstSpec = {
  x: number;
  y: number;
  kind: number;
  rgb?: Rgb;
  rot?: number;
  x2?: number; // arc far endpoint (BURST_ARC)
  y2?: number;
};

/** Mutable scratch state for one simulation tick; phases read/write this in order. */
export interface TickCtx {
  readonly steps: number;
  readonly now: number;
  readonly world: World;
  readonly suddenDeath: boolean;
  readonly levelScale: number; // XP-requirement multiplier (age ramp; 1 in arcade)

  moved: Mutable<LightCycle>[];
  seed: Seed;
  nextId: number;
  score: Record<string, number>;
  baseHp: Record<string, number>;
  spawned: LightCycle[];
  spawnedDrones: Omit<Drone, "id">[]; // escort drones queued by a drone pickup
  burstAt: BurstSpec[];
  removed: Set<number>;
}

export const createTickCtx = (
  world: World,
  steps: number,
  now: number,
): TickCtx => ({
  steps,
  now,
  world,
  suddenDeath: world.age >= world.config.reinforceGens,
  levelScale: levelUpScale(world.age, world.config.format),
  moved: [],
  seed: world.seed,
  nextId: world.ships.nextId,
  score: { ...world.score },
  baseHp: { ...world.baseHp },
  spawned: [],
  spawnedDrones: [],
  burstAt: [],
  removed: new Set<number>(),
});

export function replace(ctx: TickCtx) {
  if (ctx.suddenDeath) return;
  const alive = TEAMS.filter((t) => ctx.baseHp[t.name] > 0);
  if (alive.length === 0) return;
  const [pick, s0] = nextInt(ctx.seed, alive.length);
  ctx.seed = s0;
  const [ship, s2] = rollShip(ctx.seed, ctx.nextId, 0, 0, 1, alive[pick].name);
  const base = baseByName.get(ship.colorName);
  ctx.spawned.push(base ? { ...ship, x: base.x, y: base.y } : ship);
  ctx.seed = s2;
  ctx.nextId += 1;
}

export function killShip(ctx: TickCtx, s: Mutable<LightCycle>) {
  ctx.burstAt.push({
    x: Math.floor(s.x),
    y: Math.floor(s.y),
    kind: BURST_EXPLOSION,
  });
  ctx.removed.add(s.id);
  replace(ctx);
}

/**
 * Combat XP for damage dealt: the attacker banks a slice of the victim's worth
 * (`killXp` — a level-delta matrix) proportional to the effective damage it just
 * landed, over the victim's full HP+shield pool. A solo kill nets ~the full
 * matrix value, a shared kill splits by contribution, and chip damage banks even
 * when someone else lands the finish (partial-kill XP). Uncapped, so earned
 * combat ranks all the way to `MAX_LEVEL` (unlike the L3-capped rock trickle).
 */
function awardCombatXp(
  ctx: TickCtx,
  attackerId: number,
  victim: Mutable<LightCycle>,
  effectiveDmg: number,
): void {
  const k = ctx.moved.find(
    (m) => m.id === attackerId && !ctx.removed.has(m.id),
  );
  if (!k || k.colorName === victim.colorName) return;
  const pool = victim.maxHp + victim.maxShield;
  if (pool <= 0 || effectiveDmg <= 0) return;
  awardXp(
    ctx,
    attackerId,
    killXp(k.level, victim.level) * (effectiveDmg / pool),
  );
}

// Central damage choke point: cloak makes a ship immune, otherwise the incoming
// amount is reduced by the defender's armor for this damage type (melee vs
// pierce) before it spills through shield → hull. Every hit site routes here, so
// the pierce/melee armor split lives in exactly one place. When `attackerId` is
// given (a ship dealt it — bolt/missile/blast/ram/aura), the attacker banks
// combat XP for the damage it landed (see awardCombatXp).
// Arcade moving handicap on one exchange: the pilot takes less and hits harder
// by the live ratio (wave-scaled base + adaptive offset). Neutral off-arcade.
const withArcadeHandicap = (
  ctx: TickCtx,
  victim: Mutable<LightCycle>,
  attackerId: number | undefined,
  dealt: number,
): number => {
  const arc = ctx.world.arcade;
  if (!arc) return dealt;
  const h = arcadeHandicap(arc.wave, arc.adapt);
  if (victim.id === ctx.world.controlledShipId) return dealt / h;
  if (attackerId === ctx.world.controlledShipId) return dealt * h;
  return dealt;
};

export function hit(
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  amt: number,
  type: DamageType = "pierce",
  attackerId?: number,
) {
  if (s.invulnTime > 0) return;
  let dealt = withArcadeHandicap(ctx, s, attackerId, amt);
  // Counter-web for ranged hits (T1/T2): if the shooter is known and this is
  // pierce damage, bolts/missiles hit harder against the class it counters, and
  // armor-shredder classes (scout) skip a slice of the target's pierce armor.
  let armor = armorFor(s.archetype, type);
  if (type === "pierce" && attackerId !== undefined) {
    const shooter = ctx.moved.find(
      (m) => m.id === attackerId && !ctx.removed.has(m.id),
    );
    if (shooter) {
      const mods = ARCHETYPE_MODS[shooter.archetype];
      if (mods.counters === s.archetype) {
        dealt *= PIERCE_COUNTER_MULT;
        // Surface the counter-web: a bright spark tells the player this was a
        // super-effective (rock-paper-scissors) hit, which is otherwise invisible.
        ctx.burstAt.push({
          x: Math.floor(s.x),
          y: Math.floor(s.y),
          kind: BURST_COUNTER,
          rgb: shooter.color,
        });
      }
      armor *= 1 - mods.pierceShred;
    }
  }
  const effective = dealt * (1 - armor);
  const before = Math.max(0, s.hp + s.shield);
  hurtShip(s, effective);
  if (attackerId !== undefined) {
    awardCombatXp(ctx, attackerId, s, Math.min(effective, before));
  }
}

/**
 * Area blast at (bx, by): damage (and maybe kill) every enemy within `radius`,
 * crediting kills to `team` and combat XP to `ownerId`, then fire the EMP
 * shockwave ring at the impact point. Shared by AoE missiles and the L5 heavy
 * ram shockwave.
 */
export function detonateBlast(
  ctx: TickCtx,
  bx: number,
  by: number,
  team: string,
  damage: number,
  radius: number,
  ownerId?: number,
): void {
  ctx.burstAt.push({ x: Math.floor(bx), y: Math.floor(by), kind: BURST_EMP });
  for (const e of ctx.moved) {
    if (ctx.removed.has(e.id) || e.colorName === team) continue;
    const ex = toroidalDist(e.x, bx, ARENA.w);
    const ey = toroidalDist(e.y, by, ARENA.h);
    if (ex * ex + ey * ey >= radius * radius) continue;
    hit(ctx, e, damage, "pierce", ownerId);
    if (e.hp <= 0) {
      ctx.score[team] += SCORE_KILL;
      killShip(ctx, e);
    }
  }
}

/**
 * L5 rammer capstone: an ace rammer's hull slam (ship or base) sets off an area
 * shockwave around it. No-op for non-rammers or below MAX_LEVEL, so it rides the
 * same HIT_COOLDOWN i-frames as the ram that triggered it.
 */
export function maybeRamShock(ctx: TickCtx, s: Mutable<LightCycle>): void {
  if (!isRammer(s.archetype) || s.level < MAX_LEVEL) return;
  detonateBlast(
    ctx,
    s.x,
    s.y,
    s.colorName,
    RAM_SHOCK_DAMAGE,
    RAM_SHOCK_RADIUS,
    s.id,
  );
}

/**
 * Chip a base's integrity. In arcade the player's home base floors at
 * ARCADE_BASE_HP_FLOOR instead of 0 — it can be battered to the brink but never
 * razed, so repair (docking / wave-clear) always has something to restore and
 * the run never loses its spawn field permanently.
 */
export function damageBase(ctx: TickCtx, baseName: string, amount: number) {
  const floor =
    baseName === ctx.world.config.arcade?.playerTeam ? ARCADE_BASE_HP_FLOOR : 0;
  ctx.baseHp[baseName] = Math.max(floor, ctx.baseHp[baseName] - amount);
}

/**
 * Credit a base-raid hit to the shooter (looked up by id). This only tallies
 * progress — the actual promotion is cashed in when the ship reaches the center
 * pad (see `finishAtCenterPad` in interactions.ts), so raiding + a center
 * flyover together earn the level.
 */
export function creditBaseHit(ctx: TickCtx, ownerId: number, baseName: string) {
  // Base-raid leveling only makes sense as a spread-out objective in a crowd.
  // With one enemy base (duels) or two (3-way) it's a trivial free ladder, so
  // gate the whole raid-XP path to 4+ team matches.
  if (ctx.world.config.teams < 4) return;
  const s = ctx.moved.find((m) => m.id === ownerId && !ctx.removed.has(m.id));
  if (!s || s.level >= MAX_LEVEL) return;
  s.baseHits = { ...s.baseHits, [baseName]: (s.baseHits[baseName] ?? 0) + 1 };
  awardXp(ctx, ownerId, BASE_RAID_XP); // raiding is the steadiest leveling stream
}

/**
 * Rank a ship up: caps (`maxHp`/`maxShield`/`maxMines`) always grow. The
 * current-value refill is gated on `heal` — the raid-path finish and the
 * rank-up pickup top the hull off (reward reaching the contested center / a
 * lucky grab), but rock-XP promotes with `heal: false` so farming can't double
 * as a free sustain button.
 */
export function promote(
  ctx: TickCtx,
  s: Mutable<LightCycle>,
  { heal = true }: { heal?: boolean } = {},
) {
  if (s.level >= MAX_LEVEL) return;
  s.level += 1;
  s.maxHp = maxHpFor(s.archetype, s.level);
  s.maxShield = shieldForLevel(s.level);
  s.maxMines = minesFor(s.archetype, s.level);
  if (heal) {
    s.hp = s.maxHp;
    s.shield = s.maxShield;
    s.mines = s.maxMines;
  }
  ctx.score[s.colorName] += SCORE_MERGE;
  ctx.burstAt.push({
    x: Math.floor(s.x),
    y: Math.floor(s.y),
    kind: BURST_EXPLOSION,
  });
}

/**
 * Award combat XP to the ship `ownerId`, cashing in a promotion each time the
 * threshold is crossed and carrying the remainder. `cap` bounds how high this
 * XP source can rank a ship: kills promote all the way to `MAX_LEVEL`, while
 * rock-shatter XP passes `XP_LEVEL_CAP` (a catch-up trickle — the safe PvE farm
 * can't solo-carry to ace). XP never heals: the hull grows its cap but earning a
 * level mid-fight doesn't top it off (only the center-pad finish / pickup do).
 */
export const awardXp = (
  ctx: TickCtx,
  ownerId: number,
  amount: number,
  cap: number = MAX_LEVEL,
) => {
  const s = ctx.moved.find((m) => m.id === ownerId && !ctx.removed.has(m.id));
  if (!s || s.level >= cap) return;
  s.xp += amount;
  // Later in an autobattle match, each level costs more XP (ctx.levelScale ≥ 1).
  let need = xpForLevel(s.level) * ctx.levelScale;
  while (s.level < cap && s.xp >= need) {
    s.xp -= need;
    promote(ctx, s, { heal: false });
    need = xpForLevel(s.level) * ctx.levelScale;
  }
};
