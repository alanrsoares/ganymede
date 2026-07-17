# Architecture Refactor Plan — Folder Structure & Bounded Contexts

From 2026-07-18 architecture review. Goal: every context named as folder, each seam carry single explicit interface. Vocabulary: *module / interface / seam / adapter / depth / locality* (review glossary); domain terms from `CONTEXT.md`.

Ordered by dependency — each phase independently shippable, leave game green (`bun run check && bun test`).

---

## Phase 1 — Name the contexts (Strong)

Fold ~20 loose files at `src` root into contexts. Zero behaviour change; pure file moves + import rewrites via `~/*` alias.

**Moves**

| From (src root) | To |
| --- | --- |
| `gpu.ts`, `gpu-context.ts`, `mesh.ts`, `mesh-pass.ts`, `sprites.ts` | `src/render/` |
| `overlay.ts` + `overlay/*` | `src/render/overlay/` (`overlay.ts` → `overlay/index.ts`) |
| `ui.ts`, `setup.ts`, `welcome.ts`, `codex.ts`, `shipCard.ts`, `shipInfo.ts`, `dialog.ts`, `a11y.ts`, `arcade-lobby.ts`, `mixer.ts`, `mobileControls.ts` | `src/ui/` |
| `main.ts`, `server.ts`, `index.html`, `drydock.html`, `styles.css`, `astryx-theme.css`, `globals.d.ts` | stay at root (bootstrap only) |
| `ship-parts.ts` | stay at root for now — move in Phase 4 |

**Steps**

1. `git mv` render cluster; rewrite imports to `~/render/...`.
2. `git mv` UI cluster; rewrite imports to `~/ui/...`.
3. Normalize mixed `~/x` vs `../x` import styles to `~/` while touching each file.
4. Update `index.html` / `drydock.html` script paths if any reference moved files.

**Acceptance**: `bun run check && bun test` green; game and `/drydock` boot; `src` root contain only bootstrap + `ship-parts.ts`.

---

## Phase 2 — Deepen the frame handoff: `FrameInstances` (Strong)

Overlay → renderer seam now cross as 16 positional args (`gpu.ts:161-179` pre-move); instance-layout constants live in `gpu.ts` but authored for `overlay` benefit. Replace with one value object.

**Steps**

1. Define `FrameInstances` in `render/overlay/` — ~14 typed arrays plus counts, named fields. Move `MAX_*` caps and `*_LAYOUT` constants into overlay module (describe projection, not GPU pipeline).
2. `overlay.build(world): FrameInstances`.
3. `renderer.render(frame: FrameInstances, camera, ...)` — renderer read named fields; layout imports flip direction (gpu ← overlay).
4. Add `test/frame-instances.test.ts`: tick seeded World N times, assert instance counts, buffer packing, ordering invariants (e.g. "portals first") on value — no GPUDevice needed.

**Acceptance**: `Renderer.render` take one frame value; projection covered by bun:test; hypothetical new entity type touch only overlay module + one renderer read site.

---

## Phase 3 — Invert the sprites dependency (Worth exploring)

Deterministic sim import presentation constants — only leak across `world/` seam:

- `world/tuning.ts:1` — `durationOf`, `EXPLOSION_CLIPS`
- `world/factory.ts:13` — `ASTEROID_VARIANTS`
- `world/tick/finalize.ts:3` — `EXPLOSION_VARIANTS`

**Steps**

1. Move gameplay-gating constants (variant counts, clip durations used by Tick) into `world/tuning.ts` as plain numbers.
2. `render/sprites.ts` import them, derive/validate clip tables against them (assert clip length match tuning duration at module init).
3. Remove all `sprites` imports from `world/`.

**Acceptance**: `grep -r "sprites" src/world/` return nothing; determinism tests unchanged; spritesheet swap cannot change sim behaviour.

---

## Phase 4 — Name the Hull Catalog: `src/hull/` (Worth exploring)

`ship-parts.ts` (919 lines) most cross-context module — game renderer and drydock = two adapters over it, so real seam. Give it name, split data from baking.

**Steps**

1. Create `src/hull/`:
   - `catalog.ts` — `RECIPES`, `ENGINES`, `SHIP_CLASSES`, part/prim types; serializable data drydock edit.
   - `bake.ts` — `makeShipMesh`, `makePlumeMesh`; recipe → `Mesh`.
2. Rewrite importers: game render (`render/gpu.ts`, `render/overlay/ships.ts`) mostly need `bake`; drydock (`keys`, `store`, `scene`, `ui/*`) mostly need `catalog`.
3. Split `test/ship-parts.test.ts` same way; catalog serialization tests run without touching mesh code.

**Note**: this = "core" module agreed drydock → React + core direction need — do before extracting drydock further.

**Acceptance**: no module named `ship-parts` remain; drydock import `bake` only in `scene.ts`; catalog round-trip (edit → serialize → re-bake) covered by tests.

---

## Phase 5 — Ship-stats read model (Speculative — grill before building)

Seven UI modules import stat helpers (`carriesMissiles`, `speedForLevel`, `ARCHETYPE_MODS`, …) straight from `world/factory.ts`, whose interface serve both spawning (Tick) and display (HUD).

**Gate**: design conversation first — risk = renames without depth. Settle: read model own formatting or numbers only? `shipInfo.ts` merge into it? Codex need sim-accurate derivations or display approximations?

**Sketch**: `ui/shipStats.ts` — one interface answering "what HUD say about Ship of rank N / archetype A"; factory public surface narrow back to spawning.

---

## Sequencing & verification

```
Phase 1  ──►  Phase 2  ──►  Phase 4
   │
   └────►  Phase 3          Phase 5 (gated on design grilling)
```

- One PR per phase. Each PR: `bun run check && bun test`, boot `/` and `/drydock` manually (renderer no headless test until Phase 2 land).
- Phases 3, 4 independent of Phase 2; either can land parallel after Phase 1.
- Out of scope, on purpose: `gpgpu/` stay isolated spike (deliberate); drydock mini-renderer in `scene.ts` stay until React + core extraction scheduled.