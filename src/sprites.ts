// Single source of truth for the SpaceRage sprite atlas: which image lands on
// which texture-array layer, plus the data-driven animation model. Both the GPU
// texture loader (gpu.ts) and the pure view (overlay.ts) import from here so the
// loader and the renderer can never disagree about layer indices or timings.

const ROOT = "/assets/SpaceRage";
const pad2 = (n: number): string => n.toString().padStart(2, "0");
const frames = (count: number, url: (n: number) => string): string[] =>
  Array.from({ length: count }, (_, i) => url(i + 1));

// Ships reuse a small set of ARTICULATED SpaceRage hulls, each with 5 banking
// frames [bankL2, bankL1, middle, bankR1, bankR2]. Tier reads from silhouette +
// size, team from tint — so one hull serves all five teams (recolored in the
// overlay) and the atlas stays tiny. No flat (single-frame) hulls: every ship
// banks. `flip` marks nose-down enemy art (its heading gets a PI offset).
// SpaceRage banking set (l2, l1, m, r1, r2) for a hull prefix.
const banks = (base: string): string[] =>
  ["l2", "l1", "m", "r1", "r2"].map((b) => `${base}_${b}.png`);

// Four distinct silhouettes. Color-variants (b/g/r) are the same shape, so we
// load one color each — the team tint recolors it. One hull = 5 atlas layers.
const HULLS = {
  scout: { base: `${ROOT}/Player/player_b`, flip: false },
  fighter: { base: `${ROOT}/Enemies/enemy_1_b`, flip: true },
  heavy: { base: `${ROOT}/Enemies/enemy_2_b`, flip: true },
  interceptor: { base: `${ROOT}/Player/player_r`, flip: false },
} as const;
type HullKey = keyof typeof HULLS;
const HULL_ORDER: readonly HullKey[] = [
  "scout",
  "fighter",
  "heavy",
  "interceptor",
];
// Hull key ↔ ship class archetype are 1:1 (scout/fighter/heavy/interceptor), so a
// ship's silhouette is its class; size + tint + rank pips read the team & level.
const SHIP_FRAME_COUNT = 5;

// Atlas ship section: each unique hull's banking frames once, in HULL_ORDER.
const SHIP_FRAMES: readonly string[] = HULL_ORDER.flatMap((k) =>
  banks(HULLS[k].base),
);
const hullLayer0 = ((): Record<HullKey, number> => {
  const out = {} as Record<HullKey, number>;
  HULL_ORDER.forEach((k, i) => {
    out[k] = i * SHIP_FRAME_COUNT;
  });
  return out;
})();
const SHIP_LAYER_TOTAL = SHIP_FRAMES.length;

// Three explosion variants with differing frame counts, played at random per
// blast for visual variety.
export const EXPLOSION_FRAME_COUNTS = [11, 9, 9] as const;
export const EXPLOSION_VARIANTS = EXPLOSION_FRAME_COUNTS.length;
export const EXHAUST_FRAMES = 5;
export const MINE_FRAMES = 9; // mine_1 tumble loop
export const DETONATION_FRAMES = 3; // proton FX flash
export const VULCAN_FRAMES = 3; // vulcan muzzle/impact spark
// Five distinct hand-drawn rocks (Space Pack). Swirl comes from per-rock
// rotation in the sim, so these are static textures, not an animation clip.
export const ASTEROID_VARIANTS = 5;

const EXPLOSION_URLS = EXPLOSION_FRAME_COUNTS.flatMap((count, v) =>
  frames(count, (n) => `${ROOT}/Explosions/explosion_${v + 1}_${pad2(n)}.png`),
);
const EXHAUST_URLS = frames(
  EXHAUST_FRAMES,
  (n) => `${ROOT}/FX/exhaust_${pad2(n)}.png`,
);
const ASTEROID_URLS = frames(
  ASTEROID_VARIANTS,
  (n) => `/assets/SpacePack/Asteroids/Asteroid_${n}.png`,
);
const MINE_URLS = frames(
  MINE_FRAMES,
  (n) => `${ROOT}/Enemies/mine_1_${pad2(n)}.png`,
);
const DETONATION_URLS = frames(
  DETONATION_FRAMES,
  (n) => `${ROOT}/FX/proton_${pad2(n)}.png`,
);
// vulcan_1..3 (no zero-pad) — reused for both muzzle flash and bolt impact.
const VULCAN_URLS = frames(VULCAN_FRAMES, (n) => `${ROOT}/FX/vulcan_${n}.png`);

// Power-up bubbles, indexed by PickupKind (heal, shield, speed).
export const PICKUP_URLS: readonly string[] = [
  "/assets/SpacePack/Baloons/Green_Balloon.png", // heal
  "/assets/SpacePack/Baloons/Blue_Balloon.png", // shield
  "/assets/SpacePack/Baloons/Yellow_Balloon.png", // speed
];
const PORTAL_URL = "/assets/SpacePack/Portal/Base.png";
const BASE_URL = "/assets/SpacePack/Base/Cube_1.png";

// Ordered atlas tail (everything after the ship hulls). This list is the ONE
// source of truth for both texture-upload order and layer offsets — derive both
// from it so the two can never drift out of sync.
const ATLAS_TAIL = [
  { key: "explosion", urls: EXPLOSION_URLS },
  { key: "exhaust", urls: EXHAUST_URLS },
  { key: "asteroid", urls: ASTEROID_URLS },
  { key: "pickup", urls: PICKUP_URLS },
  { key: "portal", urls: [PORTAL_URL] },
  { key: "base", urls: [BASE_URL] },
  { key: "mine", urls: MINE_URLS },
  { key: "detonation", urls: DETONATION_URLS },
  { key: "vulcan", urls: VULCAN_URLS },
] as const;
type AtlasKey = (typeof ATLAS_TAIL)[number]["key"];

// Layer offset of each tail group's first frame (running sum after the ships).
const tailLayer0 = ((): Record<AtlasKey, number> => {
  const out = {} as Record<AtlasKey, number>;
  let acc = SHIP_LAYER_TOTAL;
  for (const g of ATLAS_TAIL) {
    out[g.key] = acc;
    acc += g.urls.length;
  }
  return out;
})();
/** Texture layer where atlas-tail group `key` begins. */
const L = (key: AtlasKey): number => tailLayer0[key];

export const SPRITE_URLS: readonly string[] = [
  ...SHIP_FRAMES,
  ...ATLAS_TAIL.flatMap((g) => g.urls),
];
export const SPRITE_LAYER_COUNT = SPRITE_URLS.length;

// --- Ship sprite refs -------------------------------------------------------

export interface SpriteRef {
  readonly layer0: number; // texture layer of the middle (neutral) frame's set
  readonly frameCount: number; // banking frames (1 = no banking)
  readonly angleOffset: number; // radians added to heading to orient the art
}

// Hull for a ship's class archetype (team = tint, level = size, applied in the
// overlay). Archetype names are the hull keys; fall back to scout if unknown.
export const shipSprite = (archetype: string): SpriteRef => {
  const key: HullKey = archetype in HULLS ? (archetype as HullKey) : "scout";
  return {
    layer0: hullLayer0[key],
    frameCount: SHIP_FRAME_COUNT,
    angleOffset: HULLS[key].flip ? Math.PI : 0,
  };
};

/**
 * Pick a banking frame layer from a signed turn amount. `turn` > 0 banks one
 * way, < 0 the other; magnitude selects how hard. Single-frame hulls ignore it.
 */
export const bankLayer = (ref: SpriteRef, turn: number): number => {
  if (ref.frameCount <= 1) return ref.layer0;
  const mid = Math.floor(ref.frameCount / 2);
  let step = 0;
  if (turn > 0.16) step = 2;
  else if (turn > 0.05) step = 1;
  else if (turn < -0.16) step = -2;
  else if (turn < -0.05) step = -1;
  const idx = Math.max(0, Math.min(ref.frameCount - 1, mid + step));
  return ref.layer0 + idx;
};

// --- Animation clips --------------------------------------------------------

export interface AnimClip {
  readonly layer0: number; // texture layer of frame 0
  readonly frames: number;
  readonly frameMs: number;
  readonly loop: boolean;
}

// One clip per explosion variant, laid out contiguously from the "explosion"
// group's base layer.
export const EXPLOSION_CLIPS: readonly AnimClip[] = EXPLOSION_FRAME_COUNTS.map(
  (count, v) => ({
    layer0:
      L("explosion") +
      EXPLOSION_FRAME_COUNTS.slice(0, v).reduce((a, b) => a + b, 0),
    frames: count,
    frameMs: 45,
    loop: false,
  }),
);

const ASTEROID_LAYER0 = L("asteroid");
const PICKUP_LAYER0 = L("pickup");
const PORTAL_LAYER0 = L("portal");
const BASE_LAYER0 = L("base");

export const CLIP = {
  // Default explosion (variant 0) — used where a single clip is needed.
  explosion: EXPLOSION_CLIPS[0],
  exhaust: {
    layer0: L("exhaust"),
    frames: EXHAUST_FRAMES,
    frameMs: 60,
    loop: true,
  },
  mine: { layer0: L("mine"), frames: MINE_FRAMES, frameMs: 80, loop: true },
  detonation: {
    layer0: L("detonation"),
    frames: DETONATION_FRAMES,
    frameMs: 40,
    loop: false,
  },
  vulcan: {
    layer0: L("vulcan"),
    frames: VULCAN_FRAMES,
    frameMs: 28,
    loop: false,
  },
} as const satisfies Record<string, AnimClip>;

/** Explosion clip for a variant index (wrapped into range). */
export const explosionClip = (v: number): AnimClip =>
  EXPLOSION_CLIPS[
    ((v % EXPLOSION_VARIANTS) + EXPLOSION_VARIANTS) % EXPLOSION_VARIANTS
  ];

/** Texture layer for asteroid variant `v` (wrapped into range). */
export const asteroidLayer = (v: number): number =>
  ASTEROID_LAYER0 +
  (((v % ASTEROID_VARIANTS) + ASTEROID_VARIANTS) % ASTEROID_VARIANTS);

/** Texture layer for power-up kind index (0 heal, 1 shield, 2 speed). */
export const pickupLayer = (kind: number): number => PICKUP_LAYER0 + kind;
/** Texture layer for the portal ring. */
export const PORTAL_LAYER = PORTAL_LAYER0;
/** Texture layer for the team base platform. */
export const BASE_LAYER = BASE_LAYER0;

export const durationOf = (clip: AnimClip): number =>
  clip.frames * clip.frameMs;

/**
 * Texture layer for a clip's current frame. Looping clips wrap forever (pass
 * start=0 for a free-running loop keyed off the global clock); non-looping clips
 * return -1 once finished.
 */
export const clipLayer = (
  clip: AnimClip,
  start: number,
  now: number,
): number => {
  const i = Math.floor((now - start) / clip.frameMs);
  if (clip.loop)
    return clip.layer0 + (((i % clip.frames) + clip.frames) % clip.frames);
  return i >= 0 && i < clip.frames ? clip.layer0 + i : -1;
};

// Overlay "shape" codes consumed by gpu.ts's fragment shader. `rect` is the
// shader's fall-through branch (solid quad, no distance falloff); `sprite`
// covers every textured draw (ships, explosions, exhaust).
export const SHAPE = {
  rect: 0.0,
  solid: 1.0,
  ring: 2.0,
  sprite: 3.0,
  tintsprite: 4.0, // textured, but multiplied by the instance color (team tint)
  fxsprite: 5.0, // textured FX with a soft radial edge fade (no square cutoff)
  beam: 6.0,
  pad: 7.0,
  bolt: 8.0, // plasma weapon bolt: hot core + team glow, tapered streak
  vortex: 9.0, // procedural spiraling accretion vortex (portals); layer = spin dir
} as const;
