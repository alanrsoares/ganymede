# Architecture Deepening — Strong Findings Plan

Goal: land the three **Strong** candidates from the 2026-07-23 architecture
review — delete the dead whip module, move the offer-freeze invariant inside
the sim's interface, and deepen the augment stack behind a **pilot-mods read
model**. The aim is depth: more behaviour behind smaller interfaces, tested
through those interfaces.

Landing shape: **one branch, three ordered commits** (each phase = one
commit). Coverage never drops — existing per-augment end-to-end tests stay as
the migration net; new unit tests land beside them. Drop this doc once all
phases ship (repo convention).

## Status

| Phase | Commit | Status |
|---|---|---|
| 1 — delete whip module | `refactor(world): delete dead whip module` | ☑ |
| 2 — offer-freeze guard in sim | `fix(arcade): enforce offer freeze inside update` | ☑ |
| 3 — pilot-mods read model | `refactor(arcade): deepen augments behind pilotMods read model` | ☐ |

## Decisions (grilled 2026-07-23)

1. Whip: **delete outright** — design survives in `docs/melee-combat-plan.md`
   + git; a returning melee weapon would likely land as an augment anyway.
2. `pilotMods`: **pure derived** function in `augments.ts`; no stored block on
   `ArcadeState` (derive, don't store — determinism is load-bearing).
3. Block scope: **full** — six stat multipliers + `fanBarrels`, `novaRank`,
   `wingSize`. `augCount` disappears from tick sites.
4. UI join: **type-link only** — `augmentOffer.tsx` colour map becomes
   `Record<AugmentStat, …>` with `satisfies`; paint stays in `ui/`.
5. Freeze scope: **tick + actions** — `update()` no-ops `"tick"` and
   `"action"` while `arcade.offer !== null`; `pickAugment` and
   world-replacing msgs pass. `main.ts` freeze predicate stays,
   presentation-only.

---

## Phase 1 — delete the whip module

`WHIP_ENABLED = false` (`tuning.ts:650`), gated out of every input path, yet
the module runs every tick and its pool rides every `World`. Deletion test
passes: complexity vanishes, nothing reappears.

Remove:

- `src/world/tick/whips.ts` (243) — whole module.
- `src/render/overlay/whips.ts` (99) — whole module; unwire from
  `overlay/index.ts` build.
- `types.ts` — `Whip` type, `World.whips` pool (and its `init.ts` seeding).
- `tick/index.ts:39` — `resolveWhips` phase.
- `motion.ts:313` — `advanceWhips`.
- `finalize.ts:119` — whip pool commit.
- `update.ts` — whip action handler + its `Msg`/action-id arm.
- `tuning.ts` — `WHIP_ENABLED` + adjacent whip constants.
- `runtime/input.ts:122`, `ui/mobileControls.tsx:306` — flag gates.
- `test/whip.test.ts`.

Sweep: `grep -ri whip src test` must return zero hits (except
`docs/melee-combat-plan.md`). Check `FrameInstances`/sprite pusher for whip
rows; check `web-sim.test.ts` for `whips` pool assertions and drop them.

Done when: grep clean, `bun test` green, typecheck green.

## Phase 2 — offer-freeze guard inside `update`

The invariant "a pending offer freezes the World" is currently enforced by
the caller (`main.ts:150,263`); the sim only refuses to muster the next wave
(`tick/arcade.ts:154`). Any caller that ticks anyway keeps the fight running
under the frozen dialog.

- `update.ts`: while `world.arcade?.offer != null`, return `world` unchanged
  for `"tick"` and `"action"` msgs. `pickAugment`, restart/init, and other
  world-replacing msgs pass. Keep the `arcade.ts:154` muster refusal
  (defense in depth, zero cost).
- `main.ts` freeze predicate untouched — it now only skips wasted work.
- New `test/arcade-offer-freeze.test.ts`: with an offer pending, `tick` and
  `action` msgs are identity; `pickAugment` clears the offer and the next
  tick advances; generation counter proves no drift.

Done when: the new test is the *only* thing that pins the freeze — deleting
the `main.ts` predicate would change perf, not correctness.

## Phase 3 — pilot-mods read model

Augment behaviour currently lives at ~11 `augMul`/`augCount` read sites
across 5 files; hp/shield bake at 3 sites; `augmentOffer.tsx` re-encodes the
stat taxonomy untyped. Deepen `augments.ts` so one interface answers "what
does augment X do" — the same move `statsFor` made for ship stats.

New interface in `augments.ts`:

```ts
export interface PilotMods {
  hpMul: number; shieldMul: number; cooldownMul: number; // floored ≥ MIN_COOLDOWN_MUL
  damageMul: number; regenMul: number; speedMul: number;
  fanBarrels: number; novaRank: number; wingSize: number;
}
export const pilotMods = (stacks: AugmentStacks): PilotMods => …
/** Multiply-and-round base caps by the block — the one hp/shield bake rule. */
export const bakeCaps = (mods: PilotMods, caps: { maxHp: number; maxShield: number }) => …
```

Migrate read sites (each becomes a named-field read):

- `tick/context.ts`: stash `mods: PilotMods` on `TickCtx` at `createTickCtx`
  (once per tick); `promote` (`:300`) → `bakeCaps`.
- `update.ts:623` `pickAugment` → `bakeCaps`; `:444` nova → `mods.novaRank`.
- `tick/arcade.ts:74-77` `spawnAt` → `bakeCaps`; `:248` → `mods.wingSize`.
- `tick/motion.ts:126,159` → `mods.speedMul` / `mods.regenMul`.
- `interactions/weapons.ts:118,289` → `mods.damageMul` / `mods.cooldownMul`;
  `:149` → `mods.fanBarrels`.
- `ui/augmentOffer.tsx` — colour map typed
  `Record<AugmentStat, …> satisfies`, `AugmentStat` imported.

`augMul`/`augCount` stay exported (existing tests import them) but no
production call site outside `augments.ts` remains.

Tests: extend `test/arcade-augments.test.ts` with `pilotMods` block units —
compounding per stack, cooldown floor through the block, fan/nova/wing
counts, `bakeCaps` rounding; per-augment end-to-end tests
(`arcade-augment-{fan,nova,wing,flow}`) unchanged and green throughout.

Side effect (domain model): add **Pilot mods** to `CONTEXT.md` glossary —
"derived per-run stat block `pilotMods(stacks)`; the sim's one answer to
'what does the augment stack do to the pilot'."

Done when: `grep -rn "augMul\|augCount" src --include='*.ts' --include='*.tsx' | grep -v world/augments.ts` returns
zero, all tests green, new units in place, `CONTEXT.md` updated.

## Acceptance (whole branch)

- `bun test` green after every phase, not just at the end.
- Typecheck/lint via the repo's own scripts.
- `web-sim.test.ts` determinism suite untouched by phases 2–3 (phase 1 may
  edit it only to drop whip-pool references).
- No new World state anywhere; `World` shape shrinks (whips gone), never grows.
