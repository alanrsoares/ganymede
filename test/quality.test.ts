// Graphics quality tiers: the settings table, the first-run guess, and the
// store's mode/tier split. All pure — no GPU, no DOM.

import { beforeEach, describe, expect, test } from "bun:test";
import { kv } from "~/drydock/env";
import {
  createQualityStore,
  guessTier,
  loadMode,
  type QualityTier,
  settingsFor,
  stepTier,
  TIERS,
} from "~/render/quality";

const MODE_KEY = "ganymede.gfx.mode";

beforeEach(() => {
  kv.setItem(MODE_KEY, "");
});

describe("settingsFor", () => {
  test("cost never decreases as the tier rises", () => {
    const cost = (t: QualityTier) => {
      const s = settingsFor(t);
      const bloom = { off: 0, quarter: 1, half: 2 }[s.bloom];
      return {
        pixels: Math.min(3, s.dprCap) * s.renderScale,
        bloom: bloom * s.blurPasses,
        detail: s.detail,
      };
    };
    for (let i = 1; i < TIERS.length; i++) {
      const lo = cost(TIERS[i - 1]);
      const hi = cost(TIERS[i]);
      expect(hi.pixels).toBeGreaterThanOrEqual(lo.pixels);
      expect(hi.bloom).toBeGreaterThanOrEqual(lo.bloom);
      expect(hi.detail).toBeGreaterThanOrEqual(lo.detail);
    }
  });

  test("low drops the whole bloom chain and the plume pass", () => {
    expect(settingsFor("low").bloom).toBe("off");
    expect(settingsFor("low").plumes).toBe(false);
  });

  test("detail stays a valid 0..1 budget everywhere", () => {
    for (const t of TIERS) {
      expect(settingsFor(t).detail).toBeGreaterThan(0);
      expect(settingsFor(t).detail).toBeLessThanOrEqual(1);
    }
  });
});

describe("stepTier", () => {
  test("walks the cost order and clamps at both ends", () => {
    expect(stepTier("low", 1)).toBe("medium");
    expect(stepTier("high", -1)).toBe("medium");
    expect(stepTier("low", -1)).toBe("low");
    expect(stepTier("ultra", 1)).toBe("ultra");
  });
});

describe("guessTier", () => {
  test("never opens on ultra — that tier is earned by the governor", () => {
    const caps = [
      { dpr: 1, cores: 2, coarsePointer: false },
      { dpr: 3, cores: 32, coarsePointer: false },
      { dpr: 3, cores: 8, coarsePointer: true },
    ];
    for (const c of caps) expect(guessTier(c)).not.toBe("ultra");
  });

  test("a weak touch device opens low, a strong desktop opens high", () => {
    expect(guessTier({ dpr: 3, cores: 4, coarsePointer: true })).toBe("low");
    expect(guessTier({ dpr: 2, cores: 8, coarsePointer: true })).toBe("medium");
    expect(guessTier({ dpr: 2, cores: 12, coarsePointer: false })).toBe("high");
    expect(guessTier({ dpr: 2, cores: 4, coarsePointer: false })).toBe("low");
  });
});

describe("loadMode", () => {
  test("a corrupt or foreign saved value falls back to auto", () => {
    kv.setItem(MODE_KEY, "cinematic");
    expect(loadMode()).toBe("auto");
  });

  test("round-trips a real mode", () => {
    createQualityStore("high").setMode("ultra");
    expect(loadMode()).toBe("ultra");
  });
});

describe("createQualityStore", () => {
  test("auto resolves to the seeded tier and the governor may move it", () => {
    const q = createQualityStore("medium");
    expect(q.mode()).toBe("auto");
    expect(q.tier()).toBe("medium");
    q.setAutoTier("high");
    expect(q.tier()).toBe("high");
    expect(q.mode()).toBe("auto");
  });

  test("a manual pick freezes the governor out", () => {
    const q = createQualityStore("medium");
    q.setMode("low");
    q.setAutoTier("ultra");
    expect(q.tier()).toBe("low");
  });

  test("subscribers fire on effective-tier changes only", () => {
    const q = createQualityStore("medium");
    let calls = 0;
    q.subscribe(() => calls++);
    q.setAutoTier("high");
    expect(calls).toBe(1);
    q.setAutoTier("high"); // same tier
    expect(calls).toBe(1);
    q.setMode("high"); // same effective tier, different mode
    expect(calls).toBe(1);
    q.setMode("low");
    expect(calls).toBe(2);
  });

  test("unsubscribing stops the callbacks", () => {
    const q = createQualityStore("medium");
    let calls = 0;
    const off = q.subscribe(() => calls++);
    off();
    q.setAutoTier("high");
    expect(calls).toBe(0);
  });

  test("prefers-reduced-motion zeroes shake without touching the tier", () => {
    const q = createQualityStore("high", true);
    expect(q.tier()).toBe("high");
    expect(q.settings().shake).toBe(0);
    expect(q.settings().bloom).toBe(settingsFor("high").bloom);
  });
});
