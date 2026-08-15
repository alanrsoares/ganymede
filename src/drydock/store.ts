// Drydock store: framework-agnostic state shared by the WebGPU scene and the
// React designer panel. The scene reads `view`/`hulls` directly every frame;
// the UI subscribes and re-renders on `version` bumps. Hull recipes are
// deep-mutable drafts held in memory — nothing reaches localStorage until
// `saveHulls()`; mesh re-bakes are debounced through hooks the scene registers
// once the GPU exists. Draft rules (dirty, undo/redo, revert) live in draft.ts.

import { ARTICULATION, type PrimDef, type ShipClass } from "~/hull/catalog";
import { createDraft, type HullDef, type UndoResult } from "./draft";
import { kv, prefersReducedMotion } from "./env";
import { applyOp, type HullOp } from "./ops";

export type { HullDef } from "./draft";
export { stockHull } from "./draft";

export const view = {
  cls: "scout" as ShipClass,
  team: 0,
  tiltDeg: 28,
  bank: false,
  mono: false,
  paused: prefersReducedMotion(),
  t: 0,
  // Inspector orbit: drag adds yaw/pitch on top of the slider tilt; dragging
  // stops the auto-spin (spinPhase freezes), the `spin` button resumes it.
  spin: true,
  spinPhase: 0,
  orbitYaw: 0,
  orbitPitch: 0,
  design: false,
  controlDeckCollapsed: false,
  /** Set when WebGPU init fails; the UI swaps to an error screen. */
  gpuError: "",
};

const draft = createDraft({ kv });

export const hulls = draft.hulls;

export const sel = { part: 0 };

// --- subscription (React side) ----------------------------------------------

let version = 0;
const listeners = new Set<() => void>();

export const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getVersion = (): number => version;

const notify = (): void => {
  version++;
  for (const fn of listeners) fn();
};

// --- mesh rebuild hooks (scene side) ------------------------------------------

let rebuildHull: (cls: ShipClass) => void = () => {};
let rebuildHighlight: () => void = () => {};
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

export const registerRebuild = (
  hull: (cls: ShipClass) => void,
  highlight: () => void,
): void => {
  rebuildHull = hull;
  rebuildHighlight = highlight;
};

/** Debounce a mesh re-bake for the class being edited. */
const rebake = (): void => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildHull(view.cls);
    rebuildHighlight();
  }, 80);
};

/**
 * Re-bake and re-render without touching the dirty flag. Used by the actions
 * that already decided what dirty means (undo/redo/revert/reset) — routing them
 * through `touchHull` would re-dirty a class that just returned to saved state.
 */
const refresh = (): void => {
  rebake();
  notify();
};

/**
 * Field-level hull edit (slider drag etc.): mutate, then call this. Marks the
 * draft dirty and re-bakes — it does NOT persist. Pair it with `beginEdit` or
 * `pushUndo` *before* the mutation so the edit is undoable.
 */
export const touchHull = (): void => {
  draft.touch(view.cls);
  refresh();
};

// --- draft lifecycle ----------------------------------------------------------

/**
 * Call BEFORE mutating, for edits that arrive as a stream (slider drags,
 * held-key nudges): repeats of the same label collapse into one undo step.
 */
export const beginEdit = (label: string): void => {
  draft.beginEdit(view.cls, sel.part, label);
};

/** Call BEFORE mutating, for discrete edits: one action, one undo step. */
export const pushUndo = (label: string): void => {
  draft.pushUndo(view.cls, sel.part, label);
};

const applyStep = (result: UndoResult | null): void => {
  if (!result) return;
  // Follow the edit to its own class — silently editing an off-screen hull is
  // worse than moving the camera.
  view.cls = result.cls;
  const count = hulls[result.cls].parts.length;
  sel.part = Math.min(Math.max(result.sel, 0), count - 1);
  rebuildHighlight();
  refresh();
};

export const undo = (): void => applyStep(draft.undo());
export const redo = (): void => applyStep(draft.redo());

/** Label of the next undo/redo step, or null when the stack is empty. */
export const undoLabel = (): string | null => draft.peekUndo();
export const redoLabel = (): string | null => draft.peekRedo();

export const isDirty = (cls?: ShipClass): boolean => draft.isDirty(cls);
export const dirtyClasses = (): ShipClass[] => draft.dirtyClasses();

/** Promote the draft to storage. The only thing that writes. */
export const saveHulls = (): void => {
  draft.save();
  notify();
};

/** Discard this class's unsaved edits. */
export const revertClass = (): void => {
  draft.revert(view.cls);
  sel.part = 0;
  rebuildHighlight();
  refresh();
};

/** Load the stock recipe into the draft — still needs a save to persist. */
export const resetClass = (): void => {
  draft.reset(view.cls);
  sel.part = 0;
  rebuildHighlight();
  refresh();
};

/** Warn before a reload throws away unsaved hull edits. */
export const installUnloadGuard = (): void => {
  addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
    if (!draft.isDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });
};

// --- view actions -----------------------------------------------------------

export const setCls = (cls: ShipClass): void => {
  view.cls = cls;
  sel.part = 0; // never leave a stale index armed for delete
  rebuildHighlight();
  notify();
};

export const setTeam = (i: number): void => {
  view.team = i;
  notify();
};

export const setTiltDeg = (deg: number): void => {
  view.tiltDeg = deg;
  notify();
};

export const toggleSpin = (): void => {
  view.spin = !view.spin;
  if (view.spin) view.orbitYaw = 0; // resume clean auto-yaw
  notify();
};

/** A real orbit drag takes over from auto-spin. */
export const stopSpinForDrag = (): void => {
  if (!view.spin) return;
  view.spin = false;
  notify();
};

export const toggleBank = (): void => {
  view.bank = !view.bank;
  notify();
};

export const toggleMono = (): void => {
  view.mono = !view.mono;
  notify();
};

export const togglePause = (): void => {
  view.paused = !view.paused;
  notify();
};

export const setDesign = (on: boolean): void => {
  view.design = on;
  notify();
};

export const toggleControlDeck = (): void => {
  view.controlDeckCollapsed = !view.controlDeckCollapsed;
  notify();
};

export const setGpuError = (message: string): void => {
  view.gpuError = message;
  notify();
};

export const selectPart = (i: number): void => {
  sel.part = i;
  rebuildHighlight();
  notify();
};

// --- agent ops (natural-language / hull-op DSL) -------------------------------
// Apply a batch from the design agent as one undoable step. Bad ops are
// skipped by applyOp; returns the applied-op log lines for the UI.

export const applyOps = (ops: HullOp[], label: string): string[] => {
  pushUndo(label);
  const hull = hulls[view.cls];
  const log = ops
    .map((op) => applyOp(hull, op))
    .filter((line): line is string => line !== null);
  sel.part = Math.min(sel.part, hull.parts.length - 1);
  touchHull();
  return log;
};

// --- hull structure ops -------------------------------------------------------

export const defaultPrim = (kind: string): PrimDef =>
  kind === "hex"
    ? { kind: "hex", taper: 0.7 }
    : kind === "orb"
      ? { kind: "orb" }
      : { kind: "slab", tx: 0.5, tz: 0.5 };

export const addPart = (): void => {
  const hull = hulls[view.cls];
  pushUndo("add part");
  hull.parts.push({
    prim: defaultPrim("slab"),
    scale: [0.3, 0.3, 0.3],
    pos: [0, 0, 0],
    color: "bone",
  });
  sel.part = hull.parts.length - 1;
  touchHull();
};

export const dupPart = (): void => {
  const hull = hulls[view.cls];
  const part = hull.parts[sel.part];
  if (!part) return;
  pushUndo(`duplicate part ${sel.part}`);
  hull.parts.splice(sel.part + 1, 0, structuredClone(part));
  sel.part++;
  touchHull();
};

export const delPart = (): void => {
  const hull = hulls[view.cls];
  if (hull.parts.length <= 1) return;
  pushUndo(`delete part ${sel.part}`);
  hull.parts.splice(sel.part, 1);
  sel.part = Math.min(sel.part, hull.parts.length - 1);
  touchHull();
};

export const addEngine = (): void => {
  pushUndo("add engine");
  hulls[view.cls].engines.push({ pos: [0, -1.2, 0], w: 0.12 });
  touchHull();
};

export const delEngine = (i: number): void => {
  pushUndo(`delete engine ${i}`);
  hulls[view.cls].engines.splice(i, 1);
  touchHull();
};

// --- clipboard round-trip -------------------------------------------------------
// Pure `{ parts, engines, articulation }` JSON: a valid TS literal to paste into
// hull/catalog.ts, parseable back by import. Both return a status message
// for the UI to flash on the button.

export const exportHull = async (): Promise<string> => {
  const { parts, engines, articulation } = hulls[view.cls];
  const json = JSON.stringify({ parts, engines, articulation }, null, 2);
  console.log(`// ${view.cls} hull — exported from /drydock designer\n${json}`);
  if (!navigator.clipboard) return "no clipboard — see console";
  try {
    await navigator.clipboard.writeText(json);
    return "copied ✓";
  } catch {
    return "copy failed — see console";
  }
};

export const importHull = async (): Promise<string> => {
  try {
    const parsed = JSON.parse(
      await navigator.clipboard.readText(),
    ) as Partial<HullDef>;
    if (!parsed.parts?.length || !Array.isArray(parsed.engines)) {
      throw new Error("bad shape");
    }
    pushUndo("import");
    hulls[view.cls] = {
      parts: parsed.parts,
      engines: parsed.engines,
      // Pre-articulation clipboard payloads stay valid — fall back to stock.
      articulation:
        parsed.articulation ?? structuredClone(ARTICULATION[view.cls]),
    };
    sel.part = 0;
    touchHull();
    return "imported ✓";
  } catch {
    return "clipboard is not hull JSON";
  }
};
