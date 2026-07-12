import { elastic, normalize, wrapDelta } from "~/engine/physics";
import {
  HIT_COOLDOWN,
  meleeDamage,
  SCORE_KILL,
  toroidalDist,
  wrap,
} from "../factory";
import {
  BURST_EXPLOSION,
  GRID_H,
  GRID_W,
  type LightCycle,
  type Mutable,
} from "../types";
import { hit, killShip, maybeRamShock, replace, type TickCtx } from "./context";

type Ship = Mutable<LightCycle>;

/** Elastic bounce + heading update + positional separation for a ship pair. */
const bounceShips = (a: Ship, b: Ship): void => {
  const nx = wrapDelta(a.x, b.x, GRID_W);
  const ny = wrapDelta(a.y, b.y, GRID_H);
  const [va, vb] = elastic(
    [a.vx, a.vy],
    [b.vx, b.vy],
    [nx, ny],
    a.level,
    b.level,
  );
  a.vx = va[0];
  a.vy = va[1];
  b.vx = vb[0];
  b.vy = vb[1];
  const da = normalize(va, [a.dx, a.dy]);
  const db = normalize(vb, [b.dx, b.dy]);
  a.dx = da[0];
  a.dy = da[1];
  b.dx = db[0];
  b.dy = db[1];
  const dist = Math.hypot(nx, ny) || 1;
  const push = (11 - dist) / 2;
  if (push <= 0) return;
  const ux = nx / dist;
  const uy = ny / dist;
  a.x = wrap(a.x - ux * push, GRID_W);
  a.y = wrap(a.y - uy * push, GRID_H);
  b.x = wrap(b.x + ux * push, GRID_W);
  b.y = wrap(b.y + uy * push, GRID_H);
};

// Move one resource toward an equal fill fraction between two ships, conserving
// total units (a transfer, not free regen): the fuller ship gives, the emptier
// receives, capped by the giver's supply and the receiver's headroom.
const balance = (
  aCur: number,
  aMax: number,
  bCur: number,
  bMax: number,
  rate: number,
): [number, number] => {
  if (aMax <= 0 || bMax <= 0) return [aCur, bCur];
  const gap = aCur / aMax - bCur / bMax;
  if (Math.abs(gap) < 0.01) return [aCur, bCur];
  const amt = Math.abs(gap) * Math.min(aMax, bMax) * rate;
  if (gap > 0) {
    const give = Math.min(amt, aCur, bMax - bCur);
    return [aCur - give, bCur + give];
  }
  const give = Math.min(amt, bCur, aMax - aCur);
  return [aCur + give, bCur - give];
};

// Semitouch: two allies drifting close top-and-tail each other, trickling hp,
// shield and fuel from whoever has more toward whoever has less — a squad that
// flies together stays evenly supplied instead of merging into one.
const exchangeResources = (a: Ship, b: Ship, steps: number): void => {
  const rate = Math.min(0.5, 0.05 * steps);
  [a.hp, b.hp] = balance(a.hp, a.maxHp, b.hp, b.maxHp, rate);
  [a.shield, b.shield] = balance(
    a.shield,
    a.maxShield,
    b.shield,
    b.maxShield,
    rate,
  );
  [a.fuel, b.fuel] = balance(a.fuel, a.maxFuel, b.fuel, b.maxFuel, rate);
};

/** Resolve who dies after a trade of blows; award kills and queue reinforcements. */
const resolveDeaths = (ctx: TickCtx, a: Ship, b: Ship): void => {
  const dieA = a.hp <= 0;
  const dieB = b.hp <= 0;
  if (!dieA && !dieB) return;
  ctx.burstAt.push({
    x: Math.floor((a.x + b.x) / 2),
    y: Math.floor((a.y + b.y) / 2),
    kind: BURST_EXPLOSION,
  });
  if (dieA) {
    ctx.removed.add(a.id);
    ctx.score[b.colorName] += SCORE_KILL;
    replace(ctx);
  }
  if (dieB) {
    ctx.removed.add(b.id);
    ctx.score[a.colorName] += SCORE_KILL;
    replace(ctx);
  }
};

// Two enemies collide → bounce, then (off i-frames) ram each other. Each side's
// hull damage is meleeDamage(attacker, defender): scaled by the attacker's class
// ram, the counter-web bonus, its rank, and the defender's melee resistance — so
// a rammer crushing its countered prey trades far better than a scout tapping a
// heavy.
const dogfight = (ctx: TickCtx, a: Ship, b: Ship): void => {
  bounceShips(a, b);
  if (a.hitCooldown > 0 || b.hitCooldown > 0) return;
  hit(ctx, a, meleeDamage(b, a), "melee", b.id);
  hit(ctx, b, meleeDamage(a, b), "melee", a.id);
  a.hitCooldown = HIT_COOLDOWN;
  b.hitCooldown = HIT_COOLDOWN;
  maybeRamShock(ctx, a); // L5 rammer capstone: hull slam → area shockwave
  maybeRamShock(ctx, b);
  resolveDeaths(ctx, a, b);
};

// Hard-contact radius² (ships overlapping) vs the wider semitouch band² where
// allies swap resources without touching.
const CONTACT_D2 = 121; // 11px
const SEMITOUCH_D2 = 484; // 22px

// One ally/enemy pair already known to be within the semitouch band (`d2`).
// Allies swap resources and bounce apart on overlap; enemies dogfight on contact.
const resolvePair = (ctx: TickCtx, a: Ship, b: Ship, d2: number): void => {
  if (a.colorName === b.colorName) {
    exchangeResources(a, b, ctx.steps);
    if (d2 < CONTACT_D2) bounceShips(a, b); // still separate on overlap
  } else if (d2 < CONTACT_D2) {
    dogfight(ctx, a, b);
  }
};

/** Resolve `a` against every later ship within the semitouch band. */
const collideShipFrom = (ctx: TickCtx, a: Ship, startJ: number): void => {
  const { moved, removed } = ctx;
  for (let j = startJ; j < moved.length; j++) {
    const b = moved[j];
    if (removed.has(a.id) || removed.has(b.id)) continue;
    const dx = toroidalDist(a.x, b.x, GRID_W);
    const dy = toroidalDist(a.y, b.y, GRID_H);
    const d2 = dx * dx + dy * dy;
    if (d2 < SEMITOUCH_D2) resolvePair(ctx, a, b, d2);
  }
};

/** Ship ↔ ship dogfights (enemies) and resource exchange (allies). */
export const resolveShipCollisions = (ctx: TickCtx) => {
  for (let i = 0; i < ctx.moved.length; i++) {
    const a = ctx.moved[i];
    if (!ctx.removed.has(a.id)) collideShipFrom(ctx, a, i + 1);
  }
};

/** Kill every ship whose team base has been destroyed. */
export const eliminateBaselessTeams = (ctx: TickCtx) => {
  for (const s of ctx.moved) {
    if (!ctx.removed.has(s.id) && ctx.baseHp[s.colorName] <= 0) {
      killShip(ctx, s);
    }
  }
};

export const survivingShips = (ctx: TickCtx): LightCycle[] =>
  ctx.moved.filter((s) => !ctx.removed.has(s.id));

export type MutableShip = Mutable<LightCycle>;
