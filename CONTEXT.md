# Ganymede — Context

A deterministic **roguelike autobattler** rendered with raw WebGPU. The sim is a
pure Elm-style state transition; the renderer is a hybrid 2D-sprite + 3D-mesh
pass. (The repo began as a Game-of-Life computer — see `docs/adr/0001`, now
superseded; that lineage has been removed. All live code lives under `src`.)

## Domain glossary

- **World**: the immutable game state — all entity pools, the PRNG seed, the
  per-team score, and the generation counter. Advanced only by `update`.
- **Tick**: one `update({kind:"tick"}, world)` step; advances the sim by N
  generations. Pure and deterministic (seeded), so runs are replayable.
- **Ship** (`LightCycle`): a team unit. Has level (rank 1–5), hp, shield, mines,
  velocity/heading, and timers (fire, hit-flash, i-frames, boost, portal).
- **Team**: a color-identified faction. Ships of a team flock, merge, and share a
  score.
- **Rank / level**: a ship's tier (1–5). Drives stats *and* AI depth — higher
  ranks steer, hunt, kite, and seek objectives more capably (L1 is a brawler).
- **Steering** (`flockSteer`): the per-ship acceleration = separation + alignment
  + cohesion + wander + pursuit/kite + player rally + objective-seeking, each
  weight gated by rank.
- **Bolt** (`Bullet`): an auto-aimed weapon projectile. **Mine**: an L3+ dropped
  proximity charge. **Shrapnel** (`Projectile`): fragments from a shattered rock.
- **Asteroid**: a drifting 3D hazard with hp; shatters into shrapnel.
- **Pickup**: a power-up bubble (heal / shield / speed). **Heal pad**, **Portal**,
  **Team base**: fixed field furniture.
- **Rally beacon**: a short-lived player command. Right-click / shift-click
  places a team-tinted beacon for the nearest living team; ships with enough
  fuel prioritize it before ordinary base-raid objectives.
- **Burst**: a transient FX event (explosion / detonation / muzzle / impact).
- **Instance**: one packed record in a GPU instance buffer (a sprite, a 3D rock,
  a shield). Each **instance layout** is the field schema for one pass.
- **FrameInstances**: one frame's packed instance arrays + counts — the single
  value the overlay hands the renderer. Built purely from the World (plus
  `now`), so the whole projection is testable without a GPUDevice.
- **Pass**: one GPU draw stage (background, sprites, 3D rocks, shields).
- **Pilot mods** (`world/augments.ts`, `pilotMods`): the derived per-run stat
  block — the sim's one answer to "what does the augment stack do to the
  pilot". Six compounding multipliers (hp/shield/cooldown/damage/regen/speed)
  plus the unlock/summon counts (fan barrels, nova rank, wing size). Derived
  from `AugmentStacks` on demand, never stored on the World; `bakeCaps` is the
  one hp/shield bake rule (level table × block, rounded).
- **Ship stats** (`ui/shipStats.ts`, `statsFor`): the UI read model answering
  "what does the HUD say about a ship of archetype A at rank N" — stat gauge
  rows, trait chips, counter relations, flavor, and the tier ladder. Derived
  from the same tuning the sim spawns from, so the hover card and codex never
  drift from the sim (or each other).

## Conventions

- Randomness is threaded as a `Seed` through the model — never `Math.random` in
  the sim. Determinism is load-bearing (roguelike replay).
- Sudden death stops reinforcements and base self-repair; docks still refuel,
  rearm, and restore shields so ships can sortie, but damaged bases stay damaged.
- `@onrails` (`result` / `maybe` / `pattern`) models error modes, nullables, and
  exhaustive dispatch as values — used at trust boundaries (GPU/asset init) and
  for genuine nullables (e.g. nearest-enemy lookup), not pervasively.
