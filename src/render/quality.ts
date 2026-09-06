// Graphics quality: one source of truth for every render knob a player (or the
// auto-governor) can move. A tier is a plain settings record — no GPU state, no
// DOM — so the renderer reads it each resize/frame and the tests read it
// directly. The chosen mode persists to localStorage through the same `kv` seam
// the drydock store uses, so `bun test` never touches a browser global.
//
// "auto" is a mode, not a tier: the store still resolves to a concrete tier at
// all times (`tier()`), the governor just gets to move it (`setAutoTier`).

import { kv, prefersReducedMotion } from "~/drydock/env";

export type QualityTier = "low" | "medium" | "high" | "ultra";
export type QualityMode = QualityTier | "auto";

/** Ascending cost order. Index arithmetic here is what `stepTier` walks. */
export const TIERS = ["low", "medium", "high", "ultra"] as const;
export const MODES = ["auto", ...TIERS] as const;

export interface QualitySettings {
  /** Ceiling on `devicePixelRatio` before `renderScale` is applied. */
  readonly dprCap: number;
  /** Multiplier on the backing-store size — the single biggest fill-rate lever. */
  readonly renderScale: number;
  /** Bloom chain resolution, or off entirely (composite then adds nothing). */
  readonly bloom: "off" | "quarter" | "half";
  /** How many H+V blur pairs the chain runs. 2 buys a wider, softer glow. */
  readonly blurPasses: number;
  /** Draw the engine plume cones (a whole extra instanced mesh pass). */
  readonly plumes: boolean;
  /** 0..1 share of the leftover rock budget shrapnel may fill. */
  readonly detail: number;
  /** Screen-shake multiplier; forced to 0 under prefers-reduced-motion. */
  readonly shake: number;
}

const SETTINGS: Record<QualityTier, QualitySettings> = {
  low: {
    dprCap: 1,
    renderScale: 0.7,
    bloom: "off",
    blurPasses: 1,
    plumes: false,
    detail: 0.3,
    shake: 0.6,
  },
  medium: {
    dprCap: 1.5,
    renderScale: 0.85,
    bloom: "quarter",
    blurPasses: 1,
    plumes: true,
    detail: 0.7,
    shake: 1,
  },
  high: {
    dprCap: 2,
    renderScale: 1,
    bloom: "half",
    blurPasses: 1,
    plumes: true,
    detail: 1,
    shake: 1,
  },
  ultra: {
    dprCap: 3,
    renderScale: 1,
    bloom: "half",
    blurPasses: 2,
    plumes: true,
    detail: 1,
    shake: 1,
  },
};

export const settingsFor = (tier: QualityTier): QualitySettings =>
  SETTINGS[tier];

/** Move `tier` one step along the cost order, clamped at both ends. */
export const stepTier = (tier: QualityTier, dir: 1 | -1): QualityTier => {
  const i = TIERS.indexOf(tier);
  return TIERS[Math.min(TIERS.length - 1, Math.max(0, i + dir))];
};

// --- Persistence -------------------------------------------------------------

const MODE_KEY = "ganymede.gfx.mode";

const isMode = (v: string | null): v is QualityMode =>
  v !== null && (MODES as readonly string[]).includes(v);

/** The saved mode, or "auto" when unset / corrupt / written by another build. */
export const loadMode = (): QualityMode => {
  const raw = kv.getItem(MODE_KEY);
  return isMode(raw) ? raw : "auto";
};

const saveMode = (mode: QualityMode) => {
  kv.setItem(MODE_KEY, mode);
};

// --- First-run guess ---------------------------------------------------------

/**
 * What the machine looks like from JS. Deliberately cheap signals only — a
 * startup benchmark would cost two seconds of first impression to learn what
 * the governor discovers in five anyway.
 */
export interface DeviceCaps {
  dpr: number;
  cores: number;
  /** Touch-first device: a phone/tablet GPU behind a very dense display. */
  coarsePointer: boolean;
}

export const detectCaps = (): DeviceCaps => ({
  dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
  cores:
    typeof navigator === "object" ? (navigator.hardwareConcurrency ?? 4) : 4,
  coarsePointer:
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
});

/**
 * The tier to open on. Never guesses "ultra" — that one is earned by the
 * governor after the frame budget proves it can be spent.
 */
export const guessTier = (caps: DeviceCaps): QualityTier => {
  if (caps.coarsePointer) return caps.cores >= 6 ? "medium" : "low";
  if (caps.cores <= 4) return caps.dpr > 1.5 ? "low" : "medium";
  return caps.cores >= 8 ? "high" : "medium";
};

// --- Store -------------------------------------------------------------------

export interface QualityStore {
  /** What the player picked: a fixed tier, or "auto". */
  mode(): QualityMode;
  /** The tier actually in force right now. */
  tier(): QualityTier;
  settings(): QualitySettings;
  /** Player-facing. Persists; leaving "auto" freezes the governor. */
  setMode(mode: QualityMode): void;
  /** Governor-only. Ignored unless the mode is "auto"; never persisted. */
  setAutoTier(tier: QualityTier): void;
  /** Fires on any effective-tier change. Returns an unsubscribe. */
  subscribe(cb: () => void): () => void;
}

export const createQualityStore = (
  initialAuto: QualityTier = "high",
  reduceMotion: boolean = prefersReducedMotion(),
): QualityStore => {
  let mode = loadMode();
  let autoTier = initialAuto;
  const subs = new Set<() => void>();
  const tier = (): QualityTier => (mode === "auto" ? autoTier : mode);

  const emit = (before: QualityTier) => {
    if (tier() === before) return;
    for (const cb of subs) cb();
  };

  return {
    mode: () => mode,
    tier,
    settings: () => {
      const s = settingsFor(tier());
      return reduceMotion ? { ...s, shake: 0 } : s;
    },
    setMode: (next) => {
      if (next === mode) return;
      const before = tier();
      mode = next;
      saveMode(next);
      emit(before);
    },
    setAutoTier: (next) => {
      if (mode !== "auto" || next === autoTier) return;
      const before = tier();
      autoTier = next;
      emit(before);
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
};
