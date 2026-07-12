# Ship Melee Combat — Gaps & Execution Plan

Goal: turn ship combat from raw-stat brawling into an Age-of-Empires-style
counter web (rock-paper-scissors classes, melee vs ranged roles, surround
tactics). Keep the pure, data-driven sim shape: knobs live in `tuning.ts`,
logic in `steering.ts`, `tick/ship-collisions.ts`, and `math.ts`.

## Current state

- 4 archetypes (`scout`, `fighter`, `heavy`, `interceptor`) differ by raw stat
  multipliers only — `ARCHETYPE_MODS` in `tuning.ts:233` (speed/hp/fire/fuel/
  mines/missiles/fuelShare/recon).
- Melee (`dogfight`, `tick/ship-collisions.ts:107`) trades a **flat 1 damage**
  each on contact, regardless of class, level, or matchup.
- Ranged bolts do flat `BULLET_DAMAGE`; missiles (interceptor L4+), mines
  (heavy L3+).
- Focus-fire exists (weakest-hp, tiebreak nearest) via `acquireTarget`
  (`factory.ts:334`) → `focusEnemy` — but only for **ranged** targeting.
- Steering (`flockSteer`, `steering.ts:524`): separation, align, cohesion,
  pursuit (per-level kite band), objective, pickup, heal, center-pad, wander,
  rally.

## Gaps (vs AoE melee-machine strategy)

| # | Gap | Evidence | Strategic cost |
|---|-----|----------|----------------|
| G1 | **No counter-web.** Archetypes differ by stats, no class-beats-class bonus | `ARCHETYPE_MODS` tuning.ts:233 | Best raw-stat class dominates all |
| G2 | **Melee dmg hardcoded `1`.** Ram trades 1-for-1, no scaling | `dogfight` ship-collisions.ts:107 | Heavy tank rams same as scout; melee is noise |
| G3 | **No armor / damage-type split.** hp+shield only; bolt and ram both flat-subtract | `applyHit` (math.ts) | Can't build "melee bruiser soaks arrows" |
| G4 | **Cohesion = blob, not concave.** Squad drifts to center-of-mass; pursuit bores straight in | `steerAlignCohere` steering.ts:117, `steerPursuit`:170 | Ships stack; few reach enemy front |
| G5 | **Focus-fire ranged-only; melee incidental.** dogfight is proximity, not chosen | `acquireTarget` factory.ts:334; dogfight has no target pick | Melee ships don't gang the wounded |
| G6 | **Kite band per-level, not per-role.** Ranged + melee both kite at high rank | `KITE_DIST` tuning.ts:125, `steerPursuit` | Melee ship holds standoff instead of committing |
| G7 | **No trade-awareness.** Ships engage any nearest enemy regardless of matchup | `nearestEnemyOffset` steering.ts:143 | Scout rams heavy and dies |

## Execution plan (phased, each independently playable)

### Phase 1 — Counter-web + melee damage (core; G1, G2)

Class beats class; ram damage means something.

1. `tuning.ts`: extend `ARCHETYPE_MODS` with:
   - `meleeDmg: number` — base ram damage (heavy high, scout low).
   - `counters: Archetype` — class this one gets a bonus vs. RPS loop e.g.
     scout→interceptor→heavy→fighter→scout.
   Add `MELEE_COUNTER_MULT = 1.75` and helper
   `meleeDamage(attacker, defender)` = `meleeDmg × (counters===defender ? MULT : 1) × levelScale`.
2. `ship-collisions.ts` `dogfight`: replace `hit(ctx,a,1)` /`hit(ctx,b,1)` with
   `meleeDamage(b,a)` / `meleeDamage(a,b)`. Keep `HIT_COOLDOWN` i-frames.
3. Optional: apply the same `counters` bonus to `BULLET_DAMAGE` in `spawnBullet`
   (`factory.ts:344`) — one multiplier at spawn.

**Verify:** 4-team match; counter class wins even-numbers fights. Tune `MULT`
toward the 0.8–1.2 trade-ratio target.

### Phase 2 — Armor / damage-type (G3; the tank identity) — DONE

Melee bruisers soak ranged; the pierce/melee split.

Implemented: `DamageType = "melee" | "pierce"` (types.ts); `ARCHETYPE_MODS` gained
`pierceArmor` alongside `meleeResist` (heavy 0.45/0.5 = the tank, scout 0/0). All
damage now routes through one choke point — `hit(ctx, s, amt, type)` in
context.ts applies `armorFor(archetype, type)` before shield→hull spill.
`meleeDamage` dropped its resist factor (moved to `hit`). Melee/physical sites
(dogfight, force-field, rock/shrapnel/base rams) tagged `"melee"`; ranged
(bolts, missiles, mines, EMP) default `"pierce"`. Verified: heavy takes 0.55 per
bolt vs scout's 1.0; melee numbers unchanged (centralization behavior-preserving).
Known balance knob: heavy also soaks missiles (1.1 from raw 2), softening
interceptor's counter — revisit in a balance pass if it reads too tanky.

Original spec:

1. `tuning.ts` `ARCHETYPE_MODS`: add `meleeArmor` + `pierceArmor` (0–0.6).
   Heavy = high pierce (eats bolts), low melee. Scout ≈ 0.
2. `math.ts` `applyHit`: take `damageType: "melee" | "pierce"`; reduce by
   `dmg × (1 - armor[type])` before hp/shield. Thread from `dogfight` (melee),
   bullets/missiles/mines (pierce), force-field (melee).
3. Effective-HP becomes the real front-line stat — heavies tank arrows, get
   chewed by melee counter. Completes the RPS.

**Verify:** heavy vs interceptor (ranged role) — heavy walks through bolts,
dies to a countering meleer.

### Phase 3 — Roles: commit vs kite (G6, G7)

Melee closes, ranged kites, nobody suicides into a bad trade.

1. `tuning.ts`: replace scalar `KITE_DIST[level]` with
   `kiteDistFor(archetype, level)` — melee classes → `0` (bore in), ranged →
   current standoff. One-line change in `steerPursuit` (steering.ts:170).
2. `nearestEnemyOffset`: weight candidate `d2` by matchup — divide by
   `counters===enemy ? favorBonus : 1` so ships prefer targets they counter and
   soft-avoid targets that counter them. Pure, no new state.

**Verify:** interceptors kite while heavies close; scouts stop diving heavies.

### Phase 4 — Concave + melee focus (G4, G5; the "machine" flourish) — DONE

Squad surrounds instead of stacks; melee gangs the wounded.

Implemented (steering.ts): `pickFoe(self, ships, rangeSq, focus)` replaces the
nearest-only picker. `wantsFocus(self)` = rammer OR L≥COORDINATE_MIN_LEVEL → the
ship pursues the *weakest* enemy in range (tiebreak nearest), matching the
fire-target policy, so a squad piles onto one wounded target (emergent, no shared
state). `steerPursuit` gained a **concave** term: a pressing ship drifts
perpendicular to its approach, split to opposite flanks by ship-id parity
(`CONCAVE_GAIN`), fading to a straight ram inside `CONCAVE_COMMIT_DIST` so it
still connects. `COORDINATE_MIN_LEVEL` moved factory→tuning (steering can't import
factory: circular). Verified: focus mode picks weakest, nearest mode picks
closest; tsc + 41 tests + lint green. Visual arc/gang-up wants a WebGPU playtest.

Original spec:

1. **Melee focus:** in `steerPursuit`, for melee classes aim at `acquireTarget`
   (weakest) result instead of geometric nearest — reuse the existing focus-fire
   policy so allies converge; emergent gang-up, no shared state.
2. **Concave:** add a tangential component to pursuit — steer toward
   `perp(toEnemy)` offset by ship-id parity, so squadmates spread onto an arc
   around the target rather than a column. New `CONCAVE_GAIN` in tuning; damp
   with existing `COMBAT_FLOCK_DAMP`.

**Verify:** a squad wraps the enemy front; more ships in contact at once.

## Follow-on — per-archetype projectiles — DONE

Each class fires differently (tuning.ts `WEAPON_PROFILES` + `weaponFor`;
interactions.ts `fireWeapon` → `spawnSalvo` / `applyFireCadence`; new ship field
`burstCount`):
- scout — single bolt, fastest cadence (harasser).
- fighter — twin parallel barrels (balanced gunner).
- heavy — 3-barrel wing volley abreast (wide hull), slowest cadence.
- interceptor — 3-shot burst then a reload beat.
Leveling raises range (`bulletLifeFor`: +13%/level bolt lifetime) and frequency
(existing `fireCooldownForLevel`). `spawnBullet` gained a `lateral` offset for
wing mounts. Verified via a real single-ship tick per archetype: bolt counts,
parallel pairing/tripling, and the burst `6,6,<reload>` rhythm all confirmed.

## Sequencing rationale

- P1 + P2 give the RPS spine — biggest gameplay delta, smallest code.
- P3 makes the AI actually use it.
- P4 is polish/spectacle — skip if P1–3 already read well.

Each phase = one balance-iteration cycle (playtest → adjust one variable →
retest), targeting the 0.8–1.2 income/expenditure (here: kill-trade) ratio.
