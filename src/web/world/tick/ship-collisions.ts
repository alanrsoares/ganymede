import { elastic, normalize, wrapDelta } from "../../engine/physics";
import {
  HIT_COOLDOWN,
  maxHpFor,
  minesFor,
  SCORE_KILL,
  SCORE_MERGE,
  shieldForLevel,
  toroidalDist,
  wrap,
} from "../factory";
import {
  BURST_EXPLOSION,
  GRID_H,
  GRID_W,
  type LightCycle,
  MAX_LEVEL,
  type Mutable,
} from "../types";
import { hit, killShip, replace, type TickCtx } from "./context";

type Ship = Mutable<LightCycle>;

/** Two allies touch → `a` absorbs `b`, ranks up, and fires a celebratory beam. */
const mergeAllies = (ctx: TickCtx, a: Ship, b: Ship): void => {
  ctx.removed.add(b.id);
  ctx.score[a.colorName] += SCORE_MERGE;
  if (a.level < MAX_LEVEL) a.level += 1;
  a.maxHp = maxHpFor(a.archetype, a.level);
  a.hp = a.maxHp;
  a.maxShield = shieldForLevel(a.level);
  a.shield = a.maxShield;
  a.maxMines = minesFor(a.archetype, a.level);
  a.mines = a.maxMines;
  const range = a.level === 2 ? 80 : 130;
  a.beamActive = true;
  a.beamTime = 30;
  a.beamX = wrap(a.x + a.dx * range, GRID_W);
  a.beamY = wrap(a.y + a.dy * range, GRID_H);
  replace(ctx);
};

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

/** Two enemies collide → bounce, then (off i-frames) trade a hit each. */
const dogfight = (ctx: TickCtx, a: Ship, b: Ship): void => {
  bounceShips(a, b);
  if (a.hitCooldown > 0 || b.hitCooldown > 0) return;
  hit(ctx, a, 1);
  hit(ctx, b, 1);
  a.hitCooldown = HIT_COOLDOWN;
  b.hitCooldown = HIT_COOLDOWN;
  resolveDeaths(ctx, a, b);
};

/** Resolve `a` against every later ship: merge allies, dogfight enemies. */
const collideShipFrom = (ctx: TickCtx, a: Ship, startJ: number): void => {
  const { moved, removed } = ctx;
  for (let j = startJ; j < moved.length; j++) {
    const b = moved[j];
    if (removed.has(a.id) || removed.has(b.id)) continue;
    const dx = toroidalDist(a.x, b.x, GRID_W);
    const dy = toroidalDist(a.y, b.y, GRID_H);
    if (dx * dx + dy * dy >= 121) continue;
    if (a.colorName === b.colorName) mergeAllies(ctx, a, b);
    else dogfight(ctx, a, b);
  }
};

/** Ship ↔ ship dogfights and ally merges. */
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
