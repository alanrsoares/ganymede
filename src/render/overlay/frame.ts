// FrameInstances: the single value that crosses the overlay → renderer seam.
// The overlay projects the World into these packed instance arrays; the
// renderer only reads named fields. The caps and instance layouts live here
// because they describe the projection (how many of each entity a frame may
// carry, and how each record packs) — the GPU pipeline consumes them.

import type { ShipClass } from "~/hull/catalog";
import { instanceLayout } from "~/render/mesh-pass";

// --- Sprite/overlay quad instances (space shooter sprites and vector rings) ---

export const FLOATS_PER_INSTANCE = 12; // posSize(4) + rotShape(4) + color(4)
// Headroom for a busy fight: ~14 sprites/ace-ship × 12 ships + bolts + missiles
// + mines + shrapnel + bursts + field furniture. overlay.push warns if exceeded.
export const MAX_INSTANCES = 768;

// --- 3D mesh instances (rocks, shields). Each layout is the single source of
// truth for its float count, vertex attributes, and named packing offsets.
// WGSL @location structs must list fields in this same order. ---
export const MAX_ROCKS = 128;
export const MAX_SHIELDS = 16; // ship shields
export const MAX_ORBS = 12; // power-up energy orbs (own solid-lit pass)
export const MAX_BASES = 8;
export const MAX_CENTER_PADS = 2;
// prettier-ignore
export const ROCK_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "_a",
  "rx",
  "ry",
  "rz",
  "_b",
  "r",
  "g",
  "b",
  "damage",
]);
export const SHIELD_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "strength",
  "r",
  "g",
  "b",
  "flash",
]);
// 3D hull instances (ship.wgsl / drydock share this shape). One pass per ship
// class, so each class's baked part-assembly mesh draws all its ships at once.
export const MAX_MESH_SHIPS = 16;
// prettier-ignore
export const SHIP_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "roll",
  "heading",
  "tilt",
  "wavePhase", // spine articulation: temporal wave phase (per ship)
  "bendCurve", // spine articulation: signed turn lean (per ship)
  "amp", // articulation row: effective wave amplitude (drive-scaled)
  "freq", // spatial frequency along the spine
  "headStiff", // y above which the hull is rigid
  "segLen", // 0 = smooth flex; > 0 = hinged rigid segments
  "r",
  "g",
  "b",
  "alpha",
]);
// Engine plume cones, one instance per nozzle anchor per ship (plume.wgsl).
export const MAX_PLUMES = MAX_MESH_SHIPS * 4;
// prettier-ignore
export const PLUME_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "roll",
  "heading",
  "tilt",
  "throttle",
  "phase",
  "nx",
  "ny",
  "nz",
  "w",
  "r",
  "g",
  "b",
  "alpha",
]);

/** Per-class hull instance buffers + engine plume instances for the mesh passes. */
export interface ShipBuckets {
  instances: Record<ShipClass, Float32Array<ArrayBuffer>>;
  counts: Record<ShipClass, number>;
  plumes: Float32Array<ArrayBuffer>;
  plumeCount: number;
}

/**
 * One frame's worth of packed instance data — everything the renderer needs
 * to draw a World, and nothing else. Arrays are reused across frames; only
 * the leading `*Count` records of each are valid.
 */
export interface FrameInstances {
  /** Sprite quads. Portals occupy the leading `portalCount` records so the
   * renderer can draw them under the 3D passes. */
  instances: Float32Array<ArrayBuffer>;
  count: number;
  portalCount: number;
  rockInstances: Float32Array<ArrayBuffer>;
  rockCount: number;
  shieldInstances: Float32Array<ArrayBuffer>;
  shieldCount: number;
  orbInstances: Float32Array<ArrayBuffer>;
  orbCount: number;
  baseInstances: Float32Array<ArrayBuffer>;
  baseCount: number;
  centerPadInstances: Float32Array<ArrayBuffer>;
  centerPadCount: number;
  ships: ShipBuckets;
}
