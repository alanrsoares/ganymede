// view: projects the immutable World into a flat sprite instance buffer for
// gpu.ts. Pure — it only reads world — animation is derived from `now`.

import {
  FLOATS_PER_INSTANCE,
  MAX_INSTANCES,
  MAX_ORBS,
  MAX_ROCKS,
  MAX_SHIELDS,
  ROCK_LAYOUT,
  SHIELD_LAYOUT,
} from "./gpu";
import {
  type AnimClip,
  asteroidLayer,
  BASE_LAYER,
  bankLayer,
  CLIP,
  clipLayer,
  explosionClip,
  PORTAL_LAYER,
  SHAPE,
  shipSprite,
} from "./sprites";
import {
  BURST_DETONATION,
  BURST_IMPACT,
  BURST_MUZZLE,
  type Burst,
  HEAL_PADS,
  type LightCycle,
  PORTALS,
  TEAM_BASES,
  type World,
} from "./world";
import { BASE_MAX_HP, SHIELD_FLASH } from "./world/factory";

type Rgba = readonly [number, number, number, number];

export interface OverlayFrame {
  w: number;
  h: number;
  gridW: number;
  gridH: number;
  now: number;
  world: World;
  showHp: boolean;
}

export interface Overlay {
  build(frame: OverlayFrame): {
    instances: Float32Array<ArrayBuffer>;
    count: number;
    rockInstances: Float32Array<ArrayBuffer>;
    rockCount: number;
    shieldInstances: Float32Array<ArrayBuffer>;
    shieldCount: number;
    orbInstances: Float32Array<ArrayBuffer>;
    orbCount: number;
  };
}

// Emits one flat sprite instance (screen center, half-extents, rotation,
// shape id, RGBA tint, layer). Shared by every `draw*` helper below.
type PushFn = (
  cx: number,
  cy: number,
  hx: number,
  hy: number,
  rot: number,
  shape: number,
  color: Rgba,
  layer?: number,
) => void;

const PICKUP_RGB: readonly (readonly [number, number, number])[] = [
  [0.3, 1.0, 0.5],
  [0.4, 0.78, 1.0],
  [1.0, 0.8, 0.35],
  [1.0, 0.5, 0.15],
  [0.4, 0.95, 1.0],
  [1.0, 0.85, 0.3],
  [0.72, 0.45, 1.0],
];

// Integrity bar under a base (green→red), hidden once razed.
function drawBaseIntegrityBar(
  push: PushFn,
  bx: number,
  by: number,
  cellPx: number,
  cellPy: number,
  hpFrac: number,
) {
  const barW = 16 * cellPx;
  const barY = by + 8 * cellPy;
  push(
    bx,
    barY,
    barW / 2,
    1.1 * cellPy,
    0,
    SHAPE.rect,
    [0.05, 0.05, 0.08, 0.7],
  );
  push(
    bx - barW / 2 + (barW * hpFrac) / 2,
    barY,
    (barW * hpFrac) / 2,
    1.1 * cellPy,
    0,
    SHAPE.rect,
    [1 - hpFrac, 0.2 + 0.7 * hpFrac, 0.2, 0.9],
  );
}

// A single team base: slow team-tinted portal ring encircling the dock
// platform, dimming as its integrity falls; a razed base (hp 0) shows only
// faint rubble. An HP bar sits beneath it.
function drawBase(
  push: PushFn,
  base: (typeof TEAM_BASES)[number],
  cellPx: number,
  cellPy: number,
  now: number,
  hpFrac: number,
) {
  const bx = (base.x + 0.5) * cellPx;
  const by = (base.y + 0.5) * cellPy;
  const dead = hpFrac <= 0;
  const bpulse = 0.6 + 0.4 * Math.sin(now / 520 + base.x);
  if (!dead) {
    push(
      bx,
      by,
      13 * cellPx,
      13 * cellPy,
      now / 2200,
      SHAPE.tintsprite,
      [base.rgb[0], base.rgb[1], base.rgb[2], (0.35 + 0.3 * bpulse) * hpFrac],
      PORTAL_LAYER,
    );
  }
  push(
    bx,
    by,
    9 * cellPx,
    9 * cellPy,
    0,
    SHAPE.tintsprite,
    [base.rgb[0], base.rgb[1], base.rgb[2], dead ? 0.18 : 0.4 + 0.45 * hpFrac],
    BASE_LAYER,
  );
  if (!dead) drawBaseIntegrityBar(push, bx, by, cellPx, cellPy, hpFrac);
}

// Team bases (furthest back).
function drawBases(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  for (const base of TEAM_BASES) {
    const hpFrac = Math.max(
      0,
      Math.min(1, (world.baseHp[base.name] ?? 0) / BASE_MAX_HP),
    );
    drawBase(push, base, cellPx, cellPy, now, hpFrac);
  }
}

// Portals (background). Two linked gates, slowly counter-rotating.
function drawPortals(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  const portalTints: readonly Rgba[] = [
    [0.55, 0.8, 1.0, 0.95],
    [1.0, 0.6, 0.95, 0.95],
  ];
  PORTALS.forEach((gate, i) => {
    const dir = i === 0 ? 1 : -1;
    push(
      (gate.x + 0.5) * cellPx,
      (gate.y + 0.5) * cellPy,
      gate.r * 1.3 * cellPx,
      gate.r * 1.3 * cellPy,
      (now / 1400) * dir,
      SHAPE.sprite,
      portalTints[i],
      PORTAL_LAYER,
    );
  });
}

// Healing pads (background). Green pulsing rings on the field.
function drawHealPads(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 380);
  for (const pad of HEAL_PADS) {
    push(
      (pad.x + 0.5) * cellPx,
      (pad.y + 0.5) * cellPy,
      pad.r * cellPx,
      pad.r * cellPy,
      now / 1000,
      SHAPE.ring,
      [0.25, 1.0, 0.5, 0.35 + 0.35 * pulse],
    );
  }
}

// Drifting asteroids are drawn by the 3D mesh pass (rockInstances), not the
// sprite pass. Pack a per-rock transform: screen center, pixel radius, a
// 3-axis tumble (rz reuses the sim spin; rx/ry animate off the clock), and a
// grey base that reddens as the rock loses integrity.
function drawRocks(
  rockInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
): number {
  let rockCount = 0;
  for (const rock of world.asteroids.items) {
    if (rockCount >= MAX_ROCKS) break;
    const frac = Math.max(0, Math.min(1, rock.hp / Math.max(1, rock.maxHp)));
    const o = rockCount * ROCK_LAYOUT.floats;
    const R = ROCK_LAYOUT.idx;
    rockInstances[o + R.cx] = (rock.x + 0.5) * cellPx;
    rockInstances[o + R.cy] = (rock.y + 0.5) * cellPy;
    rockInstances[o + R.radius] = rock.size * cellPx;
    rockInstances[o + R.rx] = now * 0.0006 + rock.id * 1.3;
    rockInstances[o + R.ry] = now * 0.0009 + rock.id * 2.1;
    rockInstances[o + R.rz] = rock.spin; // sim tumble
    rockInstances[o + R.r] = 0.52 + (1 - frac) * 0.28; // reddens when hurt
    rockInstances[o + R.g] = 0.53 - (1 - frac) * 0.08;
    rockInstances[o + R.b] = 0.6 - (1 - frac) * 0.18;
    rockCount++;
  }
  return rockCount;
}

// Proximity mines — team-tinted tumbling sprite; blinks once armed.
function drawMines(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  const mineLayer = clipLayer(CLIP.mine, 0, now);
  for (const m of world.mines.items) {
    const armed = m.arm <= 0;
    const blink = armed ? 0.55 + 0.45 * Math.sin(now / 90) : 0.4;
    push(
      (m.x + 0.5) * cellPx,
      (m.y + 0.5) * cellPy,
      3.6 * cellPx,
      3.6 * cellPy,
      m.spin,
      SHAPE.tintsprite,
      [m.rgb[0], m.rgb[1], m.rgb[2], blink],
      mineLayer,
    );
  }
}

// Shrapnel fragments — tiny spinning rock chips.
function drawShrapnel(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  world: World,
) {
  for (const f of world.projectiles.items) {
    push(
      (f.x + 0.5) * cellPx,
      (f.y + 0.5) * cellPy,
      2.4 * cellPx,
      2.4 * cellPy,
      f.spin,
      SHAPE.sprite,
      [0.85, 0.82, 0.8, 0.95],
      asteroidLayer(f.variant),
    );
  }
}

// Power-ups: a solid glossy 3D orb (its own lit pass) bobbing over a
// pulsing ground ring, tinted by kind — heal=green, shield=blue,
// speed=amber, overcharge=orange, EMP=cyan, rank-up=gold, cloak=violet.
function drawPickupOrbs(
  push: PushFn,
  orbInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
): number {
  let orbCount = 0;
  for (const pk of world.pickups.items) {
    const c = PICKUP_RGB[pk.kind] ?? PICKUP_RGB[0];
    const bob = Math.sin(now / 300 + pk.bob) * 0.8;
    const px = (pk.x + 0.5) * cellPx;
    const py = (pk.y + 0.5 + bob) * cellPy;
    const ring = 0.5 + 0.5 * Math.sin(now / 240 + pk.bob);
    push(
      px,
      (pk.y + 0.5) * cellPy,
      5.5 * cellPx,
      5.5 * cellPy,
      now / 700,
      SHAPE.ring,
      [c[0], c[1], c[2], 0.3 + 0.35 * ring],
    );
    if (orbCount < MAX_ORBS) {
      const o = orbCount * SHIELD_LAYOUT.floats;
      const S = SHIELD_LAYOUT.idx;
      orbInstances[o + S.cx] = px;
      orbInstances[o + S.cy] = py;
      orbInstances[o + S.radius] = 4.0 * cellPx;
      orbInstances[o + S.r] = c[0];
      orbInstances[o + S.g] = c[1];
      orbInstances[o + S.b] = c[2];
      orbCount++;
    }
  }
  return orbCount;
}

// Weapon bolts — one shader-drawn plasma streak per bullet, thin + long and
// rotated to heading. The bolt shape paints a hot core + team glow +
// tapered tips, so a single quad replaces old flat dots.
function drawBolts(push: PushFn, cellPx: number, cellPy: number, world: World) {
  const boltW = 1.15;
  const boltL = 4.6;
  for (const b of world.bullets.items) {
    push(
      (b.x + 0.5) * cellPx,
      (b.y + 0.5) * cellPy,
      boltW * cellPx,
      boltL * cellPy,
      b.angle,
      SHAPE.bolt,
      [b.rgb[0], b.rgb[1], b.rgb[2], 1.0],
    );
  }
}

// Seeking missiles — vapor trail receding behind a pulsing exhaust,
// team-tinted plasma body, white-hot warhead tip (which the bloom pass
// flares). All oriented to the missile's heading.
function drawMissiles(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
  exhaustL: number,
) {
  for (const mi of world.missiles.items) {
    const mx = (mi.x + 0.5) * cellPx;
    const my = (mi.y + 0.5) * cellPy;
    const hx = Math.sin(mi.angle);
    const hy = Math.cos(mi.angle);
    const px = -hy; // perpendicular, for trail wobble
    const py = hx;
    // Vapor trail: soft grey puffs fading back along the flight path.
    for (let k = 1; k <= 5; k++) {
      const d = k * 2.3;
      const fade = 1 - k / 6;
      const wob = Math.sin(now * 0.02 + k + mi.id) * k * 0.35;
      const psz = (1.6 + k * 0.55) * cellPx;
      push(
        mx - hx * d * cellPx + px * wob * cellPx,
        my - hy * d * cellPy + py * wob * cellPy,
        psz,
        psz,
        0,
        SHAPE.solid,
        [0.72, 0.74, 0.82, 0.22 * fade],
      );
    }
    // Pulsing exhaust flare at the tail.
    const flare = 2.2 + 0.6 * Math.sin(now * 0.05 + mi.id);
    push(
      mx - hx * 2.6 * cellPx,
      my - hy * 2.6 * cellPy,
      flare * cellPx,
      flare * cellPy,
      mi.angle,
      SHAPE.sprite,
      [1.0, 0.6, 0.2, 0.95],
      exhaustL,
    );
    // Plasma body.
    push(mx, my, 1.5 * cellPx, 3.6 * cellPy, mi.angle, SHAPE.bolt, [
      mi.rgb[0],
      mi.rgb[1],
      mi.rgb[2],
      1.0,
    ]);
    // White-hot tip.
    push(
      mx + hx * 1.6 * cellPx,
      my + hy * 1.6 * cellPy,
      1.1 * cellPx,
      1.1 * cellPy,
      0,
      SHAPE.solid,
      [1.0, 1.0, 1.0, 1.0],
    );
  }
}

const shipSize = (level: number): number =>
  level === 1
    ? 5.5
    : level === 2
      ? 8.0
      : level === 3
        ? 9.5
        : level === 4
          ? 11.0
          : 12.5;

interface ShipVisual {
  scx: number;
  scy: number;
  size: number;
  hullRot: number;
  hullLayer: number;
  hpFrac: number;
  distress: number;
  hx: number;
  hy: number;
}

// Resolves the per-ship screen transform + derived render state shared by
// the shadow, exhaust, smoke, shield, body and beam draws below.
function computeShipVisual(
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
  const size = shipSize(cycle.level);

  // Hull sprite + banking frame (shared by the shadow and the body). Banking
  // FX: the hull angle lags its heading while turning, so the residual is
  // the turn amount — pick the matching banked frame. Flipped (PI-rotated)
  // hulls have their left/right mirrored, so invert the sign.
  const sprite = shipSprite(cycle.archetype);
  let turn = Math.atan2(cycle.dx, cycle.dy) - cycle.angle;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn)); // wrap to [-π, π]
  if (sprite.angleOffset !== 0) turn = -turn;
  const hullLayer = bankLayer(sprite, turn);
  const hullRot = cycle.angle + sprite.angleOffset;

  // Distress ramp: 0 above 30% HP → 1 near death. Drives smoke + a reddening
  // hull so a dying ship reads at a glance. Render-only (no sim state).
  const hpFrac = Math.max(0, Math.min(1, cycle.hp / cycle.maxHp));
  const distress = hpFrac < 0.3 ? 1 - hpFrac / 0.3 : 0;

  return {
    scx,
    scy,
    size,
    hullRot,
    hullLayer,
    hpFrac,
    distress,
    hx: Math.sin(cycle.angle),
    hy: Math.cos(cycle.angle),
  };
}

// Drop shadow: the same hull silhouette in black, offset down-right and
// drawn first (under everything) so each ship reads as floating above the
// field. tintsprite × black rgb = a shape-accurate shadow, no new asset.
function drawShipShadow(
  push: PushFn,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
) {
  push(
    v.scx + 2.0 * cellPx,
    v.scy + 2.6 * cellPy,
    v.size * cellPx,
    v.size * cellPy,
    v.hullRot,
    SHAPE.tintsprite,
    [0, 0, 0, 0.32],
    v.hullLayer,
  );
}

// Exhaust flare behind the nose (drawn first, under the body). Offset by
// the *rendered* hull angle — which eases behind the heading during a turn
// — not the raw heading (dx/dy), so the tail stays pinned to the ship's
// rear instead of swinging off it mid-turn. Dead tank = dead engine: the
// exhaust cuts out (ship is coasting, defenseless).
function drawShipExhaust(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
  exhaustL: number,
) {
  if (cycle.fuel <= 0) return;
  const exOff = v.size * 0.9;
  push(
    v.scx - v.hx * exOff * cellPx,
    v.scy - v.hy * exOff * cellPy,
    v.size * 0.7 * cellPx,
    v.size * 0.7 * cellPy,
    cycle.angle,
    SHAPE.sprite,
    [1.0, 0.75, 0.35, 0.9],
    exhaustL,
  );
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
  const frac = cycle.maxShield
    ? Math.max(0, Math.min(1, cycle.shield / cycle.maxShield))
    : 0;
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

// Ship body: tint the hull slightly toward its team color (near-white
// multiply, so the original art shows through with a hint of team
// identity). Sprite/frame/rotation were resolved by computeShipVisual
// (shared with the shadow).
function drawShipBody(
  push: PushFn,
  cycle: LightCycle,
  v: ShipVisual,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  const k = 0.55; // stronger team color (was subtle)
  // Reddening dip: a distressed hull loses green/blue toward an angry red.
  const dr = v.distress * 0.4;
  // Rank brightness: higher tiers glow brighter (distinguishes tiers that
  // share a silhouette, and makes aces catch the bloom). ~1.0 → 1.24.
  const lvl = 1 + (cycle.level - 1) * 0.06;
  // Cloak: a phased (invulnerable) hull renders faint + shimmering.
  const cloak = cycle.invulnTime > 0 ? 0.35 + 0.15 * Math.sin(now / 60) : 1;
  const tint: Rgba = [
    (1 - k + k * cycle.color[0]) * lvl,
    (1 - k + k * cycle.color[1]) * (1 - dr) * lvl,
    (1 - k + k * cycle.color[2]) * (1 - dr) * lvl,
    0.95 * cloak,
  ];
  push(
    v.scx,
    v.scy,
    v.size * cellPx,
    v.size * cellPy,
    v.hullRot,
    SHAPE.tintsprite,
    tint,
    v.hullLayer,
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
  const sfrac = Math.max(0, Math.min(1, cycle.shield / cycle.maxShield));
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
  const ffrac = Math.max(0, Math.min(1, cycle.fuel / cycle.maxFuel));
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

// Team indicator: a filled dot in the team color, left of the HP bar.
function drawShipTeamDot(
  push: PushFn,
  cycle: LightCycle,
  scx: number,
  barW: number,
  barH: number,
  barY: number,
  cellPx: number,
) {
  const dotR = barH * 1.15;
  push(scx - barW / 2 - dotR - 2.2 * cellPx, barY, dotR, dotR, 0, SHAPE.solid, [
    ...cycle.color,
    1.0,
  ] as unknown as Rgba);
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

// Renders one ship (shadow, exhaust, smoke, shield, body, beam, HP bar) and
// returns the shield instance count after this ship's contribution.
function drawShip(
  push: PushFn,
  shieldInstances: Float32Array<ArrayBuffer>,
  shieldCount: number,
  cycle: LightCycle,
  cellPx: number,
  cellPy: number,
  now: number,
  showHp: boolean,
  exhaustL: number,
): number {
  const v = computeShipVisual(cycle, cellPx, cellPy, now);
  drawShipShadow(push, v, cellPx, cellPy);
  drawShipExhaust(push, cycle, v, cellPx, cellPy, exhaustL);
  drawShipDistressSmoke(push, cycle, v, cellPx, cellPy, now);
  const nextShieldCount = drawShipShield(
    shieldInstances,
    shieldCount,
    cycle,
    v,
    cellPx,
  );
  drawShipBody(push, cycle, v, cellPx, cellPy, now);
  drawShipBeam(push, cycle, v, cellPx, cellPy);
  if (showHp) drawShipHpBar(push, cycle, v, cellPx, cellPy);
  return nextShieldCount;
}

function drawShips(
  push: PushFn,
  shieldInstances: Float32Array<ArrayBuffer>,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
  showHp: boolean,
  exhaustL: number,
): number {
  let shieldCount = 0;
  for (const cycle of world.ships.items) {
    shieldCount = drawShip(
      push,
      shieldInstances,
      shieldCount,
      cycle,
      cellPx,
      cellPy,
      now,
      showHp,
      exhaustL,
    );
  }
  return shieldCount;
}

interface BurstStyle {
  clip: AnimClip;
  bsize: number;
  shape: number;
  tint: Rgba;
}

// Explosions + detonations use the FX sprite (soft radial edge fade so the
// glow never hard-cuts into a square); muzzle/impact use tintsprite so
// SHAPE.tintsprite can multiply the vulcan flare by the shooter's team
// color. Explosions + mine detonations use fixed fire/proton tints.
function burstStyle(burst: Burst): BurstStyle {
  if (burst.kind === BURST_DETONATION) {
    return {
      clip: CLIP.detonation,
      bsize: 9,
      shape: SHAPE.fxsprite,
      tint: [0.7, 0.9, 1.0, 1.0],
    };
  }
  if (burst.kind === BURST_MUZZLE || burst.kind === BURST_IMPACT) {
    const c = burst.rgb ?? [1, 1, 1];
    return {
      clip: CLIP.vulcan,
      bsize: burst.kind === BURST_MUZZLE ? 5.5 : 4.5,
      shape: SHAPE.tintsprite,
      tint: [c[0], c[1], c[2], 1.0],
    };
  }
  return {
    clip: explosionClip(burst.variant),
    bsize: 14,
    shape: SHAPE.fxsprite,
    tint: [1.0, 0.85, 0.6, 1.0],
  };
}

// Animated blast FX at their sites.
function drawBursts(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  for (const burst of world.bursts.items) {
    const style = burstStyle(burst);
    const layer = clipLayer(style.clip, burst.start, now);
    if (layer < 0) continue;
    push(
      (burst.x + 0.5) * cellPx,
      (burst.y + 0.5) * cellPy,
      style.bsize * cellPx,
      style.bsize * cellPy,
      burst.rot ?? 0, // muzzle flash points along the shot
      style.shape,
      style.tint,
      layer,
    );
  }
}

// Owns the flat sprite instance buffer + write cursor. `reset` rewinds the
// cursor at the start of a frame; `push` appends one instance (dropping any
// overflow past MAX_INSTANCES, warning once).
function createPusher(instances: Float32Array<ArrayBuffer>) {
  let count = 0;
  let warnedOverflow = false;
  const push: PushFn = (cx, cy, hx, hy, rot, shape, color, layer = 0) => {
    if (count >= MAX_INSTANCES) {
      if (!warnedOverflow) {
        warnedOverflow = true;
        console.warn(
          `overlay: hit MAX_INSTANCES (${MAX_INSTANCES}); sprites dropped this frame — raise the cap.`,
        );
      }
      return;
    }
    instances.set(
      [cx, cy, hx, hy, rot, shape, layer, 0, ...color],
      count * FLOATS_PER_INSTANCE,
    );
    count++;
  };
  return {
    push,
    reset: () => {
      count = 0;
    },
    getCount: () => count,
  };
}

export const createOverlay = (): Overlay => {
  const instances = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  const rockInstances = new Float32Array(MAX_ROCKS * ROCK_LAYOUT.floats);
  const shieldInstances = new Float32Array(MAX_SHIELDS * SHIELD_LAYOUT.floats);
  const orbInstances = new Float32Array(MAX_ORBS * SHIELD_LAYOUT.floats);
  const { push, reset, getCount } = createPusher(instances);

  return {
    build: ({ w, h, gridW, gridH, now, world, showHp }) => {
      reset();
      const cellPx = w / gridW;
      const cellPy = h / gridH;

      drawBases(push, cellPx, cellPy, now, world);
      drawPortals(push, cellPx, cellPy, now);
      drawHealPads(push, cellPx, cellPy, now);
      const rockCount = drawRocks(rockInstances, cellPx, cellPy, now, world);
      drawMines(push, cellPx, cellPy, now, world);
      drawShrapnel(push, cellPx, cellPy, world);
      const orbCount = drawPickupOrbs(
        push,
        orbInstances,
        cellPx,
        cellPy,
        now,
        world,
      );
      drawBolts(push, cellPx, cellPy, world);

      // Free-running exhaust clip frame shared by every ship + missile.
      const exhaustL = clipLayer(CLIP.exhaust, 0, now);
      drawMissiles(push, cellPx, cellPy, now, world, exhaustL);
      const shieldCount = drawShips(
        push,
        shieldInstances,
        cellPx,
        cellPy,
        now,
        world,
        showHp,
        exhaustL,
      );
      drawBursts(push, cellPx, cellPy, now, world);

      return {
        instances,
        count: getCount(),
        rockInstances,
        rockCount,
        shieldInstances,
        shieldCount,
        orbInstances,
        orbCount,
      };
    },
  };
};
