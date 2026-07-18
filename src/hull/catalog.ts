// Hull catalog: the serializable data the drydock designer edits and the game
// reads — palette, part/prim definitions, per-class hull recipes and engine
// anchors, in the cosmic-horror-meets-acid-cartoon direction: bone carapace
// masses, fang spikes, glowing polyps and a cyclopean eye orb per hull.
// Pure data, no geometry — baking lives in hull/bake.ts.
//
// Conventions: ship local space has the nose along +Y, +Z toward the viewer,
// authored roughly within ±1.1 along Y so instance `radius` ≈ half-length px.

export type V3 = [number, number, number];

/** Serializable primitive description — what the hull designer edits. */
export type PrimDef =
  | { kind: "slab"; tx: number; tz: number; bevel?: number }
  | { kind: "hex"; taper: number }
  | { kind: "orb" };

// --- palette ------------------------------------------------------------------
// Bone carapace over void-purple sinew, acid-green emissives (values > 1 mark
// emissive surfaces), iridescent magenta eye. Team tint multiplies on top in
// the shader (same k=0.55 near-white multiply as sprite hulls used).

export const PALETTE = {
  bone: [0.78, 0.74, 0.64],
  carapace: [0.45, 0.38, 0.55], // void purple
  sinew: [0.28, 0.2, 0.34],
  fang: [0.88, 0.85, 0.72],
  acid: [1.4, 2.4, 0.5], // emissive portal green
  eye: [2.2, 0.5, 2.0], // emissive magenta iris
  maw: [0.1, 0.06, 0.12],
} as const satisfies Record<string, V3>;
export type PaletteKey = keyof typeof PALETTE;
export const PALETTE_KEYS = Object.keys(PALETTE) as readonly PaletteKey[];

/** One hull part: prim + placement + palette colour. Plain serializable data. */
export interface PartDef {
  prim: PrimDef;
  /** Per-axis scale applied before rotation. */
  scale: V3;
  /** Euler rotation in radians, applied Rz·Ry·Rx. */
  rot?: V3;
  pos: V3;
  color: PaletteKey;
  /** Also bake an x-mirrored copy. */
  mirror?: boolean;
  /** Bake as a chain of this many overlapping carapace plates along the
   * part's local Y (centipede segmentation, hull/bake.ts expandSeg). Long
   * prims only have vertices at their ends, so the spine wave (ship.wgsl)
   * would shear them; short plates tilt near-rigidly instead. 0/1 = solid. */
  seg?: number;
}

// --- recipes -------------------------------------------------------------------
// Aspect ratio carries the tiny-scale read (dart / cross / slab / needle);
// the gear sells the role up close. A couple of parts per hull are
// deliberately NOT mirrored — eldritch things are never quite symmetric.

const deg = (d: number): number => (d * Math.PI) / 180;
const SLAB = (tx: number, tz: number, bevel?: number): PrimDef =>
  bevel ? { kind: "slab", tx, tz, bevel } : { kind: "slab", tx, tz };
const HEX = (taper: number): PrimDef => ({ kind: "hex", taper });
const ORB: PrimDef = { kind: "orb" };

// Hull design language (see .agents/skills/hull-design): masses overlap
// deeply along the spine so silhouettes stay continuous — nothing floats.
// Wings root INSIDE the fuselage and sweep back; engines embed in the tail
// mass with only the acid lip protruding. Big → medium → small rhythm:
// one dominant mass, secondary pods/wings, then greebles.

/** scout — "Lamprey": jawless eel-dart, ventral sucker maw, dorsal eye. */
const SCOUT: PartDef[] = [
  {
    prim: SLAB(0.22, 0.45, 0.1),
    scale: [0.34, 1.7, 0.26],
    pos: [0, 0.15, 0],
    color: "bone",
    seg: 6,
  },
  {
    prim: SLAB(0.6, 0.7, 0.12),
    scale: [0.44, 1.09, 0.3],
    pos: [0, -0.55, 0.02],
    color: "carapace",
    seg: 3,
  },
  {
    prim: SLAB(0.15, 0.3, 0.06),
    scale: [0.25, 1.15, 0.14],
    pos: [0, -0.15, 0.16],
    color: "bone",
    seg: 5,
  },
  {
    prim: SLAB(0.5, 0.4, 0.06),
    scale: [0.18, 0.42, 0.12],
    pos: [0, 0.72, -0.08],
    color: "maw",
  },
  {
    prim: SLAB(0.05, 0.05),
    scale: [0.05, 0.22, 0.05],
    rot: [deg(-78), 0, 0],
    pos: [0.08, 0.88, -0.1],
    color: "fang",
    mirror: true,
  },
  {
    prim: ORB,
    scale: [0.2, 0.2, 0.2],
    pos: [0, 0.45, 0.12],
    color: "eye",
  },
  {
    prim: SLAB(0.1, 0.35, 0.06),
    scale: [1.5, 0.12, 0.05],
    rot: [0, deg(8), deg(-38)],
    pos: [0.28, 0.05, 0],
    color: "carapace",
    mirror: true,
  },
  {
    prim: ORB,
    scale: [2.5, 0.6, 0.06],
    rot: [0, 0, deg(-42)],
    pos: [0.18, -0.55, 0.04],
    color: "bone",
    mirror: true,
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.04, 0.26, 0.04],
    rot: [0, 0, deg(-52)],
    pos: [0.46, -0.75, 0.04],
    color: "fang",
    mirror: true,
  },
  {
    prim: SLAB(0.41, 0.05),
    scale: [0.05, 0.5, 0.05],
    rot: [deg(-30), 0, 0],
    pos: [-0.07, -0.35, 0.22],
    color: "fang",
  },
  {
    prim: SLAB(0.41, 0.05),
    scale: [0.05, 0.5, 0.05],
    rot: [deg(-30), 0, 0],
    pos: [0.07, -0.35, 0.22],
    color: "fang",
  },
  {
    prim: HEX(0.7),
    scale: [0.18, 0.5, 0.18],
    pos: [0, -0.95, 0],
    color: "sinew",
  },
  {
    prim: HEX(0.9),
    scale: [0.12, 0.14, 0.12],
    pos: [0, -1.16, 0],
    color: "acid",
  },
];

/** fighter — "Ossuary": rib-caged cross gunboat, tusk barrels, bone wings. */
const FIGHTER: PartDef[] = [
  {
    prim: SLAB(0.4, 0.55, 0.12),
    scale: [0.42, 1.5, 0.3],
    pos: [0, 0.1, 0],
    color: "carapace",
  },
  {
    prim: SLAB(0.25, 0.35, 0.08),
    scale: [0.3, 0.5, 0.22],
    pos: [0, 0.82, -0.01],
    color: "bone",
  },
  {
    prim: SLAB(0.7, 0.75, 0.12),
    scale: [0.55, 0.62, 0.32],
    pos: [0, -0.62, 0],
    color: "carapace",
  },
  {
    prim: SLAB(0.18, 0.5, 0.08),
    scale: [2.5, 0.4, 0.07],
    rot: [0, deg(6), deg(-24)],
    pos: [0.45, -0.15, 0.02],
    color: "bone",
    mirror: true,
  },
  {
    prim: SLAB(0.1, 0.4, 0.06),
    scale: [1.4, 0.25, 0.25],
    rot: [0, 0, deg(-24)],
    pos: [0.36, -0.08, 0],
    color: "carapace",
    mirror: true,
  },
  {
    prim: SLAB(0.05, 0.05),
    scale: [0.05, 0.3, 0.05],
    rot: [0, 0, deg(-30)],
    pos: [0.76, -0.36, 0.02],
    color: "fang",
    mirror: true,
  },
  {
    prim: SLAB(0.75, 0.5, 0.06),
    scale: [0.35, 0.14, 0.12],
    pos: [0, 0.3, 0.16],
    color: "bone",
  },
  {
    prim: SLAB(0.75, 0.5, 0.06),
    scale: [0.44, 0.13, 0.11],
    pos: [0, 0.02, 0.19],
    color: "bone",
  },
  {
    prim: SLAB(0.75, 0.5, 0.06),
    scale: [0.45, 0.12, 0.1],
    pos: [0, -0.26, 0.2],
    color: "bone",
  },
  {
    prim: SLAB(0.08, 0.08),
    scale: [0.07, 0.7, 0.07],
    rot: [0, 0, deg(2)],
    pos: [0.22, 0.75, -0.04],
    color: "fang",
    mirror: true,
  },
  {
    prim: HEX(0.8),
    scale: [0.1, 0.25, 0.1],
    pos: [0.22, 0.4, -0.04],
    color: "sinew",
    mirror: true,
  },
  {
    prim: ORB,
    scale: [0.17, 0.17, 0.17],
    pos: [0, 0.6, 0.14],
    color: "eye",
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.04, 0.32, 0.04],
    rot: [deg(-35), 0, deg(-10)],
    pos: [-0.12, -0.5, 0.24],
    color: "fang",
  },
  {
    prim: HEX(0.75),
    scale: [0.15, 0.45, 0.15],
    pos: [0.2, -0.95, 0],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.1, 0.13, 0.1],
    pos: [0.2, -1.18, 0],
    color: "acid",
    mirror: true,
  },
];

/** heavy — "Leviathan": whale barge, layered shell over bone belly, gaping maw. */
const HEAVY: PartDef[] = [
  {
    prim: SLAB(0.6, 1, 0.16),
    scale: [1, 1.6, 0.42],
    pos: [0, -0.1, 0.06],
    color: "carapace",
  },
  {
    prim: SLAB(0.7, 0.6, 0.12),
    scale: [0.8, 1.3, 0.3],
    pos: [0, 0, -0.14],
    color: "bone",
  },
  {
    prim: SLAB(0.5, 0.5, 0.12),
    scale: [0.6, 0.55, 0.3],
    pos: [0, 0.62, 0.02],
    color: "carapace",
  },
  {
    prim: SLAB(0.55, 0.4, 0.08),
    scale: [0.42, 0.35, 0.24],
    pos: [0, 0.85, -0.06],
    color: "maw",
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.07, 0.26, 0.07],
    rot: [deg(-90), 0, 0],
    pos: [0.16, 1, -0.02],
    color: "fang",
    mirror: true,
  },
  {
    prim: SLAB(0.04, 0.04),
    scale: [0.06, 0.22, 0.06],
    rot: [deg(-90), 0, 0],
    pos: [0.05, 1.02, -0.12],
    color: "fang",
    mirror: true,
  },
  {
    prim: SLAB(0.85, 0.6, 0.1),
    scale: [0.55, 0.7, 0.12],
    pos: [0, 0.05, 0.34],
    color: "bone",
  },
  {
    prim: SLAB(0.8, 0.6, 0.1),
    scale: [0.4, 0.45, 0.1],
    pos: [0, -0.3, 0.36],
    color: "bone",
  },
  {
    prim: ORB,
    scale: [0.5, 0.4, 0.4],
    pos: [0, 0.42, 0.2],
    color: "eye",
  },
  {
    prim: HEX(0.8),
    scale: [0.5, 1, 0.26],
    pos: [0.55, -0.16, -0.05],
    color: "carapace",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.13, 0.14, 0.13],
    pos: [0.55, -0.72, -0.02],
    color: "acid",
    mirror: true,
  },
  {
    prim: HEX(0.75),
    scale: [0.16, 0.5, 0.16],
    pos: [0.18, -1, -0.04],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.11, 0.13, 0.11],
    pos: [0.18, -1.24, -0.04],
    color: "acid",
    mirror: true,
  },
  {
    prim: HEX(0.5),
    scale: [0.14, 0.2, 0.14],
    pos: [0.36, -0.35, 0.3],
    color: "acid",
  },
  {
    prim: HEX(0.5),
    scale: [0.1, 0.14, 0.1],
    pos: [-0.42, -0.2, 0.28],
    color: "acid",
  },
];

/** interceptor — "Stinger": wasp needle, thorax + abdomen, egg-sac clutch. */
const INTERCEPTOR: PartDef[] = [
  {
    prim: SLAB(0.12, 0.25, 0.08),
    scale: [0.2, 2.2, 0.18],
    pos: [0, 0, 0],
    color: "bone",
    seg: 7,
  },
  {
    prim: SLAB(0.03, 0.03),
    scale: [0.07, 0.5, 0.07],
    pos: [0, 0.9, 0],
    color: "fang",
  },
  {
    prim: SLAB(0.45, 0.6, 0.1),
    scale: [0.24, 0.7, 0.22],
    pos: [0, 0.25, 0.02],
    color: "carapace",
  },
  {
    prim: HEX(0.85),
    scale: [0.16, 0.35, 0.16],
    pos: [0, -0.28, 0],
    color: "sinew",
  },
  {
    prim: SLAB(0.55, 0.5, 0.14),
    scale: [0.3, 0.75, 0.26],
    pos: [0, -0.68, 0],
    color: "carapace",
    seg: 3,
  },
  {
    prim: SLAB(0.08, 0.35, 0.05),
    scale: [0.3, 0.4, 0.04],
    rot: [0, 0, deg(-30)],
    pos: [0.18, 0.35, 0.02],
    color: "carapace",
    mirror: true,
  },
  {
    prim: SLAB(0.1, 0.4, 0.06),
    scale: [1.41, 0.55, 0.05],
    rot: [0, 0, deg(-50)],
    pos: [0.28, -0.75, -0.03],
    color: "bone",
    mirror: true,
  },
  {
    prim: SLAB(0.12, 0.35, 0.05),
    scale: [0.05, 0.45, 0.32],
    pos: [0, -0.85, 0.2],
    color: "carapace",
  },
  {
    prim: ORB,
    scale: [0.09, 0.12, 0.09],
    pos: [0.2, -0.55, 0.1],
    color: "acid",
    mirror: true,
  },
  {
    prim: ORB,
    scale: [0.08, 0.1, 0.08],
    pos: [0.14, -0.78, 0.16],
    color: "acid",
  },
  {
    prim: ORB,
    scale: [0.13, 0.13, 0.13],
    pos: [-0.06, 0.55, 0.09],
    color: "eye",
  },
  {
    prim: HEX(0.7),
    scale: [0.11, 0.45, 0.11],
    pos: [0.13, -0.98, -0.02],
    color: "sinew",
    mirror: true,
  },
  {
    prim: HEX(0.9),
    scale: [0.08, 0.11, 0.08],
    pos: [0.13, -1.2, -0.02],
    color: "acid",
    mirror: true,
  },
];

export const RECIPES = {
  scout: SCOUT,
  fighter: FIGHTER,
  heavy: HEAVY,
  interceptor: INTERCEPTOR,
} as const;

/** One engine anchor: nozzle exit in ship-local units + plume width. */
export interface EngineAnchor {
  pos: V3;
  w: number;
}

// Nozzle exits per class, matching each recipe's acid nozzle parts (mirrored
// pairs listed explicitly so the plume pass needs no mirror logic).
export const ENGINES: Record<keyof typeof RECIPES, readonly EngineAnchor[]> = {
  scout: [{ pos: [0, -1.22, 0], w: 0.17 }],
  fighter: [
    { pos: [0.2, -1.24, 0], w: 0.14 },
    { pos: [-0.2, -1.24, 0], w: 0.14 },
  ],
  heavy: [
    { pos: [0.55, -0.78, -0.02], w: 0.16 },
    { pos: [-0.55, -0.78, -0.02], w: 0.16 },
    { pos: [0.18, -1.3, -0.04], w: 0.14 },
    { pos: [-0.18, -1.3, -0.04], w: 0.14 },
  ],
  interceptor: [
    { pos: [0.13, -1.25, -0.02], w: 0.12 },
    { pos: [-0.13, -1.25, -0.02], w: 0.12 },
  ],
};

export type ShipClass = keyof typeof RECIPES;
export const SHIP_CLASSES = Object.keys(RECIPES) as readonly ShipClass[];

/** Spine articulation — cosmetic vertex-shader deformation, render-only.
 * The hull swims: a travelling lateral wave runs nose→tail (enveloped to
 * zero at the stiff head) and the spine leans into turns. Evaluated in
 * ship.wgsl per vertex and mirrored in hull/articulation.ts for the
 * CPU-side plume anchors. */
export interface ArticulationDef {
  /** Lateral wave amplitude in ship-local units (0 = rigid hull). */
  amp: number;
  /** Spatial frequency of the wave along the spine. */
  freq: number;
  /** Temporal wave rate multiplier. */
  speed: number;
  /** Spine y above which the hull is rigid (nose is +Y). */
  headStiff: number;
  /** 0 = smooth flex; > 0 = rigid hinged segments of this length. */
  segLen: number;
}

// Stock articulation per class. Serpent-shaped hulls (scout "Lamprey",
// interceptor "Stinger") swim visibly; fighter ripples; heavy barely flexes.
// Tune live in /drydock, then export back here (clipboard round-trip).
export const ARTICULATION: Record<ShipClass, ArticulationDef> = {
  scout: { amp: 0.1, freq: 3.5, speed: 1, headStiff: 0.4, segLen: 0 },
  fighter: { amp: 0.03, freq: 3, speed: 0.8, headStiff: 0.3, segLen: 0 },
  heavy: { amp: 0.015, freq: 2, speed: 0.4, headStiff: 0.2, segLen: 0 },
  interceptor: { amp: 0.06, freq: 4.5, speed: 1.3, headStiff: 0.55, segLen: 0 },
};
