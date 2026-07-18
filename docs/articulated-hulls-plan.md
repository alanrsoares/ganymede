# Articulated Hulls — Implementation Plan

Goal: the serpent-shaped hulls (scout "Lamprey", interceptor "Stinger") swim —
an anguilliform lateral wave runs down the body, the head stays stiff, the
tail whips, and the whole spine leans into turns. Heavy classes barely flex.
Purely cosmetic and render-side: the sim, the baked meshes, and drydock
picking are untouched.

## Approach in one paragraph

Hulls are authored nose-along **+Y** within ±1.1 (`src/hull/catalog.ts`
conventions comment), so `localPos.y` *is* the spine coordinate — no skeleton
or skinning needed. The deformation is a pure function `spineOffset(y)`
applied in `ship.wgsl`'s vertex stage: a travelling sine wave (amplitude
enveloped to zero at the head) plus a parabolic lean driven by turn rate.
All parameters ride per-instance, so the game and the drydock tune them the
same way with no pipeline rebuilds. Engine plumes follow the tail because
their nozzle offsets are packed CPU-side each frame — a TypeScript mirror of
the same function shifts the anchor before packing.

## The deformation function

Reference implementation (WGSL and TS must match):

```
// y        : spine coordinate (ship-local, nose +Y, body ≈ [-1.1, +1.1])
// phase    : temporal wave phase (per ship, advances with time)
// curve    : turn lean, signed (per ship, from turn residual)
// amp      : lateral wave amplitude at full envelope (per hull)
// freq     : spatial frequency along the spine (per hull)
// headStiff: y above which the body is rigid (per hull, e.g. 0.4)
// segLen   : 0 = smooth wave; > 0 = rigid hinged segments of this length

fn spineY(y, segLen)   = segLen > 0 ? (floor(y / segLen) + 0.5) * segLen : y
fn envelope(y, headStiff) = smoothstep(headStiff, -1.1, y)   // 0 at head, 1 at tail
fn spineOffset(y, ...) =
    let yq = spineY(y, segLen)
    let env = envelope(yq, headStiff)
    let wave = sin(yq * freq - phase) * amp * env
    let d = headStiff - yq
    let lean = curve * d * d * step(yq, headStiff)  // parabolic lean aft of the stiff head
    return wave + lean                               // lateral (x) displacement
```

Analytic slope for the normal fix (derivative of the above w.r.t. y; for the
hinge mode evaluate it at `yq` so a whole segment shares one rotation):

```
fn spineSlope(y, ...) = cos(yq * freq - phase) * amp * freq * env - 2.0 * curve * d
```

In the vertex shader, before the instance transform:

```wgsl
let s  = spineOffset(in.pos.y, ...);
let sl = spineSlope(in.pos.y, ...);
var lp = in.pos;  lp.x += s;
// small-angle Rz(atan(sl)) applied to the normal:
var ln = normalize(vec3f(in.nrm.x - sl * in.nrm.y, in.nrm.y + sl * in.nrm.x, in.nrm.z));
```

Flat shading is forgiving; the small-angle normal rotation is sufficient.
Note `out.localPos` (used by the emissive pulse in `fs`) should keep the
**undeformed** `in.pos` — the pulse is authored against rest-pose y.

`segLen > 0` gives the hinged-carapace variant: each rigid segment takes one
offset + one normal rotation, plates shear against each other at the joints.
The hull design language overlaps masses deeply along the spine
(`catalog.ts` comment, line ~59), so the joints stay visually sealed.

## Parameter plumbing — everything per-instance

`SHIP_LAYOUT` (`src/render/overlay/frame.ts:54`) currently has two spare
floats (`_a`, `_b`) and grows by one vec4:

```ts
export const SHIP_LAYOUT = instanceLayout([
  "cx", "cy", "radius", "roll",
  "heading", "tilt", "wavePhase", "bendCurve",   // _a, _b claimed
  "amp", "freq", "headStiff", "segLen",          // NEW vec4 → @location(2)
  "r", "g", "b", "alpha",                        // shifts to @location(3)
]);
```

Rules that make this safe:

- `instanceLayout` derives the vertex attributes from the field count, so the
  new row appears automatically; **the WGSL `VSIn` struct must list the same
  rows in the same order** (`frame.ts` header comment). In `ship.wgsl` the
  colour input moves from `@location(2)` to `@location(3)`; mesh vertex
  attributes are parked at locations 6–8 so nothing else collides.
- The drydock keeps its own copy of `SHIP_LAYOUT` in `src/drydock/scene.ts:46`
  — extend it identically (it shares `ship.wgsl` with the game).
- Field order within the rows above is deliberate: dynamic per-frame values
  (phase, curve) sit in the old spare slots; static per-hull tuning fills the
  new row. Memory cost is 16 floats × `MAX_MESH_SHIPS`(16) — nothing.

No pipeline `override` constants, no shader templating, no rebuild on slider
drag: a hull's articulation values are just instance data.

## Catalog: the serializable articulation block

In `src/hull/catalog.ts` (pure data, no geometry — keep it that way):

```ts
/** Spine articulation — cosmetic vertex-shader deformation, render-only. */
export interface ArticulationDef {
  amp: number;       // lateral wave amplitude in ship-local units (0 = rigid)
  freq: number;      // spatial frequency along the spine
  speed: number;     // temporal wave rate multiplier
  headStiff: number; // y above which the hull is rigid
  segLen: number;    // 0 = smooth; > 0 = hinged rigid segments
}

export const ARTICULATION: Record<ShipClass, ArticulationDef> = {
  scout:       { amp: 0.10, freq: 3.5, speed: 1.0, headStiff: 0.4,  segLen: 0 },
  interceptor: { amp: 0.06, freq: 4.5, speed: 1.3, headStiff: 0.55, segLen: 0 },
  fighter:     { amp: 0.03, freq: 3.0, speed: 0.8, headStiff: 0.3,  segLen: 0 },
  heavy:       { amp: 0.015, freq: 2.0, speed: 0.4, headStiff: 0.2, segLen: 0 },
};
```

Starting values above are guesses — tune in the drydock, then export back
into the catalog (existing clipboard round-trip workflow).

New file `src/hull/articulation.ts` — the TypeScript mirror of
`spineOffset` (needed by the plume packer, and unit-testable):

```ts
export const spineOffset = (
  y: number, phase: number, curve: number, a: ArticulationDef,
): number => { /* exact same formula as the WGSL */ };
```

Keep the WGSL and TS implementations textually adjacent in review; a comment
in each pointing at the other ("mirror of …, keep in sync").

## Game-side packing (`src/render/overlay/ships.ts`)

`computeShipVisual` (line ~58) already computes the wrapped turn residual for
banking. Extend `ShipVisual` with:

- `wavePhase = now * 0.004 * art.speed + cycle.id * 1.7` — stateless and
  deterministic from `now` + id, same pattern as the smoke/trail effects.
  Do **not** scale the phase rate by speed (rate changes cause phase jumps);
  modulate the *amplitude* by drive instead.
- `bendCurve = clamp(-turn * BEND_GAIN, -BEND_MAX, BEND_MAX)` — negated like
  `roll` (line ~82) because the heading negation x-mirrors the hull and flips
  handedness. Suggested `BEND_GAIN ≈ 0.5`, `BEND_MAX ≈ 0.35`.

`packShipHull` (line ~300) writes the new fields: phase and curve from the
visual; `amp * (0.4 + 0.6 * drive)` where `drive` is the same speed-normalised
factor `packShipPlumes` uses (recompute or hoist it into `ShipVisual`);
`freq`/`headStiff`/`segLen` straight from `ARTICULATION[cls]`. A drifting
ship (`fuel <= 0`) gets `amp * 0.25` — a slow dying ripple instead of a
confident swim.

`packShipPlumes` (line ~125): before writing `nx`, add
`spineOffset(eng.pos[1], wavePhase, bendCurve, art)` (with the same
drive-scaled amp) to `eng.pos[0]`. `plume.wgsl` is untouched — the nozzle
offset is per-frame CPU data. The plume cone still points straight aft while
the tail sways; acceptable at game scale (optional later polish: rotate the
cone by `spineSlope` at the nozzle).

## Drydock

`src/drydock/store.ts`:

- `HullDef` gains `articulation: ArticulationDef`. `stockHull` clones it from
  `ARTICULATION[cls]`. `loadHulls` backfills a missing block with stock so
  existing `drydock-hulls-v1` localStorage saves keep working — do not bump
  the store key.
- `exportHull` / `importHull` include the block (import falls back to stock
  when absent — old clipboard payloads stay valid).
- Slider edits call `touchHull()` as usual. The re-bake it triggers is
  redundant (articulation doesn't change the mesh) but harmless; don't add a
  special path unless the 80 ms debounce visibly fights the sliders.

`src/drydock/scene.ts`:

- Extend the local `SHIP_LAYOUT` copy identically.
- Swarm ships already carry `phase` and `turn` — map them onto `wavePhase`
  (advance with `view.t`) and `bendCurve`, and pack
  `hulls[cls].articulation` into the new row.
- Inspector ship: articulate normally, **except force `amp = 0` when
  `view.design` is on**. Click-picking inverts the rest pose
  (`pickPart` in `hull/bake.ts` and the Mat3 inverse in scene.ts), and the
  highlight overlay is baked at rest pose — freezing the wave in design mode
  keeps clicks and highlights exact with zero extra code. `view.paused`
  should also freeze the phase (reduced-motion users get it by default).
- Plume anchors in the drydock preview: same CPU-side `spineOffset` shift as
  the game packer.

`src/drydock/ui/`: one slider group in the design panel — amp (0–0.3),
freq (1–8), speed (0–3), headStiff (−0.5–0.9), segLen (0 / 0.15–0.6, where 0
is "smooth"). Follow the existing part-slider component patterns.

## Untouched, by design

- `src/hull/bake.ts` — meshes stay static and instanced; rest pose is the
  single source of truth for baking and picking.
- `plume.wgsl`, `PLUME_LAYOUT` — anchor shift happens CPU-side.
- Sim (`world/`, `engine/`) — no state, no determinism impact. Everything is
  derived from `now`, ship id, and existing velocity/heading fields.

## Suggested commit order

1. `src/hull/catalog.ts` + `src/hull/articulation.ts` + unit tests —
   `ArticulationDef`, `ARTICULATION`, TS `spineOffset`.
2. `ship.wgsl` + `SHIP_LAYOUT` (both copies) + `packShipHull` — hulls swim in
   game. Verify all four classes render (colour location shift is the risky
   edit; a wrong `@location` fails loudly at pipeline creation).
3. `packShipPlumes` anchor follow.
4. Drydock: store block + scene packing + design-mode freeze + sliders.
5. Tune stock values in drydock, export, paste into `ARTICULATION`.

## Tests & acceptance

- `bun test`: `spineOffset` returns 0 for any y ≥ headStiff when curve = 0;
  envelope reaches full amp at y = −1.1; segLen > 0 yields identical offsets
  for two y values inside one segment; `ARTICULATION` covers `SHIP_CLASSES`.
- Manual, game (`bun --hot src/server.ts` or existing script): lamprey swims
  while cruising, wave amplitude visibly drops when it slows, spine leans
  through turns in the same direction it banks, plumes ride the tail tip,
  heavy barely moves. Cloaked and drifting ships still deform coherently.
- Manual, drydock (`/drydock`): sliders live-update the swarm; design mode
  shows a rigid hull and part-clicks select accurately; export → import
  round-trips the articulation block; a pre-change localStorage save loads.
