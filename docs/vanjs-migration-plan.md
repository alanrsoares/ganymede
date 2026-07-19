# VanJS → React Migration — Linear Execution Spec

Goal: retire the last **vanjs-core** usage so the UI runs on **one** runtime
(React 19 under the shared `AstryxRoot` gothic theme), then drop the dependency.
Menu chrome already migrated; this finishes the four holdouts.

This is an **executable spec**: every decision is pinned, every task is
self-contained, no task requires judgment the spec doesn't already give. Tasks
are sized so cheaper models can run them; the orchestrator (main) only creates
the keystone primitive, verifies, and integrates.

---

## Global rules — apply to EVERY port task (T1–T4)

**Style contract:** React inside `AstryxRoot`, hand-styled markup kept **1:1**.
No task introduces an astryx *component* (astryx `Card`/`Badge` are pastel chips
that break the gothic look). Every Tailwind class string and inline tint carries
over **verbatim**.

**Signature contract:** each `mount*()` export keeps its **exact name, params,
and return type**. Consumers (`main.ts`, `frame.ts`, `input.ts`, `pauseMenu.tsx`)
must change by **import path only** — a task that would force a call-site edit is
wrong; re-read the source instead.

**Mechanical van→JSX mapping (the ONLY transformations allowed):**
| VanJS | React |
|---|---|
| `const {div,span}=van.tags` + `div({class},kids)` | JSX `<div className=…>{kids}</div>` |
| `van.tags("http://www.w3.org/2000/svg")` | plain JSX `<svg>`/`<path>` (React handles NS) |
| `van.state<T>(x)` | `signal<T>(x)` from `~/ui/signal` |
| reactive `class:()=>…` / `style:()=>…` | value derived in render from `useSignal(sig)` |
| `van.add(document.body, root)` (dialog) | `mountReactDialog(<View/>)` |
| `van.add(document.body, root)` (non-dialog overlay) | own root — see mount idiom below |
| attr `class` | `className` |
| attrs `stroke-width` `stroke-linejoin` `stroke-linecap` | `strokeWidth` `strokeLinejoin` `strokeLinecap` |
| **`style: "left:1px;color:red"` (string)** | **`style={{ left: 1, color: "red" }}` (object — REQUIRED, React ignores style strings)** |
| template-string style `` `color:${t}` `` | object `{{ color: t }}` |

**Non-dialog mount idiom** (shipCard, mobileControls, welcome splash — they append
their own body container, they are NOT modals):
```tsx
const container = document.createElement("div");
document.body.appendChild(container);
createRoot(container).render(<AstryxRoot><View …/></AstryxRoot>);
```
(`AstryxRoot` from `~/astryx`, `createRoot` from `react-dom/client`.)

**Per-task acceptance:** `bun x tsc --noEmit` passes; `grep vanjs-core <file>`
empty; old `.ts` deleted; export signature byte-identical to before.

---

## T0 — keystone primitive `src/ui/signal.ts`  (owner: MAIN, do first)

Blocks all of T1–T4. **Exact, final content — transcribe verbatim:**

```ts
// Minimal reactive cell replacing van.state during the React migration.
// Semantics MATCH vanjs exactly: setter bails on Object.is (van bails on !==),
// so behavior is provably identical to the working van code — objects that were
// fresh refs per frame (score/counts) still notify; unchanged primitives don't.
import { useSyncExternalStore } from "react";

export interface Signal<T> {
  get val(): T;
  set val(v: T);
  subscribe(cb: () => void): () => void;
}

export const signal = <T>(init: T): Signal<T> => {
  let value = init;
  const subs = new Set<() => void>();
  return {
    get val() {
      return value;
    },
    set val(v: T) {
      if (Object.is(v, value)) return;
      value = v;
      for (const cb of subs) cb();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
};

/** Subscribe a React component to a signal at leaf granularity. */
export const useSignal = <T>(s: Signal<T>): T =>
  useSyncExternalStore(s.subscribe, () => s.val, () => s.val);
```
Why this closes the "object-ref" gap: it reproduces van's `!==` dedup exactly, so
no field's update behavior can change relative to today. **No further analysis of
`world.score` needed.**

---

## T1 — `shipCard.ts` → `shipCard.tsx`  (model: sonnet)

- **Read:** `src/ui/shipCard.ts` (full), `src/ui/dialog.tsx:70` (`mountReactDialog`).
- **Preserve export:** `mountShipCard(): ShipCard` where `ShipCard.render(ship, px, py)`.
- **Store:** two signals `target: Signal<LightCycle|null>`, `pos: Signal<{px,py}|null>`.
  `render` keeps the guard: set `target` only when `ship.id` differs; `pos` always;
  `render(null,0,0)` guards on `ship` (NOT coords).
- **Components** (1:1 from builders): `Meter, StatBars, Chip, Traits, RankPip,
  RankLink, RankTrack, Badge, Hairline, Scanline, CardHeader, CardBody`.
- **Scanline-once:** render `<CardBody key={target.id} …/>` so React re-mounts it
  per new contact (van's "body rebuilds on id change") — plays once, not per move.
- **Placement:** compute `left/top/flip/edge glow` each render from `pos` as an
  inline `style` **object** (keeps `color-mix`/rgba out of Bun's CSS downleveling).
- **Mount:** non-dialog idiom above (`ShipCardView` reads both signals via `useSignal`).
- **Delete** `shipCard.ts`. **Consumer `input.ts` unchanged.**

## T2 — `mobileControls.ts` → `mobileControls.tsx`  (model: sonnet)

- **Read:** `src/ui/mobileControls.ts` (full).
- **Preserve exports:** `isTouchPrimary(): boolean` (stays a plain fn),
  `mountMobileControls(opts: MobileControlsOpts)`, types `Keys`/`MobileControlsOpts`.
- Virtual stick + fire + ability pad as components with `onPointerDown/Move/Up` +
  `setPointerCapture`; emit the **identical** `controlKeys`/`action` intent through
  `opts` callbacks — sim stays input-source-agnostic.
- Visibility (touch-primary && ship-controlled) via a `signal<boolean>`.
- **Mount:** non-dialog idiom. **Delete** `mobileControls.ts`. **Consumers
  `main.ts`, `pauseMenu.tsx` unchanged.**

## T3 — `welcome.ts` → `welcome.tsx`  (model: sonnet)

- **Read:** `src/ui/welcome.ts` (full), note `astryx-theme.css` is a listed consumer.
- **Preserve export:** `mountWelcome(): Welcome`, type `WelcomeMode`.
- **Split concerns — do NOT rewrite the camera:** the rAF camera director (eases
  the WebGPU camera for `bloom.wgsl` composite) stays **plain imperative TS inside
  the module**. Only the splash-overlay DOM → a React `<Splash>` component; splash
  state via `signal`.
- `mountWelcome` wires the (unchanged) camera loop **and** renders `<Splash>` via
  the non-dialog mount idiom, returning the same `Welcome` handle.
- Verify no class `astryx-theme.css` targets is renamed/removed. **Delete** `welcome.ts`.
  **Consumer `main.ts` unchanged.**

## T4 — `ui.ts` → `ui.tsx`  (model: sonnet)  ← highest risk, most fields

- **Read:** `src/ui/ui.ts` (full), `src/runtime/frame.ts` (to confirm the 13
  per-frame `ui.<field>.val =` writes), `src/runtime/input.ts` (type usage).
- **Preserve export:** `mountUi(cfg: UiConfig): Ui`, interfaces `UiConfig`, `Ui`.
  In `Ui`, replace `State<T>` (vanjs) with `Signal<T>` (from `~/ui/signal`) — the
  `.val` get/set contract is identical, so **`frame.ts` and `input.ts` do NOT change.**
- Build the HUD as **memoized leaf components**, each reading exactly one field via
  `useSignal(sig)`, so a per-frame `score.val =` re-renders only the score node —
  matching van's per-bound-node granularity. (Behavior parity guaranteed by T0's
  `Object.is` dedup; no special-casing of `score`/`counts`.)
- Port `livesStrip`/`shipIcon` SVG → JSX (keep hull-silhouette + `×N` overflow).
- **Mount:** the HUD is a persistent overlay, not a dialog → non-dialog mount idiom.
- **Delete** `ui.ts`.

---

## T5 — cleanup + dependency drop  (model: haiku)

- `grep -rI vanjs-core src` → must be **empty** (fail the task otherwise).
- Remove `"vanjs-core"` from `package.json` dependencies; `bun install`.
- `bun run check` (lint + typecheck) → green.

---

## Orchestration (token-efficient)

```
T0 (main, inline)              # tiny, pinned; keystone
  └─ then fan out in parallel — T1–T4 touch DISJOINT files, consumers untouched,
     each .tsx self-compiles, so no cross-task conflict:
       T1 shipCard   (sonnet subagent, reads its own source)
       T2 mobile     (sonnet subagent)
       T3 welcome    (sonnet subagent)
       T4 ui         (sonnet subagent)
  └─ barrier: all 4 return
T5 (haiku subagent)            # dep drop + bun run check
VERIFY (main, chrome-driver)   # per surface — NOT delegated (interactive)
COMMIT (main)                  # one conventional commit per phase or one squashed
```

- **Why parallel is safe:** T1–T4 create 4 new files + delete 4 old ones, all
  disjoint; every consumer import path is unchanged, so no file is edited by two
  tasks. Typecheck is only asserted at T5 (after the barrier), not mid-fan-out.
- **Why main keeps verify:** chrome-driver is interactive (hover/touch/60fps
  observation) and needs judgment — cheaper models can't assert visual parity.
- **Context economy:** each subagent reads only its one source file; main never
  loads the four large sources into its own context.

## Verify checklist (main, chrome-driver, post-T5)
- **shipCard:** hover ship → card; stats/rank/traits render; scanline once per
  contact (not per cursor move); edge-flip near right edge; fades on `pointerleave`.
- **mobile:** touch device → stick drives heading; fire/ability emit; hidden with no ship.
- **welcome:** splash eases camera; launch reveals game; chrome hides cleanly.
- **ui/HUD:** score/counts tick live at 60fps; banner + game-over show; no re-render jank.
- **final:** `bun run check` green; full play-through both modes.
```
