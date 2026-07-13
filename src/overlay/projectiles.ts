// view: weapon effects — bolts, missiles and blast bursts. Pure — reads
// world, animation is derived from `now`.

import {
  type AnimClip,
  CLIP,
  clipLayer,
  explosionClip,
  SHAPE,
} from "../sprites";
import {
  BURST_ARC,
  BURST_DETONATION,
  BURST_EMP,
  BURST_IMPACT,
  BURST_MUZZLE,
  BURST_SHIELD,
  type Burst,
  type World,
} from "../world";
import { EMP_RADIUS, EXPLOSION_DURATION } from "../world/tuning";
import type { PushFn, Rgba } from "./push";

// Weapon bolts — one shader-drawn plasma streak per bullet, thin + long and
// rotated to heading. The bolt shape paints a hot core + team glow +
// tapered tips, so a single quad replaces old flat dots.
export function drawBolts(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  world: World,
) {
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
export function drawMissiles(
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
export function burstStyle(burst: Burst): BurstStyle {
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

// AoE detonation: a fiery blast filling the damage radius — an expanding orange
// wave, a bright fireball, a white-hot core flash, and debris sparks flung
// outward, all fading as the burst ages `t` (0..1). Built from soft solid discs
// (SHAPE.ring is a bracketed HUD reticle, not a clean circle), fire palette.
function drawAoeBlast(
  push: PushFn,
  cx: number,
  cy: number,
  cellPx: number,
  cellPy: number,
  t: number,
) {
  const disc = (radCells: number, a: number, rgb: [number, number, number]) =>
    push(cx, cy, radCells * cellPx, radCells * cellPy, 0, SHAPE.solid, [
      rgb[0],
      rgb[1],
      rgb[2],
      Math.max(0, a),
    ]);
  const fade = 1 - t;
  const ease = 1 - (1 - t) * (1 - t); // fast-out expansion

  // Expanding blast wave: translucent orange disc reaching the damage radius.
  disc(EMP_RADIUS * ease, 0.4 * fade, [1.0, 0.5, 0.15]);
  // Fireball: brighter, grows faster, dies sooner.
  const fb = Math.min(1, t * 1.5);
  disc(
    EMP_RADIUS * 0.5 * (1 - (1 - fb) * (1 - fb)),
    0.8 * (1 - t * 1.6),
    [1.0, 0.72, 0.25],
  );
  // White-hot core flash, gone by ~35% of the life.
  disc(4 + 8 * t, 1 - t * 3, [1.0, 0.96, 0.85]);

  // Debris sparks flung radially outward, shrinking as they fade.
  const N = 7;
  for (let i = 0; i < N; i++) {
    const ang = (i * Math.PI * 2) / N + i;
    const d = EMP_RADIUS * 0.8 * ease;
    push(
      cx + Math.cos(ang) * d * cellPx,
      cy + Math.sin(ang) * d * cellPy,
      2.4 * fade * cellPx,
      2.4 * fade * cellPy,
      0,
      SHAPE.solid,
      [1.0, 0.6, 0.2, fade],
    );
  }
}

// Shield deflection when a ship rams a base: a bright ring shell snaps outward
// from the strike — a white leading edge trailed by the team tint — over a quick
// point flash. Reads as the base's shield soaking the hit, not an explosion.
function drawShieldDeflect(
  push: PushFn,
  cx: number,
  cy: number,
  cellPx: number,
  cellPy: number,
  t: number,
  rgb: readonly [number, number, number],
) {
  const fade = 1 - t;
  const ease = 1 - (1 - t) * (1 - t); // fast-out expansion
  const R = 15; // reach in cells, just past the base's force field
  const ring = (
    radCells: number,
    a: number,
    col: readonly [number, number, number],
  ) =>
    push(cx, cy, radCells * cellPx, radCells * cellPy, 0, SHAPE.ring, [
      col[0],
      col[1],
      col[2],
      Math.max(0, a),
    ]);
  ring(R * ease, 0.7 * fade, [1, 1, 1]);
  ring(R * 0.82 * ease, 0.55 * fade, rgb);
  // Bright point flash at the impact, gone within the first third of the life.
  push(cx, cy, (3 + 5 * t) * cellPx, (3 + 5 * t) * cellPy, 0, SHAPE.solid, [
    1,
    1,
    1,
    Math.max(0, 1 - t * 3),
  ]);
}

// Chain-lightning arc, drawn as a proper bolt: a fractal-jagged path from
// (x,y)→(x2,y2) that re-strikes a few times over its short life (crackle),
// stroked as a wide soft halo under a bright white-hot core, with a couple of
// forked side-branches and a flash at each struck node.
const ARC_LIFE = 220; // ms the lightning flickers before it clears
type Pt = readonly [number, number];

// Deterministic 0..1 hash of one scalar (cheap sin-hash).
const hash1 = (n: number) => {
  const v = Math.sin(n) * 43758.5453;
  return v - Math.floor(v);
};

// One bolt-shape segment between two points. Oriented with the game's (sin,cos)
// heading convention (rot = atan2(dx,dy)) so the streak lies ALONG the path —
// the length axis is the quad's local.y (see overlay.wgsl bolt branch).
const boltSeg = (
  push: PushFn,
  a: Pt,
  b: Pt,
  halfW: number,
  rgb: readonly [number, number, number],
  alpha: number,
) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  push(
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    halfW,
    len / 2,
    Math.atan2(dx, dy),
    SHAPE.bolt,
    [rgb[0], rgb[1], rgb[2], alpha],
  );
};

const strokePath = (
  push: PushFn,
  pts: Pt[],
  halfW: number,
  rgb: readonly [number, number, number],
  alpha: number,
) => {
  for (let i = 1; i < pts.length; i++)
    boltSeg(push, pts[i - 1], pts[i], halfW, rgb, alpha);
};

// Fractal-jagged polyline from A→B: each interior vertex is pushed off the
// straight line perpendicular by a tapered random amount (0 at the ends). `frame`
// buckets time so the whole path re-randomizes a few times per second.
const jaggedPath = (
  a: Pt,
  b: Pt,
  seed: number,
  frame: number,
  seg: number,
  amp: number,
): Pt[] => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const pts: Pt[] = [a];
  for (let i = 1; i < seg; i++) {
    const f = i / seg;
    const taper = 1 - Math.abs(f - 0.5) * 2; // 0 at ends → 1 mid-span
    const j =
      (hash1(i * 12.9 + seed * 0.7 + frame) - 0.5) * amp * (taper + 0.2);
    pts.push([a[0] + dx * f + nx * j, a[1] + dy * f + ny * j]);
  }
  pts.push(b);
  return pts;
};

// A couple of short forked branches spitting off interior vertices, angled away
// from the main run and fading fast — the tell-tale fractal look of lightning.
const arcBranches = (
  push: PushFn,
  pts: Pt[],
  seed: number,
  frame: number,
  rgb: readonly [number, number, number],
  fade: number,
  cellPx: number,
) => {
  const n = pts.length;
  for (let k = 0; k < 2; k++) {
    const i = 1 + Math.floor(hash1(seed + k * 7.3 + frame) * (n - 2));
    const o = pts[i];
    const p = pts[i - 1];
    let dx = o[0] - p[0];
    let dy = o[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const ang = k === 0 ? 0.85 : -0.85; // fork ~50° off the main heading
    const fx = dx * Math.cos(ang) - dy * Math.sin(ang);
    const fy = dx * Math.sin(ang) + dy * Math.cos(ang);
    const bl = (5 + hash1(seed + k + frame) * 7) * cellPx;
    boltSeg(
      push,
      o,
      [o[0] + fx * bl, o[1] + fy * bl],
      0.7 * cellPx,
      rgb,
      0.45 * fade,
    );
  }
};

// White-hot flash + colored spark halo at a struck node.
const arcImpact = (
  push: PushFn,
  x: number,
  y: number,
  cellPx: number,
  cellPy: number,
  rgb: readonly [number, number, number],
  fade: number,
) => {
  const r = (1.6 + 1.2 * fade) * cellPx;
  push(x, y, r * 1.9, r * 1.9 * (cellPy / cellPx), 0, SHAPE.solid, [
    rgb[0],
    rgb[1],
    rgb[2],
    0.5 * fade,
  ]);
  push(x, y, r, r * (cellPy / cellPx), 0, SHAPE.solid, [1, 1, 1, fade]);
};

function drawArc(
  push: PushFn,
  burst: Burst,
  cellPx: number,
  cellPy: number,
  now: number,
) {
  const age = now - burst.start;
  const t = age / ARC_LIFE;
  if (t < 0 || t > 1) return;
  // Crackle: brightness flickers and the path re-strikes ~30×/s over the life.
  const frame = Math.floor(age / 32);
  const flick = 0.6 + 0.4 * hash1(frame + burst.start);
  const fade = (1 - t) * flick;
  const rgb = burst.rgb ?? [0.6, 0.8, 1];
  const a: Pt = [(burst.x + 0.5) * cellPx, (burst.y + 0.5) * cellPy];
  const b: Pt = [
    ((burst.x2 ?? burst.x) + 0.5) * cellPx,
    ((burst.y2 ?? burst.y) + 0.5) * cellPy,
  ];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const amp = Math.min(len * 0.16, 11 * cellPx);
  const pts = jaggedPath(a, b, burst.start, frame, 9, amp);
  strokePath(push, pts, 2.4 * cellPx, rgb, 0.26 * fade); // soft halo
  strokePath(push, pts, 0.85 * cellPx, rgb, fade); // bright core (shader whitens spine)
  arcBranches(push, pts, burst.start, frame, rgb, fade, cellPx);
  arcImpact(push, a[0], a[1], cellPx, cellPy, rgb, fade * 0.85);
  arcImpact(push, b[0], b[1], cellPx, cellPy, rgb, fade);
}

// Time-based vector bursts (EMP fire blast, base shield deflection, arcs) —
// drawn procedurally over their life `t` rather than as a sprite clip. Returns
// true when it owns `burst`, so the caller skips the clip path.
function drawFieldBurst(
  push: PushFn,
  burst: Burst,
  cellPx: number,
  cellPy: number,
  now: number,
): boolean {
  if (burst.kind === BURST_ARC) {
    drawArc(push, burst, cellPx, cellPy, now);
    return true;
  }
  if (burst.kind !== BURST_EMP && burst.kind !== BURST_SHIELD) return false;
  const t = (now - burst.start) / EXPLOSION_DURATION;
  if (t >= 0 && t <= 1) {
    const cx = (burst.x + 0.5) * cellPx;
    const cy = (burst.y + 0.5) * cellPy;
    if (burst.kind === BURST_EMP) drawAoeBlast(push, cx, cy, cellPx, cellPy, t);
    else {
      drawShieldDeflect(
        push,
        cx,
        cy,
        cellPx,
        cellPy,
        t,
        burst.rgb ?? [0.6, 0.8, 1],
      );
    }
  }
  return true;
}

// Animated blast FX at their sites.
export function drawBursts(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  now: number,
  world: World,
) {
  for (const burst of world.bursts.items) {
    if (drawFieldBurst(push, burst, cellPx, cellPy, now)) continue;
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
