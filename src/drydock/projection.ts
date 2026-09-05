// Shared inspector projection math. The WebGPU scene and the DOM gizmo must
// agree exactly or a handle will drift away from the selected mesh while the
// hull is orbiting.

import type { V3 } from "~/hull/catalog";
import { view } from "./store";

export type Mat3 = readonly number[];

const matMul = (a: Mat3, b: Mat3): number[] => {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
};

export const mulV = (m: Mat3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export const transpose = (m: Mat3): number[] => [
  m[0],
  m[3],
  m[6],
  m[1],
  m[4],
  m[7],
  m[2],
  m[5],
  m[8],
];

/** Rz(heading)·Rx(tilt)·Ry(roll), matching ship.wgsl's shipMat. */
export const shipMat = (
  heading: number,
  tilt: number,
  roll: number,
): number[] => {
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const rz = [ch, -sh, 0, sh, ch, 0, 0, 0, 1];
  const rx = [1, 0, 0, 0, ct, -st, 0, st, ct];
  const ry = [cr, 0, sr, 0, 1, 0, -sr, 0, cr];
  return matMul(rz, matMul(rx, ry));
};

/** Left control panel's outer edge in CSS px (margin + padding + border + width). */
export const PANEL_CLEAR_PX = 350;

/** The inspector hull pose in the canvas' backing-pixel coordinate space. */
export const inspectorPose = (w: number, h: number) => {
  const radius = Math.min(w, h) * 0.19;
  return {
    cx: w * 0.5,
    cy: h * 0.5,
    radius,
    roll: view.bank ? Math.sin(view.t * 1.6) * 0.55 : 0,
    heading: Math.PI + view.spinPhase + view.orbitYaw,
    tilt: (view.tiltDeg * Math.PI) / 180 + view.orbitPitch,
  };
};
