# Ship Leveling — Paths & Balance Plan

Goal: make ranking up reward the *aggressive objective* (base-raid), not safe
farming. Aggression stays balanced by survival (fuel/heal) and the leveling
goal — leveling should not itself be a free sustain button. Keep the pure,
data-driven shape: knobs in `tuning.ts`, promotion logic in `tick/context.ts`.

## Current state — level-up triggers

| path | how | character |
|---|---|---|
| Rock XP (`awardXp`, context.ts) | shoot asteroids, +1 XP each; thresholds `XP_TO_LEVEL=[4,6,9,13]` auto-promote | safe PvE farm, no combat |
| Base-raid + center (`finishAtCenterPad`, interactions.ts) | hit every alive enemy base `level`× then cross center pad → promote, reset tally | aggressive, contested — the intended objective |
| Rank-up pickup (kind 5, interactions.ts) | grab bubble → instant level | luck bonus |
| ~~docked promote~~ | `BASE_LEVELUP_CHANCE` | DEAD — defined + commented, never wired |

Per-level curves (`tuning.ts`): hp `1+lvl`×mult, shield `1→5`, speed `0.65→2.0`,
fire cadence `90→38`, bolt range `+13%/lvl`, fuel tank `+25%/lvl`, radius
`5.5→12.5` (bigger hitbox = only downside), mines L3+, missiles L4+, carrier
leech L3+, squad focus/concave L3+, `baseHitsRequired=level`. **Promote fully
refills hp + shield + mines.**

## Problems

1. **Rock-farm undercuts aggression.** A ship ranks to L5 plinking rocks in a
   corner, never fighting — the safe path out-values the contested objective.
2. **Promote = free full heal.** Every level tops off hp/shield → leveling is a
   panic-heal button; sustain without risk.
3. **Rich-get-richer runaway.** Every stat rises; only counterweight (bigger
   hitbox) is subtle. L5 stomps L1, no catch-up.
4. **Dead `BASE_LEVELUP_CHANCE`** — cruft from a dropped camp-to-promote idea.

## Plan (phased)

### P1 — cap rock-XP leveling (DONE)

Rock XP is a catch-up trickle, not a solo carry. `XP_LEVEL_CAP = 3` in tuning;
`awardXp` stops promoting at the cap (XP still banks but can't cross it). Ranks
past mid **require** the aggressive raid path. One-line guard.

### P2 — gate the promote-heal (DONE)

`promote(ctx, s, { heal })`. The full hp/shield/mines refill happens only when
`heal` is true; caps (`maxHp`/`maxShield`/`maxMines`) always update. Raid-path
(`finishAtCenterPad`) and the rank-up pickup keep the heal (reward reaching the
contested center / a lucky grab). Rock-XP promotes with `heal: false` — the hull
grows its cap but is *not* topped off, so farming no longer sustains.

### P4 — delete dead knob (DONE)

Remove `BASE_LEVELUP_CHANCE` from tuning.

### FIX — leveling economy: kills grant XP (DONE)

**Bug found:** XP was awarded *only* on rock shatter (`projectiles.ts`). Every
ship-kill site credited `SCORE_KILL` but never `awardXp` — killing enemies gave
zero XP. With 5 rocks on the field and 4 XP to reach L2, leveling stalled; even
L2 was rare. Kills were never a leveling path.

**Fix:** combat damage now banks XP through the one `hit()` choke point.

- `hit(ctx, s, amt, type, attackerId?)` gained `attackerId`. When a ship dealt
  the damage (bolt/missile/blast/ram/force-field aura), it banks XP for the
  *effective damage landed*, pro-rata over the victim's HP+shield pool
  (`awardCombatXp` in context.ts). A solo kill ≈ the full matrix value; a shared
  kill splits by contribution; **chip-and-retreat still banks its slice**
  (partial-kill XP). Environmental hits (rocks, self-ram) pass no attacker → no XP.
- **Level-delta matrix** (`killXp(killerLevel, victimLevel)`, tuning.ts): kill XP
  scales with the rank gap, so leveling rewards punching up and starves the
  snowball — a veteran farming rookies floors at `XP_KILL_MIN=1`, an upset pays up
  to `XP_KILL_MAX=8`. This is the **economic half of P3 anti-runaway**.
- Kill/damage XP is **uncapped** (ranks to L5 — earned combat is the aggressive
  path); rock XP stays the L3-capped, non-healing catch-up trickle. XP promotes
  never heal (only center-pad finish / rank-up pickup do).

Verified: matrix values, and pro-rata XP accrual through `hit()` on a real chip
sequence. tsc + 41 tests + lint green.

### FIX — leveling was still too rare: economy retune (DONE)

Headless measurement (level histogram over full matches) exposed the real
problem: **peak level reached was L3, never L4/L5**, and at peak population every
ship sat at L1–L2. Two causes + fixes:

- **Base strafing gave zero XP** — yet it's the core loop. Added `BASE_RAID_XP`
  (1/hit) in `creditBaseHit`; **rammer base-slams now also credit the raid**
  (`shipVsBase` → `creditBaseHit`), fixing a latent gap where a pure-rammer could
  never complete the raid objective. Uncapped, non-healing.
- **Thresholds too steep for the kill rate.** `XP_TO_LEVEL` `[4,6,9,13]` →
  `[3,6,10,15]`.

Re-measured to a healthy curve: early game L1–L2 (fast hook), mid game L3–L4,
L5 reached in **all 12 test matches** but hard-fought. Data-driven, not guessed.

### P3 — anti-runaway, tactical half (DONE)

`targetPriority(ship) = level × TARGET_VETERAN_BOUNTY − hp` (tuning.ts), shared by
`focusEnemy` (factory) and `pickFoe` (steering). Focus-fire now prefers wounded
*and* high-level enemies, so a snowballing leader draws the squad's guns. Bounty
(0.8) tuned so a wounded veteran is prized but a full-hp tank isn't dived (its hp
still outweighs the bounty). Verified: wounded L5 > wounded L1; full-hp L5 tank <
wounded L1. Combined with the kill-XP matrix, leveling past L4 is genuinely
contested (measured: L5 rarer, still reachable every match).

### P5 — L5 class capstones (DONE)

One signature unlock per archetype at `MAX_LEVEL`, all reusing existing infra:

- **interceptor → AoE missiles.** `fireMissile` launches `spawnEmpMissile` (area
  blast) at L5 instead of a single-target missile.
- **heavy → ram shockwave.** `detonateBlast` hoisted to context.ts; `maybeRamShock`
  fires an area blast (`RAM_SHOCK_DAMAGE`/`RAM_SHOCK_RADIUS`) on an L5 rammer's
  ship *or* base slam — a veteran heavy becomes a melee area-bruiser.
- **fighter → third barrel.** `weaponFor(archetype, level)` adds a parallel barrel
  (2 → 3) for the L5 fighter, widening its abreast volley.
- **scout → map-wide recon.** L5 scout shares finished-raid intel at `Infinity`
  reach (was `RECON_SHARE_RADIUS`), so the whole team inherits its raids.

Verified: fighter barrel bump (L4=2 → L5=3), interceptor launcher swap, ram-shock
helper, global recon reach; L5 reached every match so capstones fire. tsc + 41
tests + lint green.

## Deferred

- **P3 alternative** (if focus pressure over-punishes in playtest): diminish
  shield/regen gains up the level curve instead of / alongside veteran targeting.

**Verify (playtest):** rock-only ship stalls at L3; combat/raid ships climb to
L4–L5; leveling via rocks doesn't refill a damaged hull; center-pad + pickup
promotes still heal; L5 capstones read clearly on the field.
