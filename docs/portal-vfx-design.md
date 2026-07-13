# Portal VFX — Rick & Morty Portal Gun Style

Goal: restyle the procedural portal vortex from a cyan/magenta accretion disk
into a **lime-green swirling void** reminiscent of the Rick & Morty portal gun —
acid green energy spiralling into a dark center, both gates sharing the same
palette (counter-rotation still distinguishes the pair).

## Current state

| Piece | Location | Today |
|-------|----------|-------|
| Vortex shader | `src/shaders/overlay.wgsl` (`in.shape > 8.5`) | Dark blue-black horizon; log-spiral arms heat to **white**; tint from instance color |
| Portal draw | `src/overlay/field.ts` `drawPortals` | Cyan gate + magenta gate; `SHAPE.vortex` + `SHAPE.ring` contour |
| Spin sign | `in.layer` on vortex instance | Gate 0 CW, gate 1 CCW |

The vortex is procedural — no texture asset. Changes are shader constants + tint
RGB in `drawPortals` only.

## Reference look (portal gun)

- **Dominant hue:** acid / chartreuse lime (`#39FF14` – `#ADFF2F` range).
- **Spiral:** thick, liquid-looking bands winding into the center — not a thin
  accretion-disk arm pattern.
- **Center:** near-black void with a hint of green (not blue space).
- **Edge:** bright lime rim glow; slight irregularity (organic ooze, not perfect
  geometry).
- **Motion:** steady rotation; bands appear to flow inward.
- **Uniform color:** both portals green (RM doesn't color-code entry vs exit).

## Design requirements

### D1 — Palette

| Role | RGB (linear, approx) | Notes |
|------|----------------------|-------|
| Arm / body | `(0.15, 0.95, 0.12)` | Primary lime |
| Highlight | `(0.55, 1.0, 0.25)` | Yellow-green hot bands |
| Rim / ring | `(0.25, 1.0, 0.18, 0.95)` | Contour in `drawPortals` |
| Void center | `(0.02, 0.06, 0.02)` | Dark green-black base |

Both gates use the **same** tint. Spin direction (existing `layer` sign) is enough
to tell them apart.

### D2 — Spiral pattern (shader)

Replace the thin white-hot accretion look with a **thicker, greener swirl**:

1. **More arms, tighter pitch** — e.g. `5–6` lobes, steeper log spiral
   (`8–10 * log(d)`).
2. **Thicker bands** — wider `smoothstep` on the swirl term so arms read as
   liquid ribbons, not hairline cracks.
3. **Remove white heat** — highlights mix toward yellow-green, not `vec3(1.0)`.
4. **Secondary spiral** — optional second `sin` term offset by `π/3` for depth /
   the "double helix" RM feel.
5. **Slight wobble** — low-amplitude `sin(theta * 2 + t * 0.7)` modulating arm
   width for organic irregularity.
6. **Faster spin** — `u.time * 1.8–2.2` (tune in playtest).

### D3 — Ring contour

Keep the existing `SHAPE.ring` frame; retint to lime. Optional: slightly faster
rotation (`now / 900`) so the frame feels energized.

### D4 — Non-goals (v1)

- No drip sprites or particle ooze (shader-only pass).
- No gameplay changes (portal positions, cooldown, teleport logic unchanged).
- No bloom pass changes — rely on existing composite bloom to pick up lime.

## Implementation sketch

### `src/overlay/field.ts`

```ts
const PORTAL_LIME: Rgba = [0.25, 1.0, 0.18, 0.95];
// Both gates → PORTAL_LIME for vortex + ring (drop per-gate cyan/magenta)
```

### `src/shaders/overlay.wgsl` (vortex branch)

```wgsl
// Pseudocode — tune constants in playtest
let swirl1 = sin(5.0 * theta + 9.0 * log(d + 0.04) - t);
let swirl2 = sin(5.0 * theta + 9.0 * log(d + 0.04) - t + 2.1); // offset helix
let arms = smoothstep(0.05, 0.85, swirl1) * 0.7 + smoothstep(0.1, 0.9, swirl2) * 0.5;
let wobble = 0.08 * sin(2.0 * theta + t * 0.7);
let hole = smoothstep(0.0, 0.5 + wobble, d);
let base = mix(vec3f(0.02, 0.06, 0.02), in.color.rgb * 0.35, hole);
let highlight = mix(in.color.rgb, vec3f(0.55, 1.0, 0.25), 1.0 - smoothstep(0.2, 0.65, d));
let rgb = base + highlight * arms * (0.4 + 0.6 * hole);
```

## Verify

- [ ] Both portals read lime green at a glance (screenshot / side-by-side with
      old cyan-magenta).
- [ ] Spiral visibly rotates and flows inward; no white-hot center flash.
- [ ] Counter-rotating pair still distinguishable by spin direction.
- [ ] Ships/rocks still draw **over** portals (draw order unchanged).
- [ ] Acceptable at reduced motion / low FPS (no extra texture samples).

## Tuning knobs

| Knob | Default | Effect |
|------|---------|--------|
| Arm count (`5.0 * theta`) | 5 | More/fewer spiral lobes |
| Log pitch (`9.0 * log`) | 9 | Tighter/looser wind-in |
| Spin speed (`1.2 * u.time`) | → 2.0 | Rotation rate |
| Band thickness (`smoothstep` edges) | see sketch | Ribbon vs hairline |
| Secondary helix weight | 0.5 | Depth / RM double-swirl |
