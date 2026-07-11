# conway-machine — Context

A deterministic **roguelike autobattler** rendered with raw WebGPU. The sim is a
pure Elm-style state transition; the renderer is a hybrid 2D-sprite + 3D-mesh
pass. (The repo began as a Game-of-Life computer — see `docs/adr/0001`; that
lineage survives only in `src/components` + `test/`, not in the game under
`src/web`.)

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
  + cohesion + wander + pursuit/kite + objective-seeking, each weight gated by
  rank.
- **Bolt** (`Bullet`): an auto-aimed weapon projectile. **Mine**: an L3+ dropped
  proximity charge. **Shrapnel** (`Projectile`): fragments from a shattered rock.
- **Asteroid**: a drifting 3D hazard with hp; shatters into shrapnel.
- **Pickup**: a power-up bubble (heal / shield / speed). **Heal pad**, **Portal**,
  **Team base**: fixed field furniture.
- **Burst**: a transient FX event (explosion / detonation / muzzle / impact).
- **Instance**: one packed record in a GPU instance buffer (a sprite, a 3D rock,
  a shield). Each **instance layout** is the field schema for one pass.
- **Pass**: one GPU draw stage (background, sprites, 3D rocks, shields).

## Conventions

- Randomness is threaded as a `Seed` through the model — never `Math.random` in
  the sim. Determinism is load-bearing (roguelike replay).
- `@onrails` (`result` / `maybe` / `pattern`) models error modes, nullables, and
  exhaustive dispatch as values — used at trust boundaries (GPU/asset init) and
  for genuine nullables (e.g. nearest-enemy lookup), not pervasively.
