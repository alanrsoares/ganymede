// Draft lifecycle for hull recipes: the edit buffer, the saved baseline, dirty
// tracking and undo/redo. Deliberately DOM-free and clock-injected so the risky
// parts (coalescing, stack bounds, revert) are unit-testable — `store.ts` owns
// the browser wiring and the React notifications, this owns the rules.
//
// Edits mutate `hulls` in place and are NOT persisted; `save()` is the only
// thing that writes. `revert()` returns a class to the last saved state,
// `reset()` loads the stock recipe but leaves the draft dirty, so returning to
// the factory hull is itself an edit you have to commit.

import {
  ARTICULATION,
  type ArticulationDef,
  ENGINES,
  type EngineAnchor,
  type PartDef,
  RECIPES,
  SHIP_CLASSES,
  type ShipClass,
} from "~/hull/catalog";
import type { Kv } from "./env";

export interface HullDef {
  parts: PartDef[];
  engines: EngineAnchor[];
  articulation: ArticulationDef;
}

export const STORE_KEY = "drydock-hulls-v1";

/** The catalog recipe for a class — the factory default, deep-cloned. */
export const stockHull = (cls: ShipClass): HullDef =>
  structuredClone({
    parts: RECIPES[cls] as PartDef[],
    engines: ENGINES[cls] as EngineAnchor[],
    articulation: ARTICULATION[cls],
  });

/** What one undo/redo step restores, plus the selection it was made under. */
interface Entry {
  cls: ShipClass;
  hull: HullDef;
  sel: number;
  label: string;
  /** Coalescing identity; null for discrete steps, which never merge. */
  key: string | null;
  at: number;
}

export interface UndoResult {
  cls: ShipClass;
  sel: number;
  label: string;
}

export interface DraftDeps {
  kv: Kv;
  now?: () => number;
  limit?: number;
  coalesceMs?: number;
}

export interface DraftApi {
  /** The live edit buffer. Identity is stable — the scene reads it every frame. */
  readonly hulls: Record<ShipClass, HullDef>;
  touch: (cls: ShipClass) => void;
  beginEdit: (cls: ShipClass, sel: number, label: string) => void;
  pushUndo: (cls: ShipClass, sel: number, label: string) => void;
  undo: () => UndoResult | null;
  redo: () => UndoResult | null;
  peekUndo: () => string | null;
  peekRedo: () => string | null;
  isDirty: (cls?: ShipClass) => boolean;
  dirtyClasses: () => ShipClass[];
  save: () => void;
  revert: (cls: ShipClass) => void;
  reset: (cls: ShipClass) => void;
}

/** Stock for every class, overlaid with whatever valid records are in storage. */
const loadSaved = (kv: Kv): Record<ShipClass, HullDef> => {
  const out = {} as Record<ShipClass, HullDef>;
  for (const cls of SHIP_CLASSES) out[cls] = stockHull(cls);
  try {
    const raw = kv.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<ShipClass, HullDef>>;
      for (const cls of SHIP_CLASSES) {
        const h = saved[cls];
        if (h?.parts?.length && h.engines) {
          // Backfill articulation on pre-articulation saves — same store key.
          out[cls] = {
            ...h,
            articulation: h.articulation ?? structuredClone(ARTICULATION[cls]),
          };
        }
      }
    }
  } catch {
    // corrupt store — fall back to stock
  }
  return out;
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one closure owns the buffer, the baseline and both stacks — splitting it would mean exporting that state
export const createDraft = ({
  kv,
  now = () => Date.now(),
  limit = 50,
  coalesceMs = 600,
}: DraftDeps): DraftApi => {
  let saved = loadSaved(kv);
  const hulls = structuredClone(saved);
  const dirty = new Set<ShipClass>();
  const undoStack: Entry[] = [];
  const redoStack: Entry[] = [];

  const snapshot = (
    cls: ShipClass,
    sel: number,
    label: string,
    key: string | null,
  ): Entry => ({
    cls,
    hull: structuredClone(hulls[cls]),
    sel,
    label,
    key,
    at: now(),
  });

  const push = (entry: Entry): void => {
    undoStack.push(entry);
    // Drop the oldest history rather than the newest edit.
    if (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
  };

  /** Honest dirty check, so undoing back to the saved state goes clean again. */
  const recompute = (cls: ShipClass): void => {
    if (JSON.stringify(hulls[cls]) === JSON.stringify(saved[cls])) {
      dirty.delete(cls);
    } else {
      dirty.add(cls);
    }
  };

  const step = (from: Entry[], to: Entry[]): UndoResult | null => {
    const entry = from.pop();
    if (!entry) return null;
    to.push(snapshot(entry.cls, entry.sel, entry.label, null));
    hulls[entry.cls] = entry.hull;
    recompute(entry.cls);
    return { cls: entry.cls, sel: entry.sel, label: entry.label };
  };

  return {
    hulls,

    // Hot path: one call per slider tick, so no cloning or comparing here.
    touch: (cls) => {
      dirty.add(cls);
    },

    beginEdit: (cls, sel, label) => {
      const key = `${label}:${cls}:${sel}`;
      const top = undoStack.at(-1);
      if (top?.key === key && top.cls === cls && now() - top.at < coalesceMs) {
        // Keep the older pre-state — that is what makes a whole drag one step —
        // but keep the window alive so a long drag stays a single entry.
        top.at = now();
        return;
      }
      push(snapshot(cls, sel, label, key));
    },

    pushUndo: (cls, sel, label) => push(snapshot(cls, sel, label, null)),

    undo: () => step(undoStack, redoStack),
    redo: () => step(redoStack, undoStack),
    peekUndo: () => undoStack.at(-1)?.label ?? null,
    peekRedo: () => redoStack.at(-1)?.label ?? null,

    isDirty: (cls) => (cls ? dirty.has(cls) : dirty.size > 0),
    dirtyClasses: () => SHIP_CLASSES.filter((cls) => dirty.has(cls)),

    save: () => {
      kv.setItem(STORE_KEY, JSON.stringify(hulls));
      saved = structuredClone(hulls);
      dirty.clear();
      undoStack.length = 0;
      redoStack.length = 0;
    },

    revert: (cls) => {
      // Undoable: reverting is a bulk discard, and a mis-click shouldn't be final.
      push(snapshot(cls, 0, `revert ${cls}`, null));
      hulls[cls] = structuredClone(saved[cls]);
      dirty.delete(cls);
    },

    reset: (cls) => {
      push(snapshot(cls, 0, `reset ${cls}`, null));
      hulls[cls] = stockHull(cls);
      // Stays dirty on purpose: the stock recipe is a draft edit until saved.
      recompute(cls);
    },
  };
};
