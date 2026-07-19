import { expect, test } from "bun:test";
import { SHIP_CLASSES } from "./catalog";
import { hullSilhouettePath } from "./silhouette";

// The pipeline (bake → project → rasterize → marching squares → RDP) is easy to
// silently break into an empty/degenerate path. One check: every class yields a
// closed, multi-point path whose coords sit inside the 24×24 viewBox.
test("every hull class produces a valid nose-up silhouette path", () => {
  for (const cls of SHIP_CLASSES) {
    const d = hullSilhouettePath(cls);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);

    const points = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    expect(points.length).toBeGreaterThanOrEqual(8); // ≥4 (x,y) pairs
    for (const n of points) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(24);
    }
  }
});
