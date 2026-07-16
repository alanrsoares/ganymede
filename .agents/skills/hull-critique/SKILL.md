---
name: hull-critique
description: Review checklist for Ganymede procedural ship hulls — silhouette, palette, shading, and in-game readability. Use when critiquing a hull recipe, reviewing drydock exports, or deciding whether a redesign actually improved the ship.
---

# Hull Critique

Structured review for hull recipes (`src/ship-parts.ts` / drydock exports).
Judge at both scales the game renders: the tiny top-down sprite-scale swarm
and the close-up (drydock inspector, ship cards). A hull that only works
zoomed-in is a failed hull.

## How to review

Load the recipe in drydock (`/drydock`), or read the `PartDef[]` directly —
the grammar is legible enough to critique from source (see `hull-design` for
conventions). Score each section, worst finding first. Every finding names the
offending part index and a concrete fix.

## 1. Silhouette (tiny scale — the one that matters)

- [ ] Class read: does the aspect ratio alone say scout-dart / fighter-cross /
      heavy-slab / interceptor-needle? Squint test: shrink to ~10 px.
- [ ] Distinct from the other three classes at 10 px — overlap means one of
      them loses.
- [ ] Nose obvious: can you tell heading at a glance? (Nose is +Y; taper or
      maw should point it.)
- [ ] No silhouette mush: greebles that protrude past the main mass blur the
      outline. Tuck them or fatten the mass.

## 2. Boxiness

The historical failure mode. A hull reads "boxy" when:

- [ ] Slab-dominant with `tx`/`tz` near 1 (untapered = literal box). Want
      taper, angled `rot`, or overlapping offset masses breaking the prism.
- [ ] All edges parallel to axes — no part rotated off-grid.
- [ ] Uniform part sizes — no big-medium-small rhythm.

## 3. Palette + emissives

- [ ] Exactly one `eye` (emissive magenta), off-centre preferred.
- [ ] `acid` only where light sources make sense (nozzles, sacs); every
      nozzle part has a matching `ENGINES` anchor (mirrored pairs = two
      anchors).
- [ ] Material logic: `bone`/`carapace` masses, `sinew` joins, `fang` points,
      `maw` negative space. A fang-colored hull mass reads as noise.
- [ ] Check `mono` toggle: shape must survive without palette.

## 4. Art direction

- [ ] Cosmic-horror read: does it look grown/ossified, not manufactured?
      Nicknames are the bar — Lamprey, Ossuary, Leviathan, Stinger.
- [ ] At least one deliberately unmirrored part (eldritch asymmetry).
- [ ] Not over-symmetric, not random: asymmetry should look intentional
      (a lean, an off-centre eye), not like a mistake.

## 5. Technical

- [ ] All prims convex (centre-outward normal contract — see `hull-design`).
- [ ] Parts within ~±1.1 Y so `radius` ≈ half-length holds; oversized hulls
      lie about their hitbox (`shipRadius` in the sim is untouched by visuals).
- [ ] Part count sane: enough for close-up interest (~10–20 with greebles),
      not so many the instanced bake bloats for detail nobody sees.
- [ ] Banking check: toggle `bank` in drydock — thin flat hulls vanish
      edge-on at full roll.

## Verdict format

```
verdict: ship / rework / reject
silhouette: <pass/fail + one line>
worst finding: <part index, problem, fix>
findings: <ordered list, each with part index + concrete fix>
```

Critique backlog lives with drydock — findings that aren't fixed now are real
work items, not throwaway notes; record them in the PR or an issue.
