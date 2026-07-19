// Arcade augment stack: permanent, accumulating per-run upgrades layered on top
// of the L5 hull cap as *compounding* multipliers. The player picks 1 of 3 at
// each wave clear and they survive death — this is the arcade long-horizon
// power lever. Enemies stay capped at L5; every multiplier here is player-side
// only (applied through the pilot predicate in the tick, never to enemies).
//
// Phase 1 ships the six stat augments. The unlock/summon augments (spread cone,
// nova, wing) arrive in later phases and slot into this same catalogue.

import { nextRange, type Seed } from "~/engine/rng";

/** The stat an augment scales, keyed to a pilot derived-stat. */
export type AugmentStat =
  | "hp"
  | "shield"
  | "cooldown"
  | "damage"
  | "regen"
  | "speed";

export type AugmentId =
  | "hull"
  | "plating"
  | "overclock"
  | "caliber"
  | "nanofoam"
  | "thrusters"
  | "spread"
  | "nova"
  | "wing"
  | "aegis"
  | "overdrive";

// "stat" augments fold into augMul (a compounding multiplier on a derived stat);
// "unlock"/"summon" augments are read by raw stack count at their own tick sites
// (augCount) — the fan weapon, the nova blast, the escort wing.
export type AugmentKind = "stat" | "unlock" | "summon";

export interface AugmentSpec {
  readonly id: AugmentId;
  readonly kind?: AugmentKind; // defaults to "stat"
  readonly stat?: AugmentStat; // stat kind only
  /** Per-stack multiplier; compounds as `mul ** stacks`. <1 shrinks (cooldown). */
  readonly mul?: number; // stat kind only
  /** Capstone gate: this augment can't be offered until the run's total augment
   * tier reaches this (see rollOffer). Absent = always offerable. */
  readonly minTier?: number;
  readonly label: string; // offer-card title
  readonly blurb: string; // offer-card subtitle
}

// Tuning knobs (see docs/arcade-endgame-plan.md → open tuning knobs). Early
// picks feel big; compounding keeps power climbing every wave you clear.
export const AUGMENTS: Record<AugmentId, AugmentSpec> = {
  hull: {
    id: "hull",
    stat: "hp",
    mul: 1.18,
    label: "Hull",
    blurb: "+18% max HP",
  },
  plating: {
    id: "plating",
    stat: "shield",
    mul: 1.15,
    label: "Plating",
    blurb: "+15% shield",
  },
  overclock: {
    id: "overclock",
    stat: "cooldown",
    mul: 0.92,
    label: "Overclock",
    blurb: "−8% fire cooldown",
  },
  caliber: {
    id: "caliber",
    stat: "damage",
    mul: 1.15,
    label: "Caliber",
    blurb: "+15% bolt damage",
  },
  nanofoam: {
    id: "nanofoam",
    stat: "regen",
    mul: 1.5,
    label: "Nanofoam",
    blurb: "+50% hull regen",
  },
  thrusters: {
    id: "thrusters",
    stat: "speed",
    mul: 1.08,
    label: "Thrusters",
    blurb: "+8% speed",
  },
  spread: {
    id: "spread",
    kind: "unlock",
    label: "Spread",
    blurb: "cone shot · +1 barrel",
  },
  nova: {
    id: "nova",
    kind: "unlock",
    label: "Nova",
    blurb: "R: cone blast · wider",
  },
  wing: {
    id: "wing",
    kind: "summon",
    label: "Wing",
    blurb: "+1 escort drone",
  },
  // Capstones: build-defining, only offered once the run is deep (minTier).
  aegis: {
    id: "aegis",
    kind: "stat",
    stat: "shield",
    mul: 2,
    minTier: 6,
    label: "Aegis",
    blurb: "capstone · ×2 shield",
  },
  overdrive: {
    id: "overdrive",
    kind: "stat",
    stat: "damage",
    mul: 1.5,
    minTier: 6,
    label: "Overdrive",
    blurb: "capstone · ×1.5 damage",
  },
};

export const AUGMENT_IDS = Object.keys(AUGMENTS) as AugmentId[];

/** A run's augment tally: id → stacks owned. Sparse; missing key = 0 stacks. */
export type AugmentStacks = Readonly<Partial<Record<AugmentId, number>>>;

// Overclock compounds toward zero cooldown; floor the *combined* cooldown
// multiplier so cadence can't collapse (≈ this fraction of the L5 baseline).
export const MIN_COOLDOWN_MUL = 0.45;

/**
 * Compounding multiplier for one stat across the whole stack. Returns 1 when no
 * owned augment touches `stat`. The cooldown stat is floored so overclock stacks
 * can't drive the fire interval to zero.
 */
export const augMul = (stacks: AugmentStacks, stat: AugmentStat): number => {
  let m = 1;
  for (const id of AUGMENT_IDS) {
    const n = stacks[id] ?? 0;
    const spec = AUGMENTS[id];
    if (n > 0 && spec.stat === stat && spec.mul != null) m *= spec.mul ** n;
  }
  return stat === "cooldown" ? Math.max(MIN_COOLDOWN_MUL, m) : m;
};

/** Raw stacks owned of one augment — how unlock/summon augments read intensity. */
export const augCount = (stacks: AugmentStacks, id: AugmentId): number =>
  stacks[id] ?? 0;

/** Total stacks owned — the prestige "Mk N" readout on the HUD. */
export const augmentTier = (stacks: AugmentStacks): number => {
  let t = 0;
  for (const id of AUGMENT_IDS) t += stacks[id] ?? 0;
  return t;
};

// Offer likelihood, shaped by how deep the run is (tier = total stacks owned):
// the build-defining unlock/summon augments are front-loaded, stat augments ramp
// up late, and capstones stay locked until their minTier. 0 = never offered.
const offerWeight = (spec: AugmentSpec, tier: number): number => {
  if (spec.minTier != null && tier < spec.minTier) return 0;
  if (spec.minTier != null) return 5; // unlocked capstone
  return (spec.kind ?? "stat") === "stat"
    ? 2 + tier // stat fill — likelier as the run deepens
    : Math.max(1, 6 - tier); // unlock/summon — front-loaded
};

/**
 * Roll the 3 distinct augment ids offered at a wave clear, weighted by run depth
 * (see offerWeight) and off the world seed. Distinct within one offer, but any
 * unlocked id (owned or not) can appear — that's how a run stacks an augment
 * across waves. Returns the advanced seed.
 */
export const rollOffer = (
  seed: Seed,
  stacks: AugmentStacks,
): { offer: AugmentId[]; seed: Seed } => {
  const tier = augmentTier(stacks);
  const pool = AUGMENT_IDS.map((id) => ({
    id,
    w: offerWeight(AUGMENTS[id], tier),
  })).filter((e) => e.w > 0);
  const offer: AugmentId[] = [];
  let s = seed;
  const n = Math.min(3, pool.length);
  for (let i = 0; i < n; i++) {
    const total = pool.reduce((t, e) => t + e.w, 0);
    const [r, s2] = nextRange(s, 0, total);
    s = s2;
    let acc = 0;
    let pick = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      acc += pool[j].w;
      if (r < acc) {
        pick = j;
        break;
      }
    }
    offer.push(pool[pick].id);
    pool.splice(pick, 1);
  }
  return { offer, seed: s };
};
