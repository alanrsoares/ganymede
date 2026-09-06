// The adaptive tier governor. It counts frames rather than reading a clock, so
// every case here is a deterministic run of literal frame deltas.

import { describe, expect, test } from "bun:test";
import {
  createGovernor,
  type Governor,
  type QualityVerdict,
} from "~/render/quality-governor";

/** Feed `n` frames of `ms` and return the first non-hold verdict, if any. */
const feed = (
  g: Governor,
  ms: number,
  n: number,
): { verdict: QualityVerdict; at: number } => {
  for (let i = 0; i < n; i++) {
    const v = g.sample(ms);
    if (v !== "hold") return { verdict: v, at: i };
  }
  return { verdict: "hold", at: n };
};

describe("createGovernor", () => {
  test("holds through the settle window even on terrible frames", () => {
    const g = createGovernor({ settleFrames: 45 });
    for (let i = 0; i < 45; i++) expect(g.sample(50)).toBe("hold");
  });

  test("sustained slow frames demote", () => {
    const g = createGovernor();
    expect(feed(g, 40, 400).verdict).toBe("down");
  });

  test("sustained fast frames promote", () => {
    const g = createGovernor();
    expect(feed(g, 8, 1000).verdict).toBe("up");
  });

  test("promoting is far more reluctant than demoting", () => {
    const down = feed(createGovernor(), 40, 2000).at;
    const up = feed(createGovernor(), 8, 2000).at;
    expect(up).toBeGreaterThan(down * 3);
  });

  test("frameMs reports the smoothed frame time once warm", () => {
    const g = createGovernor();
    expect(Number.isNaN(g.frameMs())).toBe(true);
    feed(g, 10, 200);
    expect(g.frameMs()).toBeCloseTo(10, 1);
  });

  test("zero and negative deltas are ignored", () => {
    const g = createGovernor();
    expect(g.sample(0)).toBe("hold");
    expect(g.sample(-5)).toBe("hold");
    expect(Number.isNaN(g.frameMs())).toBe(true);
  });
});

// The failure mode that actually matters: a tier that flaps is worse than one
// that is merely wrong.
describe("createGovernor stability", () => {
  test("a single hitch never demotes a healthy run", () => {
    const g = createGovernor();
    for (let i = 0; i < 200; i++) {
      const v = g.sample(i === 120 ? 900 : 8);
      expect(v).not.toBe("down");
    }
  });

  test("a burst of slow frames inside a fast run doesn't demote", () => {
    const g = createGovernor();
    feed(g, 8, 60); // warm up past the settle window
    for (let i = 0; i < 20; i++) expect(g.sample(30)).toBe("hold");
  });

  test("a verdict restarts the window, so it can't fire twice in a row", () => {
    const g = createGovernor();
    const first = feed(g, 40, 400);
    expect(first.verdict).toBe("down");
    for (let i = 0; i < 45; i++) expect(g.sample(40)).toBe("hold");
  });

  test("settle() from the outside resets the counters", () => {
    const g = createGovernor();
    feed(g, 40, 80); // part-way to a demotion
    g.settle();
    for (let i = 0; i < 45; i++) expect(g.sample(40)).toBe("hold");
  });

  test("a boundary machine converges: each undone promotion costs more", () => {
    const g = createGovernor();
    const cycle = () => {
      const up = feed(g, 8, 20000);
      expect(up.verdict).toBe("up");
      const down = feed(g, 40, 2000);
      expect(down.verdict).toBe("down");
      return up.at;
    };
    const first = cycle();
    const second = cycle();
    const third = cycle();
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});
