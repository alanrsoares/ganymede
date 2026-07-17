---
name: hull-design
description: Authoring grammar for Ganymede's procedural 3D ship hulls (ship-parts.ts part recipes, palette semantics, drydock workflow). Use when creating or editing hull recipes, adding primitive kinds, tuning engine anchors, or making ships read better on screen.
---

# Hull Design

How to author and edit the procedural ship hulls. The part grammar in
`src/ship-parts.ts` is the asset pipeline — hulls are plain serializable data,
not imported meshes. Never replace this with static glTF/OBJ assets: that kills
the drydock designer, per-part palette recolor, emissive baking, and the
kilobyte-scale footprint.

## File map

| File | Role |
|---|---|
| `src/ship-parts.ts` | Prim builders, `PartDef` grammar, `PALETTE`, hull `RECIPES`, `ENGINES` anchors, `assembleShipMesh`, `pickPart` |
| `src/shaders/ship.wgsl` | Instanced hull shading: key light + spec + rim, team tint, emissive bloom |
| `src/mesh-pass.ts` | Generic instanced mesh pass (9 floats/vertex: pos, normal, rgb) |
| `src/drydock/` | Hull designer tool — served at `/drydock` (run `bun src/server.ts`) |
| `src/drydock/store.ts` | Designer state: working copies in localStorage, export/import JSON clipboard round-trip |

## Coordinate conventions

- Ship local space: **nose along +Y**, +Z toward viewer. Author within roughly
  ±1.1 along Y so instance `radius` ≈ half-length in pixels.
- Rotations are Euler radians applied **Rz·Ry·Rx**. Use the `deg()` helper.
- In-game the camera is top-down with a fixed tilt; heading rotates in the
  screen plane, roll banks about +Y.

## Part grammar

A hull is `PartDef[]`. Each part:

```ts
{ prim: PrimDef, scale: V3, rot?: V3, pos: V3, color: PaletteKey, mirror?: boolean }
```

`mirror: true` also bakes an x-negated copy (position and rotation mirrored).

Prims (`PrimDef`):

- `{ kind: "slab", tx, tz }` — tapered box along Y: base quad at y=−0.5,
  nose quad at y=+0.5 scaled by (tx, tz). `tx=tz=1` is a box; near-zero tapers
  to a spike. The workhorse: hull masses, plates, fins, fangs.
- `{ kind: "hex", taper }` — tapered hex prism along Y: engine polyps, barrels,
  pods, eye stalks.
- `{ kind: "orb" }` — subdivided octahedron sphere (r=0.5): eyes, sacs.

### The convexity contract

Every prim MUST be convex. Normals are not authored: `assembleShipMesh` gives
each face a flat normal flipped to point **away from the part's centre**
(`outwardNormal`). A concave prim gets wrong-facing normals and shades inside
out. If you add a new prim kind, keep it convex (or convex enough that
centre-outward normals hold), and:

1. Extend the `PrimDef` union + `buildPrim` switch in `ship-parts.ts`.
2. Add a default in `defaultPrim` (`src/drydock/store.ts`) and parameter
   fields in `src/drydock/ui/PartControls.tsx` so the designer can edit it.
3. Old localStorage hulls (`drydock-hulls-v1`) won't have the new kind — fine;
   loader falls back per-class only when data is missing, not per-prim.

## Palette semantics

`PALETTE` keys are meaning, not just color. Team tint multiplies on top in
`ship.wgsl` (near-white multiply, k=0.55), so parts keep their material read
while soaking team hue. Components **> 1.0 mark emissive** — the shader lets
them bloom.

| Key | Material | Use |
|---|---|---|
| `bone` | pale structural | primary masses, spines |
| `carapace` | void purple | shells, wings, plates |
| `sinew` | dark connective | stalks, engine polyps, joins |
| `fang` | pale ivory | spikes, barbs, teeth |
| `acid` | **emissive** portal green | engine nozzles, mine sacs |
| `eye` | **emissive** magenta | the cyclopean eye — one per hull |
| `maw` | near-black | mouths, intakes, negative space |

## Art direction

Cosmic-horror-meets-acid-cartoon: bone carapace masses, fang spikes, glowing
polyps, one cyclopean eye per hull. Current hulls: scout "Lamprey", fighter
"Ossuary", heavy "Leviathan" (doubles as carrier bulk), interceptor "Stinger".

Rules that keep hulls readable:

- **Silhouette first.** In-game ships are tiny (`SHIP_LEVEL_SIZES` 4.5–9.2 px
  radius). Aspect ratio carries the tiny-scale read: dart / cross / slab /
  needle per class. Verify silhouette at gameplay scale in the drydock swarm
  view before polishing.
- **Greebles second.** Detail (barbs, pods, vents) sells role up close in the
  inspector and ship cards; it must not muddy the silhouette.
- **Deliberate asymmetry.** A couple of parts per hull are intentionally NOT
  mirrored — eldritch things are never quite symmetric. Keep at least one.
- **One eye.** Every hull gets exactly one emissive `eye` orb, usually
  off-centre. It watches.

## Engine anchors

`ENGINES[cls]` lists nozzle exits (`{ pos, w }`) for the plume pass. Mirrored
nozzle parts need **both** anchors listed explicitly (the plume pass has no
mirror logic). When you move or add an `acid` nozzle part, update its anchor to
match — desync reads as flames from bare hull.

## Workflow

1. `bun src/server.ts` → open `/drydock`. Edits live in localStorage working
   copies, debounce-rebaked (80 ms) into the live mesh.
2. Inspector (left): drag to orbit, click a part to select. Designer panel
   edits prim params, scale/rot/pos, palette, mirror. One-deep undo
   (undo twice = redo). Swarm (right) shows true gameplay scale + two rocks.
3. **Export** copies `{ parts, engines }` JSON to clipboard — valid TS literal.
   Paste over the recipe in `src/ship-parts.ts` to make it stock. Import does
   the reverse.
4. Toggle `mono` to check shape without palette; toggle `bank` to check roll.

Gates before shipping recipe changes: `bunx tsc --noEmit`, `bunx biome check`,
`bun test`. Recipes are data — no sim determinism impact — but keep them
formatted (biome will reflow pasted JSON).

For evaluating a hull's quality, use the `hull-critique` skill.
