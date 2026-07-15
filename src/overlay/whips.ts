// view: the pilot's verlet WHIP. Rendered as a living tentacle — a soft
// team-tinted glow along the whole chain, a bright warm-white core stroke over
// it, small node beads for texture that taper from a thick base at the ship to a
// fine tip, and a white-hot flash at the lash point. Pure: reads world.whips;
// the motion is already baked into the node positions the sim advanced.

import { SHAPE } from "../sprites";
import type { World } from "../world";
import type { PushFn, Rgba } from "./push";

// Chain width (grid cells): fat near the ship, whip-thin at the tip.
const BASE_R = 1.5;
const TIP_R = 0.3;

// One oriented segment between two screen points (game's (sin,cos) heading
// convention, so the streak lies along the run — see the bolt shader branch).
const seg = (
  push: PushFn,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  halfW: number,
  color: Rgba,
) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  push(
    (ax + bx) / 2,
    (ay + by) / 2,
    halfW,
    len / 2,
    Math.atan2(dx, dy),
    SHAPE.bolt,
    color,
  );
};

export function drawWhips(
  push: PushFn,
  cellPx: number,
  cellPy: number,
  _now: number,
  world: World,
) {
  for (const whip of world.whips.items) {
    const n = whip.nodes.length;
    if (n < 2) continue;
    // Hold full brightness, then fade over the final gens as it recoils.
    const fade = Math.min(1, whip.life / 6);
    const [tr, tg, tb] = whip.rgb;
    const sx = whip.nodes.map((p) => (p.x + 0.5) * cellPx);
    const sy = whip.nodes.map((p) => (p.y + 0.5) * cellPy);
    const rAt = (i: number) => BASE_R + (TIP_R - BASE_R) * (i / (n - 1));

    // 1) Soft team-tinted glow along the whole chain — wide, low alpha.
    for (let i = 1; i < n; i++) {
      seg(push, sx[i - 1], sy[i - 1], sx[i], sy[i], rAt(i) * 2.0 * cellPx, [
        tr,
        tg,
        tb,
        0.14 * fade,
      ]);
    }

    // 2) Bright warm-white core stroke over the glow — the whip's body.
    for (let i = 1; i < n; i++) {
      const heat = 0.6 + 0.4 * ((i - 1) / (n - 1)); // hotter toward the tip
      seg(push, sx[i - 1], sy[i - 1], sx[i], sy[i], rAt(i) * 0.7 * cellPx, [
        tr + (1 - tr) * heat,
        tg + (1 - tg) * heat,
        tb + (1 - tb) * heat,
        0.9 * fade,
      ]);
    }

    // 3) Node beads for a segmented, organic read (small, tapering).
    for (let i = 0; i < n; i += 2) {
      const r = rAt(i) * 0.8;
      push(sx[i], sy[i], r * cellPx, r * cellPy, 0, SHAPE.solid, [
        tr + (1 - tr) * 0.5,
        tg + (1 - tg) * 0.5,
        tb + (1 - tb) * 0.5,
        0.7 * fade,
      ]);
    }

    // 4) White-hot flash at the lash tip.
    const t = n - 1;
    const flash = 1.4;
    push(sx[t], sy[t], flash * cellPx, flash * cellPy, 0, SHAPE.solid, [
      1,
      1,
      1,
      0.65 * fade,
    ]);
  }
}
