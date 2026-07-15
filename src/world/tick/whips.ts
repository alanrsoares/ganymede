// Pilot special — the verlet WHIP. A chain of linked nodes anchored to the
// pilot's nose lashes out toward the nearest enemy: each free node is a verlet
// point mass (position + previous position), pulled along the aim axis by a
// tip-weighted "lash" acceleration and then snapped back to a fixed segment
// length by distance-constraint relaxation. A sin envelope over its short life
// makes it crack out to full reach mid-life and recoil by the end. Any enemy a
// node sweeps within reach of takes damage once. All pure float math —
// deterministic, no RNG, no `now`.

import { wrapDelta } from "~/engine/physics";
import { SCORE_KILL, toroidalDist, wrap } from "../factory";
import {
  WHIP_ARC,
  WHIP_DAMP,
  WHIP_HIT_RADIUS,
  WHIP_LIFE,
  WHIP_NODES,
  WHIP_SEEK,
  WHIP_SEG_LEN,
  WHIP_STIFF,
} from "../tuning";
import {
  ARENA,
  BURST_COUNTER,
  type LightCycle,
  type Mutable,
  type Whip,
  type WhipNode,
  type World,
} from "../types";
import { hit, killShip, type TickCtx } from "./context";

type MutWhip = Mutable<Whip>;
// Free-standing node scratch (verlet works in place before we re-freeze it).
type Node = { x: number; y: number; px: number; py: number };

/** Unit aim vector from ship toward `(tx,ty)` (toroidal); ship heading if none. */
const aimOf = (
  s: LightCycle,
  tx: number | null,
  ty: number | null,
): [number, number] => {
  if (tx === null || ty === null) return [s.dx, s.dy];
  const dx = wrapDelta(s.x, tx, ARENA.w);
  const dy = wrapDelta(s.y, ty, ARENA.h);
  const d = Math.hypot(dx, dy) || 1;
  return [dx / d, dy / d];
};

/**
 * Build a fresh whip anchored to `s`, pre-strung a little along the aim axis so
 * it reads as unfurling rather than popping from a point. Zero initial velocity
 * (px == x) — the lash acceleration does the cracking.
 */
export const spawnWhip = (
  id: number,
  s: LightCycle,
  target: LightCycle | null,
  damage: number,
): Whip => {
  const [ax, ay] = aimOf(s, target?.x ?? null, target?.y ?? null);
  const nodes: WhipNode[] = [];
  for (let i = 0; i < WHIP_NODES; i++) {
    const back = i * WHIP_SEG_LEN * 0.25;
    const x = wrap(s.x + ax * back, ARENA.w);
    const y = wrap(s.y + ay * back, ARENA.h);
    nodes.push({ x, y, px: x, py: y });
  }
  return {
    id,
    owner: s.id,
    team: s.colorName,
    rgb: s.color,
    nodes,
    life: WHIP_LIFE,
    maxLife: WHIP_LIFE,
    damage,
    restLen: WHIP_SEG_LEN,
    targetId: target?.id ?? 0,
    hits: [],
  };
};

/**
 * Advance one whip a single "gen". Each free node is softly pulled toward its
 * slot on a *spine* — a bowed curve running from the anchor out along the aim
 * axis to the current reach (`env` extends it to full, then retracts), crested
 * sideways by WHIP_ARC so the lash sweeps a crescent rather than poking straight.
 * Verlet momentum + damping make the outer links lag and overshoot that spine,
 * which is what gives the crack/whip feel. Distance constraints then hold the
 * segment lengths so the chain stays a chain.
 */
const integrate = (
  nodes: Node[],
  anchorX: number,
  anchorY: number,
  ax: number,
  ay: number,
  env: number,
  restLen: number,
  steps: number,
): void => {
  const n = nodes.length;
  const reach = (n - 1) * restLen * env; // spine length this gen
  const px = -ay; // unit perpendicular to the aim (lateral sweep axis)
  const py = ax;
  const seek = Math.min(1, WHIP_SEEK * steps);

  // Anchor rides the ship's nose; keep its previous position so the whip feels
  // the ship's motion as it's dragged along.
  nodes[0].px = nodes[0].x;
  nodes[0].py = nodes[0].y;
  nodes[0].x = anchorX;
  nodes[0].y = anchorY;

  for (let i = 1; i < n; i++) {
    const nd = nodes[i];
    const frac = i / (n - 1);
    // Ideal slot on the bowed spine: along the aim by `frac·reach`, bowed out
    // sideways by a half-sine (0 at root and tip, max mid-span).
    const bow = Math.sin(Math.PI * frac) * WHIP_ARC * env;
    const idx = anchorX + ax * reach * frac + px * bow;
    const idy = anchorY + ay * reach * frac + py * bow;
    const vx = (nd.x - nd.px) * WHIP_DAMP;
    const vy = (nd.y - nd.py) * WHIP_DAMP;
    nd.px = nd.x;
    nd.py = nd.y;
    nd.x += vx + (idx - nd.x) * seek;
    nd.y += vy + (idy - nd.y) * seek;
  }

  // Distance-constraint relaxation — snap segments back to rest length. A few
  // passes stiffen the chain without going fully rigid. node[0] stays pinned.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < n; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = ((d - restLen) / d) * WHIP_STIFF;
      const ox = dx * f;
      const oy = dy * f;
      if (i - 1 === 0) {
        b.x -= ox;
        b.y -= oy;
      } else {
        a.x += ox * 0.5;
        a.y += oy * 0.5;
        b.x -= ox * 0.5;
        b.y -= oy * 0.5;
      }
    }
  }
};

/**
 * Advance every whip `steps` gens: age it out, drop the dead (and any whose
 * pilot died), re-pin to the owner's new position and run the verlet pass.
 */
export const advanceWhips = (
  world: World,
  shipById: Map<number, Mutable<LightCycle>>,
  steps: number,
): MutWhip[] => {
  const out: MutWhip[] = [];
  for (const whip of world.whips.items) {
    const life = whip.life - steps;
    const owner = shipById.get(whip.owner);
    if (life <= 0 || !owner) continue; // expired or orphaned → gone

    // Extend→retract envelope, front-loaded (t^0.6) so it cracks out fast and
    // lingers/recoils: 0 at fire, 1 at ~⅓ life, back toward 0 as it retracts.
    const age = whip.maxLife - life;
    const env = Math.sin(Math.PI * (age / whip.maxLife) ** 0.6);
    const tgt = whip.targetId ? shipById.get(whip.targetId) : undefined;
    const [ax, ay] = aimOf(owner, tgt?.x ?? null, tgt?.y ?? null);

    const nodes: Node[] = whip.nodes.map((p) => ({
      x: p.x,
      y: p.y,
      px: p.px,
      py: p.py,
    }));
    integrate(nodes, owner.x, owner.y, ax, ay, env, whip.restLen, steps);

    out.push({ ...whip, life, nodes });
  }
  return out;
};

const R2 = WHIP_HIT_RADIUS * WHIP_HIT_RADIUS;

/** True if any of the whip's nodes lie within lash radius of ship `e`. */
const nodeTouches = (whip: MutWhip, e: LightCycle): boolean => {
  for (const nd of whip.nodes) {
    const dx = toroidalDist(nd.x, e.x, ARENA.w);
    const dy = toroidalDist(nd.y, e.y, ARENA.h);
    if (dx * dx + dy * dy < R2) return true;
  }
  return false;
};

/** Deal one lash to `e`: damage, spark, and credit the kill on death. */
const lashEnemy = (
  ctx: TickCtx,
  whip: MutWhip,
  e: Mutable<LightCycle>,
): void => {
  hit(ctx, e, whip.damage, "pierce", whip.owner);
  ctx.burstAt.push({
    x: Math.floor(e.x),
    y: Math.floor(e.y),
    kind: BURST_COUNTER,
    rgb: whip.rgb,
  });
  if (e.hp <= 0) {
    ctx.score[whip.team] += SCORE_KILL;
    killShip(ctx, e);
  }
};

/**
 * Lash resolution: any enemy a whip node sweeps within reach takes the whip's
 * damage once (tracked in `hits`). Runs after ship motion so nodes test against
 * live positions. Credits the pilot for the kill.
 */
export const resolveWhips = (ctx: TickCtx, whips: MutWhip[]): void => {
  for (const whip of whips) {
    const hits = new Set(whip.hits);
    let struck = false;
    for (const e of ctx.moved) {
      const skip =
        ctx.removed.has(e.id) || e.colorName === whip.team || hits.has(e.id);
      if (skip || !nodeTouches(whip, e)) continue;
      lashEnemy(ctx, whip, e);
      hits.add(e.id);
      struck = true;
    }
    if (struck) whip.hits = [...hits];
  }
};
