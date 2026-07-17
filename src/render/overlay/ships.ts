// view: ship rendering — shadow, exhaust, smoke, shield, hull, status FX,
// beam and HP bar. Pure — reads world, animation is derived from `now`.
// Hull bodies are 3D part-assemblies (ship-parts.ts) drawn by gpu.ts's
// instanced ship passes; everything else stays on the sprite/solid layer.

import { clamp01 } from "~/engine/physics";
import {
  MAX_MESH_SHIPS,
  MAX_PLUMES,
  MAX_SHIELDS,
  PLUME_LAYOUT,
  SHIELD_LAYOUT,
  SHIP_LAYOUT,
  type ShipBuckets,
} from "~/render/gpu";
import { SHAPE, shipSprite } from "~/render/sprites";
import { ENGINES, SHIP_CLASSES, type ShipClass } from "~/ship-parts";
import type { LightCycle, World } from "~/world";
import {
  hasRaidedAllEnemyBases,
  MUSTER_DRONE_SIZE_MULT,
  SHIELD_FLASH,
} from "~/world/factory";
import type { PushFn, Rgba } from "./push";

const SHIP_LEVEL_SIZES = [4.5, 5.9, 7.0, 8.1, 9.2];

export const shipSize = (level: number): number => SHIP_LEVEL_SIZES[level - 1];

// Fixed camera tilt leaning every hull toward the viewer so its 3D form reads
// under the top-down camera — same default the drydock inspector uses.
const HULL_TILT = (28 * Math.PI) / 180;
// Banking gain/cap: the hull's heading lags its velocity while turning; the
// residual drives a continuous roll about the thrust axis.
const ROLL_GAIN = 1.4;
const ROLL_MAX = 0.6;

/** Hull mesh for a ship: archetype = class, unknown archetypes fly the scout. */
const hullClass = (archetype: string): ShipClass =>
  (SHIP_CLASSES as readonly string[]).includes(archetype)
    ? (archetype as ShipClass)
    : "scout";

export interface ShipVisual {
  scx: number;
  scy: number;
  size: number;
  /** Mesh-pass heading. NEGATED game angle: ship.wgsl's Rz sends the nose to
   * (-sin h, cos h) in screen space while the sim flies (sin a, cos a), so
   * h = a renders every ship x-mirrored (only visible off the vertical axis). */
  heading: number;
  roll: number;
  hpFrac: number;
  distress: number;
  hx: number;
  hy: number;
}

// Resolves the per-ship screen transform + derived render state shared by
// the shadow, exhaust, smoke, shield, hull and beam draws below.
export function computeShipVisual(
  cycle: LightCycle,
  cellPx: number,
  cellPy: number,
  now: number,
): ShipVisual {
  const scx = (cycle.x + 0.5) * cellPx;
  // Out of fuel: the hull bobs gently like a drifting power-up orb.
  const drifting = cycle.fuel <= 0;
  const scy =
    (cycle.y + 0.5) * cellPy +
    (drifting ? Math.sin(now / 420 + cycle.id * 1.7) * 1.4 * cellPy : 0);
  // Muster drone ships render pint-sized: every size-keyed layer (shadow,
  // exhaust, shield, hull) scales together so the escort reads as a wingman,
  // not a fifth hero. Sim hitbox (shipRadius) is unchanged.
  const size =
    shipSize(cycle.level) * (cycle.droneShip ? MUSTER_DRONE_SIZE_MULT : 1);

  // Banking: the hull angle lags its heading while turning, so the residual
  // is the turn amount — rolled continuously about the thrust axis.
  let turn = Math.atan2(cycle.dx, cycle.dy) - cycle.angle;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn)); // wrap to [-π, π]
  // Negated with heading (see below): the x-mirror flips handedness, so the
  // roll sign flips with it to keep the hull banking into the turn.
  const roll = Math.max(-ROLL_MAX, Math.min(ROLL_MAX, -turn * ROLL_GAIN));

  // Distress ramp: 0 above 30% HP → 1 near death. Drives smoke + a reddening
  // hull so a dying ship reads at a glance. Render-only (no sim state).
  const hpFrac = clamp01(cycle.hp / cycle.maxHp);
  const distress = hpFrac < 0.3 ? 1 - hpFrac / 0.3 : 0;

  return {
    scx,
    scy,
    size,
    heading: -cycle.angle,
    roll,
    hpFrac,
    distress,
    hx: Math.sin(cycle.angle),
    hy: Math.cos(cycle.angle),
  };
}

// Drop shadow: a soft dark disc offset down-right, drawn first (under
// everything) so each ship reads as floating above the field.
function drawShipShadow(
  push: PushFn,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
) {
  push(
    v.scx + 2.0 * cellPx,
    v.scy + 2.6 * cellPy,
    v.size * 0.95 * cellPx,
    v.size * 0.95 * cellPy,
    0,
    SHAPE.solid,
    [0, 0, 0, 0.3],
  );
}

// Engine plumes: one additive 3D cone per ENGINES nozzle anchor, carried
// through the same heading/tilt/roll transform as the hull (plume.wgsl), so
// every tail sits exactly on its nozzle at any bank angle. Throttle scales
// length/brightness with real thrust; a dead tank cuts the engines.
function packShipPlumes(
  ships: ShipBuckets,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
) {
  if (cycle.fuel <= 0) return;
  const speed = Math.hypot(cycle.vx, cycle.vy);
  const drive = Math.max(0.35, Math.min(1, speed / 3));
  const throttle = cycle.boostTime > 0 ? 1 : drive * 0.85;
  const P = PLUME_LAYOUT.idx;
  const d = ships.plumes;
  for (const eng of ENGINES[hullClass(cycle.archetype)]) {
    if (ships.plumeCount >= MAX_PLUMES) return;
    const o = ships.plumeCount * PLUME_LAYOUT.floats;
    d[o + P.cx] = v.scx;
    d[o + P.cy] = v.scy;
    d[o + P.radius] = v.size * cellPx;
    d[o + P.roll] = v.roll;
    d[o + P.heading] = v.heading;
    d[o + P.tilt] = HULL_TILT;
    d[o + P.throttle] = throttle;
    d[o + P.phase] = cycle.id * 1.7 + ships.plumeCount;
    d[o + P.nx] = eng.pos[0];
    d[o + P.ny] = eng.pos[1];
    d[o + P.nz] = eng.pos[2];
    d[o + P.w] = eng.w;
    d[o + P.r] = cycle.color[0];
    d[o + P.g] = cycle.color[1];
    d[o + P.b] = cycle.color[2];
    d[o + P.alpha] = cycle.invulnTime > 0 ? 0.4 : 1;
    ships.plumeCount++;
  }
}

// Afterburner extra: Mach-diamond shock puffs marching down the thrust axis,
// shrinking + fading toward the tip. Boost only.
function drawShipBoostDiamonds(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  if (cycle.boostTime <= 0 || cycle.fuel <= 0) return;
  const flick =
    1 +
    0.18 * Math.sin(now * 0.05 + cycle.id * 2.3) +
    0.08 * Math.sin(now * 0.11 + cycle.id);
  const DIAMONDS = 4;
  for (let k = 1; k <= DIAMONDS; k++) {
    const t = k / DIAMONDS;
    const back = v.size * (0.9 + t * 3.2);
    const sz = v.size * 0.3 * (1 - t * 0.7) * flick;
    push(
      v.scx - v.hx * back * cellPx,
      v.scy - v.hy * back * cellPy,
      sz * cellPx,
      sz * cellPy,
      0,
      SHAPE.solid,
      [0.6, 0.8, 1.0, 0.55 * (1 - t)],
    );
  }
}

// Comet tail: a bright coma just behind the engine that stretches into a long,
// thin, tapering streak. Many tightly-spaced soft discs overlap into one
// continuous glow — hot-white at the head, bleeding to the team color and
// fading to nothing at the tip. Length + brightness scale with speed and stretch
// under boost; a dead tank shows none. Deterministic — no sim state.
function drawShipTrail(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  if (cycle.fuel <= 0) return;
  const speed = Math.hypot(cycle.vx, cycle.vy);
  const drive = Math.max(0.3, Math.min(1, speed / 3));
  const boost = cycle.boostTime > 0 ? 1.7 : 1;
  const hot: readonly [number, number, number] = [1.0, 0.95, 0.82];
  const px = -v.hy; // perpendicular to heading
  const py = v.hx;
  const len = v.size * (2.2 + 4.5 * drive) * boost; // total tail reach
  const PUFFS = 12;
  for (let k = 1; k <= PUFFS; k++) {
    const t = k / PUFFS; // 0 at head → 1 at tip
    const back = 0.5 * v.size + t * len; // tight near the coma, spreading back
    // Slight wispy sway that grows toward the tip so the tail curls, not rigid.
    const wob = Math.sin(now * 0.02 + cycle.id * 1.7) * t * t * 0.5 * v.size;
    const sz = v.size * (0.62 * (1 - t) ** 1.3 + 0.06); // fat coma → thin tip
    const alpha = (1 - t) ** 1.8 * 0.6 * drive * boost;
    const mix = t ** 0.6; // hot core bleeds to team colour quickly
    push(
      v.scx - v.hx * back * cellPx + px * wob * cellPx,
      v.scy - v.hy * back * cellPy + py * wob * cellPy,
      sz * cellPx,
      sz * cellPy,
      0,
      SHAPE.solid,
      [
        hot[0] + (cycle.color[0] - hot[0]) * mix,
        hot[1] + (cycle.color[1] - hot[1]) * mix,
        hot[2] + (cycle.color[2] - hot[2]) * mix,
        alpha,
      ],
    );
  }
}

// Distress smoke: a hurt ship trails a few dark puffs from its tail that
// grow + fade. Deterministic from `now` + ship id, so it costs no sim.
function drawShipDistressSmoke(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  if (v.distress <= 0) return;
  for (let k = 0; k < 3; k++) {
    const phase = now * 0.004 + cycle.id * 1.7 + k * 0.37;
    const t = phase - Math.floor(phase); // 0..1 puff lifetime
    const back = v.size * (0.7 + t * 2.6);
    const drift = (k - 1) * v.size * 0.25 * t;
    push(
      v.scx - v.hx * back * cellPx - v.hy * drift * cellPx,
      v.scy - v.hy * back * cellPy + v.hx * drift * cellPy,
      v.size * (0.35 + t * 0.7) * cellPx,
      v.size * (0.35 + t * 0.7) * cellPy,
      0,
      SHAPE.solid,
      [0.35 + 0.3 * (1 - t), 0.3, 0.3, (1 - t) * 0.4 * v.distress],
    );
  }
}

// Shield bubble: a translucent 3D sphere drawn by the shield mesh pass. A
// force field builds on the same orb — bigger, angrier (violet-white), and
// always shown while active even with no shield.
function drawShipShield(
  shieldInstances: Float32Array<ArrayBuffer>,
  shieldCount: number,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
): number {
  const forceField = cycle.forceFieldTime > 0;
  if (!(cycle.shield > 0 || forceField) || shieldCount >= MAX_SHIELDS) {
    return shieldCount;
  }
  const frac = cycle.maxShield ? clamp01(cycle.shield / cycle.maxShield) : 0;
  const o = shieldCount * SHIELD_LAYOUT.floats;
  const S = SHIELD_LAYOUT.idx;
  shieldInstances[o + S.cx] = v.scx;
  shieldInstances[o + S.cy] = v.scy;
  shieldInstances[o + S.radius] = v.size * (forceField ? 2.0 : 1.55) * cellPx;
  shieldInstances[o + S.strength] = forceField ? 1 : frac;
  shieldInstances[o + S.r] = forceField ? 0.85 : 0.4;
  shieldInstances[o + S.g] = forceField ? 0.5 : 0.78;
  shieldInstances[o + S.b] = 1.0;
  // Impact flare 0..1 (decays over SHIELD_FLASH gens) → shader brightens +
  // expands + ripples the bubble when a hit lands.
  shieldInstances[o + S.flash] = Math.min(1, cycle.hitFlash / SHIELD_FLASH);
  return shieldCount + 1;
}

// Ship hull: one instance into the class's 3D mesh pass. The shader applies
// the near-white team multiply itself, so we pass the raw team color, scaled
// by rank brightness and the distress reddening dip. Cloak fades the alpha.
function packShipHull(
  ships: ShipBuckets,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  now: number,
) {
  const cls = hullClass(cycle.archetype);
  const n = ships.counts[cls];
  if (n >= MAX_MESH_SHIPS) return;
  // Reddening dip: a distressed hull loses green/blue toward an angry red.
  const dr = v.distress * 0.4;
  // Rank brightness: higher tiers glow brighter (distinguishes tiers that
  // share a silhouette, and makes aces catch the bloom). ~1.0 → 1.24.
  const lvl = 1 + (cycle.level - 1) * 0.06;
  // Cloak: a phased (invulnerable) hull renders faint + shimmering.
  const cloak = cycle.invulnTime > 0 ? 0.35 + 0.15 * Math.sin(now / 60) : 1;
  const data = ships.instances[cls];
  const o = n * SHIP_LAYOUT.floats;
  const S = SHIP_LAYOUT.idx;
  data[o + S.cx] = v.scx;
  data[o + S.cy] = v.scy;
  data[o + S.radius] = v.size * cellPx;
  data[o + S.roll] = v.roll;
  data[o + S.heading] = v.heading;
  data[o + S.tilt] = HULL_TILT;
  data[o + S.r] = cycle.color[0] * lvl;
  data[o + S.g] = cycle.color[1] * (1 - dr) * lvl;
  data[o + S.b] = cycle.color[2] * (1 - dr) * lvl;
  data[o + S.alpha] = 0.95 * cloak;
  ships.counts[cls] = n + 1;
}

function drawShipStatusEffects(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  if (cycle.boostTime > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 90 + cycle.id);
    push(
      v.scx - v.hx * v.size * 0.9 * cellPx,
      v.scy - v.hy * v.size * 0.9 * cellPy,
      v.size * (0.9 + pulse * 0.35) * cellPx,
      v.size * (0.55 + pulse * 0.2) * cellPy,
      cycle.angle,
      SHAPE.ring,
      [1.0, 0.78, 0.25, 0.45],
    );
  }
  if (cycle.overchargeTime > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 70 + cycle.id);
    push(
      v.scx + v.hx * v.size * 0.9 * cellPx,
      v.scy + v.hy * v.size * 0.9 * cellPy,
      v.size * (0.55 + pulse * 0.2) * cellPx,
      v.size * (0.55 + pulse * 0.2) * cellPy,
      0,
      SHAPE.solid,
      [1.0, 0.42, 0.12, 0.25 + pulse * 0.2],
    );
  }
  if (cycle.invulnTime > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 110 + cycle.id);
    push(
      v.scx,
      v.scy,
      v.size * 1.35 * cellPx,
      v.size * 1.35 * cellPy,
      0,
      SHAPE.ring,
      [0.78, 0.48, 1.0, 0.32 + pulse * 0.22],
    );
  }
  if (cycle.fuel < cycle.maxFuel * 0.25) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 120 + cycle.id);
    push(
      v.scx,
      v.scy + v.size * 1.25 * cellPy,
      v.size * 0.22 * cellPx,
      v.size * 0.22 * cellPy,
      0,
      SHAPE.solid,
      [1.0, 0.22, 0.1, 0.45 + pulse * 0.35],
    );
  }
}

// Primed marker: a ship that has raided every enemy base (ready to cash the
// level-up at the center pad) wears a pulsing gold halo, so the "run for the
// center" state reads at a glance. Render-only (derived from baseHp + baseHits).
function drawShipPrimed(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  baseHp: Readonly<Record<string, number>>,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  if (cycle.level >= 5 || !hasRaidedAllEnemyBases(cycle, baseHp)) return;
  const pulse = 0.5 + 0.5 * Math.sin(now / 80 + cycle.id);
  push(
    v.scx,
    v.scy,
    v.size * (1.45 + pulse * 0.2) * cellPx,
    v.size * (1.45 + pulse * 0.2) * cellPy,
    now / 300,
    SHAPE.ring,
    [1.0, 0.85, 0.3, 0.4 + 0.35 * pulse],
  );
}

// Laser beam capsule.
function drawShipBeam(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
) {
  if (!cycle.beamActive) return;
  const tcx = (cycle.beamX + 0.5) * cellPx;
  const tcy = (cycle.beamY + 0.5) * cellPy;
  const dxPx = tcx - v.scx;
  const dyPx = tcy - v.scy;
  const len = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
  push(
    (v.scx + tcx) / 2,
    (v.scy + tcy) / 2,
    1.2 * cellPx,
    len / 2,
    cycle.angle,
    SHAPE.beam,
    [...cycle.color, 0.85] as unknown as Rgba,
  );
}

// Shield sub-bar under the HP bar (blue). Returns the stack Y for the next
// sub-bar (fuel).
function drawShipShieldSubBar(
  push: PushFn,
  cycle: LightCycle,
  scx: number,
  barW: number,
  stackY: number,
  subH: number,
  cellPy: number,
): number {
  if (cycle.maxShield <= 0) return stackY;
  const sfrac = clamp01(cycle.shield / cycle.maxShield);
  const y = stackY + subH / 2 + 0.5 * cellPy;
  push(scx, y, barW / 2, subH / 2, 0, SHAPE.rect, [0.04, 0.06, 0.1, 0.7]);
  const shFillW = barW * sfrac;
  push(
    scx - barW / 2 + shFillW / 2,
    y,
    shFillW / 2,
    subH / 2,
    0,
    SHAPE.rect,
    [0.35, 0.7, 1.0, 0.95],
  );
  return y + subH / 2;
}

// Fuel gauge sub-bar under the HP bar (amber → red as the tank drains).
function drawShipFuelSubBar(
  push: PushFn,
  cycle: LightCycle,
  scx: number,
  barW: number,
  stackY: number,
  subH: number,
  cellPy: number,
) {
  const ffrac = clamp01(cycle.fuel / cycle.maxFuel);
  const y = stackY + subH / 2 + 0.5 * cellPy;
  push(scx, y, barW / 2, subH / 2, 0, SHAPE.rect, [0.08, 0.06, 0.03, 0.7]);
  const fFillW = barW * ffrac;
  push(scx - barW / 2 + fFillW / 2, y, fFillW / 2, subH / 2, 0, SHAPE.rect, [
    1.0,
    0.35 + 0.4 * ffrac,
    0.1,
    0.95,
  ]);
}

// Team indicator: a filled ship silhouette in the team color, left of the HP bar.
function drawShipTeamDot(
  push: PushFn,
  cycle: LightCycle,
  scx: number,
  barW: number,
  barH: number,
  barY: number,
  cellPx: number,
) {
  const dotR = barH * 1.45;
  const sprite = shipSprite(cycle.archetype);
  const midLayer = sprite.layer0 + Math.floor(sprite.frameCount / 2);
  push(
    scx - barW / 2 - dotR - 2.2 * cellPx,
    barY,
    dotR,
    dotR,
    sprite.angleOffset + Math.PI,
    SHAPE.silhouette,
    [...cycle.color, 0.95] as unknown as Rgba,
    midLayer,
  );
}

// Rank insignia: one gold pip (diamond) per level, like military rank, in a
// row just above the HP bar.
function drawShipRankPips(
  push: PushFn,
  cycle: LightCycle,
  scx: number,
  barY: number,
  cellPy: number,
) {
  const pip = 0.9 * cellPy;
  const gap = 2.4 * cellPy;
  const rankY = barY - 2.6 * cellPy;
  const rankX0 = scx - ((cycle.level - 1) * gap) / 2;
  for (let p = 0; p < cycle.level; p++) {
    push(
      rankX0 + p * gap,
      rankY,
      pip,
      pip,
      Math.PI / 4, // rotate the square into a diamond pip
      SHAPE.rect,
      [1.0, 0.85, 0.25, 0.95],
    );
  }
}

// Togglable HP bar floating above the ship, with stacked shield/fuel
// sub-bars, a team dot and rank pips.
function drawShipHpBar(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
) {
  const frac = v.hpFrac;
  const barW = v.size * 2.2 * cellPx;
  const barH = 1.3 * cellPy;
  const barY = v.scy - (v.size + 3.5) * cellPy;
  // Backing track.
  push(
    v.scx,
    barY,
    barW / 2,
    barH / 2,
    0,
    SHAPE.rect,
    [0.05, 0.05, 0.08, 0.75],
  );
  // Filled portion, left-aligned, green -> red as HP drops.
  const fillW = barW * frac;
  push(v.scx - barW / 2 + fillW / 2, barY, fillW / 2, barH / 2, 0, SHAPE.rect, [
    1 - frac,
    0.2 + 0.75 * frac,
    0.15,
    0.95,
  ]);
  // Stacked sub-bars under the HP bar: shield (blue) then fuel (amber).
  const subH = 1.0 * cellPy;
  const stackY = drawShipShieldSubBar(
    push,
    cycle,
    v.scx,
    barW,
    barY + barH / 2,
    subH,
    cellPy,
  );
  drawShipFuelSubBar(push, cycle, v.scx, barW, stackY, subH, cellPy);
  drawShipTeamDot(push, cycle, v.scx, barW, barH, barY, cellPx);
  drawShipRankPips(push, cycle, v.scx, barY, cellPy);
}

// Controlled ship indicator: a pulsing cyan selection ring around the ship.
function drawShipControlledRing(
  push: PushFn,
  _cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
  now: number,
  isControlled: boolean,
) {
  if (!isControlled) return;
  const pulse = 0.5 + 0.5 * Math.sin(now / 150);
  push(
    v.scx,
    v.scy,
    v.size * (1.6 + pulse * 0.25) * cellPx,
    v.size * (1.6 + pulse * 0.25) * cellPy,
    now / 200,
    SHAPE.ring,
    [0.2, 0.85, 1.0, 0.4 + 0.4 * pulse],
  );
}

// Renders one ship (shadow, exhaust, smoke, shield, hull, beam, HP bar) and
// returns the shield instance count after this ship's contribution.
function drawShip(
  push: PushFn,
  shieldInstances: Float32Array<ArrayBuffer>,
  shieldCount: number,
  ships: ShipBuckets,
  cycle: LightCycle,
  baseHp: Readonly<Record<string, number>>,
  cellPx: number,
  cellPy: number,
  now: number,
  showHp: boolean,
  isControlled: boolean,
): number {
  const v = computeShipVisual(cycle, cellPx, cellPy, now);
  drawShipShadow(push, v, cellPx, cellPy);
  drawShipTrail(push, cycle, v, cellPx, cellPy, now);
  packShipPlumes(ships, cycle, v, cellPx);
  drawShipBoostDiamonds(push, cycle, v, cellPx, cellPy, now);
  drawShipDistressSmoke(push, cycle, v, cellPx, cellPy, now);
  const nextShieldCount = drawShipShield(
    shieldInstances,
    shieldCount,
    cycle,
    v,
    cellPx,
  );
  drawShipControlledRing(push, cycle, v, cellPx, cellPy, now, isControlled);
  drawShipPrimed(push, cycle, v, baseHp, cellPx, cellPy, now);
  packShipHull(ships, cycle, v, cellPx, now);
  drawShipStatusEffects(push, cycle, v, cellPx, cellPy, now);
  drawShipBeam(push, cycle, v, cellPx, cellPy);
  if (showHp) drawShipHpBar(push, cycle, v, cellPx, cellPy);
  return nextShieldCount;
}

// Every ship flies its class hull (team tint + controlled ring carry the
// hero-vs-foe read that sprite-era role remapping used to fake).
export function drawShips(
  push: PushFn,
  shieldInstances: Float32Array<ArrayBuffer>,
  ships: ShipBuckets,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
  showHp: boolean,
): number {
  let shieldCount = 0;
  for (const cls of SHIP_CLASSES) ships.counts[cls] = 0;
  ships.plumeCount = 0;
  for (const cycle of world.ships.items) {
    const isControlled = cycle.id === world.controlledShipId;
    shieldCount = drawShip(
      push,
      shieldInstances,
      shieldCount,
      ships,
      cycle,
      world.baseHp,
      cellPx,
      cellPy,
      now,
      showHp,
      isControlled,
    );
  }
  return shieldCount;
}
