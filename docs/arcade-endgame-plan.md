# Arcade Endgame — Long-Horizon Progression Plan

Goal: make an arcade run **keep getting more powerful as it gets harder**, so a
skilled player can push well past wave 17–18 instead of hitting a wall. Add a
per-run **augment stack** (permanent accumulating upgrades that survive death),
four new power expressions — **cone projectiles**, an **AoE cone special**,
**special summons**, and **prestige ranks past L5** — and fix the `MAX_SHIPS`
field-cap cliff that turns the late game into an unwinnable saturated screen.

Keep the pure, data-driven shape: knobs in `tuning.ts`, sim logic in
`world/tick/*`, arcade-only state on `World.arcade`. Enemies are untouched
(still cap at L5); all new power is **player-side**, so the redesign is additive
and can't regress autobattle.

## Status — all phases shipped (branch `feat/arcade-endgame`)

| Phase | Status | Commit |
|---|---|---|
| 0 — field-cap fix (trickle waves, guard pilot, no phantom kills) | ✅ DONE | `793c308` |
| 1a — augment stack sim core | ✅ DONE | `7ae74e6` |
| 1b — offer dialog + freeze + prestige HUD | ✅ DONE | `2ece2f1` |
| 2 — cone projectiles (Spread) | ✅ DONE | `66627ae` |
| 3 — Nova AoE cone blast (R) | ✅ DONE | `55c5ed5` |
| 4 — persistent escort wing (Wing) | ✅ DONE | `93af845` |
| 5 — prestige capstones + offer weighting | ✅ DONE | `b0a93b1` |

Remaining is playtest/balance-by-feel against the open tuning knobs below.

## Current state — where the wall comes from

Measured map of the live arcade balance (Normal difficulty, Fighter hull, 52
gen/s). Three player-side plateaus collide against one unbounded enemy lever:

| Thing | Caps at | Source |
|---|---|---|
| Player level | **L5** | `MAX_LEVEL=5` (`world/types.ts:20`) — 6 HP, 5 shield, 38-gen cooldown, 1.6 bolt dmg. Frozen after. |
| Enemy level | wave 12 | `levelCap(w,3)` reaches 5 → every enemy can roll up to L5 (`tuning.ts:761`) |
| Handicap (the catch-up lever) | **wave 9** | `arcadeHandicap` wave term maxes at `min(w-1,8)` → h=1.40, then frozen (`tuning.ts:315`) |
| Enemy **count** | never | `spawn(w).count = 1+floor(w*0.75)` climbs every wave (`tuning.ts:770-804`) |

**The felt wall is the field cap.** `MAX_SHIPS=12` (`tuning.ts:15`);
`finalizeTick` trims the ship list to 12 with `cap()`, which drops the **oldest**
ships (`engine/entities.ts:41-47`, `finalize.ts:146`). On Normal, `count+pilot`:

```
w=12: 11   (enemies now up to L5)
w=14: 12   ← field exactly saturated
w=15: 13   ← spawn EXCEEDS cap
w=17: 14   ← 2 enemies trimmed every tick
w=18: 15   ← 3 trimmed
```

From ~wave 15 the requested wave no longer fits; by 17–18 you face a
permanently full screen of ~11 mostly-L5 enemies with no gaps, while your power
has been frozen since wave 9–12. Same cliff hits other tiers at easy ~w19, hard
~w10, endless ~w7.

**No permanent accumulation exists.** The only permanent gain is pickup kind 5
(promote), itself capped at L5. Pickups (`tick/interactions/pickups.ts`) grant
*timed* buffs (boost/overcharge/cloak/force-field) that don't survive death.
Power ceiling is hard; pressure is unbounded. That gap is the wall.

### Two latent cap bugs (fix regardless)

The `cap()` = drop-oldest interaction with the wave machine is fragile:

1. **Phantom kills.** `advanceWave` computes
   `kills += max(0, waveRemaining - enemyCount)` (`tick/arcade.ts:130`), but
   cap-trimmed enemies vanish uncounted → they read as kills and can
   auto-advance a wave that was never cleared.
2. **Pilot eviction.** A clean-run pilot still at array index 0 (never died) can
   be trimmed by `cap()` → `playerAlive` reads it as death (`arcade.ts:98-100`)
   → `loseLife`. Position-dependent and only "safe" after the first respawn
   appends the pilot last.

## Design pillars

1. **Accumulation, not a higher ceiling.** The primary fix is a stacking augment
   system layered *on top* of L5 as multipliers — unbounded, survives death, no
   enemy-side table edits. (gameplay-mechanics: *catch-up mechanics for late
   content*, *add more reward sources*.)
2. **Relieve field pressure, then scale power.** Raising player power is moot if
   the field saturates and the cap evicts the pilot. Fix the cap first.
3. **Choices, not a single ramp.** Augments are *offered as a choice* at each
   wave clear (pick 1 of 3), so runs diverge and no single line dominates.
   (gameplay-mechanics: *avoid one dominant strategy — situational counters,
   rock-paper-scissors*.)
4. **Curve: early-fast, late-slow.** Early augments feel huge; later ones are
   incremental (%-multipliers), so power keeps climbing without trivialising.
5. **Player-side only.** Enemies stay capped at L5. Everything here is additive
   to the pilot — autobattle is never touched.

## Locked decisions

| # | Topic | Choice |
|---|--------|--------|
| 1 | Accumulation vehicle | **Augment stack** on `World.arcade` — permanent, survives respawn |
| 2 | How augments are earned | **Wave-clear offer**: pick 1 of 3 rolled augments (reuses the unimplemented intermission slot) |
| 3 | Progression past L5 | **Augment ranks**, not a higher `MAX_LEVEL` — L5 stays the hull cap; augments scale on top |
| 4 | Cone projectile | New `WEAPON_PROFILE` kind `fan` (shotgun spread), unlocked by a Spread augment |
| 5 | AoE cone attack | New action key = forward-arc **nova**; unlocked by a Cone-Blast augment |
| 6 | Special summons | Persistent escort wing that **accumulates** count/level across the run; extends existing drone infra |
| 7 | Field cap | **Separate enemy cap from total**; guard `cap()` so the pilot + summons are never evicted; fix phantom kills |
| 8 | Enemy changes | **None** — enemies untouched; all new power is player-side |
| 9 | Autobattle | **Unaffected** — arcade-only branches, gated on `world.arcade` |

## Core system — the augment stack

### State

Add to the arcade block on `World` (`world/types.ts`, arcade-only, ignored in
autobattle):

```ts
readonly arcade: {
  // ...existing lives/wave/waveRemaining/phase...
  augments: Readonly<Record<AugmentId, number>>;  // id → stack count
  offer: readonly AugmentId[] | null;             // 3 rolled at wave clear, null while fighting
}
```

`AugmentId` is a string-union of augment kinds (below). `augments` is a plain
tally — pure, serialisable, trivially reset on new run. It rides through
`loseLife`/respawn untouched, so **power persists across death** (the key
missing lever).

### Where augments apply

Augments are **derived-stat multipliers**, folded into the existing per-level
stat functions in `tuning.ts` so there is one application choke point per stat —
mirrors how `ARCHETYPE_MODS` already multiply level stats (`tuning.ts:474`):

```ts
// Existing: maxHpFor = round(maxHpForLevel(level) * mod.hp)
// New:      maxHpFor = round(maxHpForLevel(level) * mod.hp * augMul(aug, "hp"))
```

`augMul(augments, stat)` returns the product of every owning augment's
per-stack multiplier. Because it's a multiplier on the L5 baseline, stacks are
**unbounded** and compounding — power keeps rising every wave you clear. Applied
in the derived fns for HP, shield, bolt damage, fire cooldown, regen, speed; and
as flags/counts for the unlock augments (fan, nova, summons).

The pilot reads its own `world.arcade.augments` in the tick (the pilot ship is
`controlledShipId` on the player team), so the multipliers only ever touch the
player — enemies never see `augMul`.

### The augment catalogue (initial)

| Id | Kind | Effect per stack | Cap behaviour |
|---|---|---|---|
| `hull` | stat | maxHP ×1.18 | unbounded, compounding |
| `plating` | stat | shield ×1.15 | unbounded |
| `overclock` | stat | fire cooldown ×0.92 | floored at a min cadence |
| `caliber` | stat | bolt damage ×1.15 | unbounded |
| `nanofoam` | stat | regen +50% | unbounded |
| `thrusters` | stat | speed ×1.08 | soft-capped (handling) |
| `spread` | unlock | bolt weapon → `fan` (+1 barrel/stack, wider arc) | stacks add barrels |
| `nova` | unlock | grants/º widens the AoE cone special | stacks widen arc + dmg |
| `wing` | summon | +1 persistent escort drone (respawns) | stacks add drones, then level them |

Rolling: at each wave clear, roll 3 distinct ids weighted so early offers favour
the big-feel unlocks (spread/nova/wing) and stat augments fill later. Duplicate
offers of an owned augment are allowed (that's how you stack).

### gameplay-mechanics feedback layers

| Layer | Augment implementation |
|-------|------------------------|
| Immediate (0–100ms) | Augment-pick card highlight + confirm sound; new-barrel muzzle flash; nova whoosh |
| Short-term (100ms–1s) | Stat pips tick up on the HUD; summon drones fly in |
| Long-term (1s+) | Visible run power-curve — clearing further because you're compounding |

## Feature specs

### A. Cone projectiles — `fan` weapon profile

New entry in `WEAPON_PROFILES` (`tuning.ts:247`). Where `parallel` fires N
barrels abreast, `fan` fires N barrels across an **angular spread** (a shotgun
cone). `spread` augment stacks: 1→3 barrels over ±18°, each stack +1 barrel and
+6° arc. Fire path: `fireWeapon` (`tick/interactions/weapons.ts:231`) already
loops barrels — extend the profile switch to distribute barrels over angle
instead of lateral offset. Reuses `Bullet` spawning wholesale; damage per pellet
scaled so total DPS climbs sub-linearly with barrel count (no single-target
one-shot). gameplay-mechanics balance: a spread build trades range/precision for
field-clear — situational counter to the saturated screen, not a strict upgrade.

### B. AoE cone attack — forward nova

New action id (bind an unused key; `4-7` are self-buffs, so use a fresh key or
repurpose `q`, currently the disabled whip). `handleNova` in the action dispatch
(`update.ts:373` `dispatchAction`): emits a **forward arc blast** hitting every
enemy inside a cone (angle from aim, radius/arc from `nova` stacks) through the
one `hit()` choke point (`tick/context.ts:162`) — same resolution as ram
shockwave / EMP, so armor/shield/cloak rules are respected for free. Fuel-gated
(like the other specials) with a cooldown so it's a *clear button*, not spam.
This is the **direct counter to the wave-17 swarm** — one well-aimed nova thins
a saturated front. Stacks widen the arc toward a full 360° panic-nova at high
investment.

### C. Special summons — persistent escort wing

Extend the existing muster/escort-drone infra (`MUSTER_DRONE_COUNT`, orbiting
escort drones in `pickups.ts`) from *timed* to *persistent*. `wing` augment:
each stack adds a permanent escort that **respawns** after death on a cooldown,
orbits/screens the pilot, and auto-fires nearest enemy. Beyond a count cap,
further stacks **level the wing** (drones fire faster / tougher) so investment
never wastes. Summons live on the player team, count toward the *player* soft
budget only (see cap fix) and are guarded from `cap()` eviction. gameplay-
mechanics economy: summons are passive DPS + soak — the "steady late-game
progress" band on the power curve.

### D. Prestige past L5

No change to `MAX_LEVEL`. "Past L5" is expressed entirely through compounding
stat augments (§core). HUD shows an **augment tier** (e.g. sum of stat stacks)
as a prestige readout — "L5 · Mk III" — so the player *sees* unbounded growth
without a second level integer to balance against enemies. Optional later:
capstone augments that only roll after N total augments (build-defining, e.g.
"every 5th bolt pierces").

## Field-cap fix (must-fix, do first)

Blocking the whole redesign. Three targeted changes:

1. **Separate enemy cap from total.** Introduce `MAX_ENEMY_SHIPS` for the
   wave-spawn budget; keep `MAX_SHIPS` as the hard array ceiling but raise it so
   pilot + summons + enemies fit (e.g. enemies capped ~10, total ~16). Wave
   spawn (`spawnWave`, `arcade.ts:69`) clamps to `MAX_ENEMY_SHIPS` and holds the
   remainder as `waveRemaining` to trickle in as enemies die — so late waves
   stay dense but bounded, never overflowing the array.
2. **Guard `cap()` against evicting protected ships.** `finalize.ts:146` — never
   trim the pilot (`controlledShipId`) or player-team summons. Trim oldest
   *enemy* instead. Kills the pilot-eviction false-death.
3. **Fix phantom kills.** `advanceWave` (`arcade.ts:130`) must count only real
   deaths, not array shrinkage — track kills at the `hit()`/death site, not by
   diffing `waveRemaining - enemyCount`.

gameplay-mechanics: this converts the wave-15+ *overflow* into controlled
*density* — the screen stays threatening but the sim stops silently eating
ships and mis-advancing waves.

## Execution plan (phased)

### Phase 0 — Field-cap fix (unblocks everything)

- `MAX_ENEMY_SHIPS` + raise `MAX_SHIPS`; clamp wave spawn, trickle remainder
- Guard `cap()`: never evict pilot / player summons
- Fix phantom-kill wave advance (count real deaths)

**Verify:** headless run to wave 20 — pilot never false-dies to the cap; waves
advance only on real clears; enemy density bounded, no array thrash.

### Phase 1 — Augment stack core (the accumulation lever)

- `augments`/`offer` on `World.arcade`; `AugmentId` union + catalogue
- `augMul()` folded into derived stat fns (hull/plating/overclock/caliber/
  nanofoam/thrusters)
- Wave-clear offer: roll 3, pick 1 → apply; survives `loseLife`
- HUD: owned augments + prestige tier readout; wave-clear pick card (reuse the
  React dialog chrome — `ui/dialog.tsx`)

**Verify:** clear waves → offered 3 → pick stacks → stats visibly compound;
death keeps the stack; headless run past wave 18 on Normal is winnable.

### Phase 2 — Cone projectiles (`fan`)

- `fan` `WEAPON_PROFILE`; `spread` augment wires barrels→angle in `fireWeapon`
- DPS scaled sub-linear per pellet

**Verify:** spread build fires a visible cone; total DPS climbs but no
single-target one-shot; field-clear feel confirmed.

### Phase 3 — AoE cone nova

- `handleNova` action + key bind; fuel + cooldown gate
- `nova` augment widens arc/dmg; resolves through `hit()`

**Verify:** nova thins a saturated front; respects shield/armor/cloak; cooldown
prevents spam.

### Phase 4 — Special summons

- `wing` augment: persistent escorts, respawn on cooldown, cap→level scaling
- Guarded from `cap()`; count toward player budget only

**Verify:** wing accumulates across a run, respawns after death, and measurably
extends reachable wave.

### Phase 5 — Prestige polish

- Augment-tier HUD readout ("L5 · Mk N"); offer weighting curve tuned
- Optional capstone augments gated on total-augment count

**Verify:** power readout reads clearly; offers feel like choices, not a single
ramp; playtest to a satisfying deep-wave ceiling.

## Open tuning knobs (playtest)

- Per-stack multipliers (`hull` 1.18, `caliber` 1.15, `overclock` 0.92, …) and
  the overclock cadence floor
- Offer weights (early big-feel vs late stat-fill) and reroll rules
- `MAX_ENEMY_SHIPS` vs `MAX_SHIPS` split; enemy-trickle rate
- Nova arc/radius/dmg per `nova` stack; fuel cost + cooldown
- `wing` count cap before it switches to levelling; respawn cooldown
- Whether prestige needs a visible second integer or the tier readout suffices
- Re-tune / retire `arcadeHandicap` once augments carry the catch-up load (its
  wave-9 freeze may become redundant or need lowering to avoid double-dipping)

## Risks / notes

- **Double catch-up.** Augments + the existing `arcadeHandicap` could over-
  correct. Measure headless; likely reduce or gate the handicap once augments
  land (last knob above).
- **Dominant build.** If one augment line (e.g. `caliber` stacking) trivialises,
  add situational counters or diminishing returns per stack (gameplay-mechanics
  anti-dominant-strategy).
- **Cap fix is load-bearing.** Every later phase assumes the pilot/summons can't
  be evicted and waves advance only on real kills — Phase 0 must land and be
  headless-verified before power scaling goes in.
