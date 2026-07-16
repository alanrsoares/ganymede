// Drydock store: framework-agnostic state shared by the WebGPU scene and the
// React designer panel. The scene reads `view`/`hulls` directly every frame;
// the UI subscribes and re-renders on `version` bumps. Hull recipes are
// deep-mutable working copies persisted to localStorage; mesh re-bakes are
// debounced through hooks the scene registers once the GPU exists.

import {
  ENGINES,
  type EngineAnchor,
  type PartDef,
  type PrimDef,
  RECIPES,
  SHIP_CLASSES,
  type ShipClass,
} from "../ship-parts";

export interface HullDef {
  parts: PartDef[];
  engines: EngineAnchor[];
}

export interface UndoSlot {
  cls: ShipClass;
  hull: HullDef;
  label: string;
}

const STORE_KEY = "drydock-hulls-v1";

export const stockHull = (cls: ShipClass): HullDef =>
  structuredClone({
    parts: RECIPES[cls] as PartDef[],
    engines: ENGINES[cls] as EngineAnchor[],
  });

const loadHulls = (): Record<ShipClass, HullDef> => {
  const out = {} as Record<ShipClass, HullDef>;
  for (const cls of SHIP_CLASSES) out[cls] = stockHull(cls);
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<ShipClass, HullDef>>;
      for (const cls of SHIP_CLASSES) {
        const h = saved[cls];
        if (h?.parts?.length && h.engines) out[cls] = h;
      }
    }
  } catch {
    // corrupt store — fall back to stock
  }
  return out;
};

export const view = {
  cls: "scout" as ShipClass,
  team: 0,
  tiltDeg: 28,
  bank: false,
  mono: false,
  paused: matchMedia("(prefers-reduced-motion: reduce)").matches,
  t: 0,
  // Inspector orbit: drag adds yaw/pitch on top of the slider tilt; dragging
  // stops the auto-spin (spinPhase freezes), the `spin` button resumes it.
  spin: true,
  spinPhase: 0,
  orbitYaw: 0,
  orbitPitch: 0,
  design: false,
  /** Set when WebGPU init fails; the UI swaps to an error screen. */
  gpuError: "",
};

export const hulls = loadHulls();

export const sel = { part: 0 };

export let undoSlot: UndoSlot | null = null;

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

/** Persist + debounce a mesh re-bake for the class being edited. */
const persistAndRebake = (): void => {
  localStorage.setItem(STORE_KEY, JSON.stringify(hulls));
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildHull(view.cls);
    rebuildHighlight();
  }, 80);
};

/** Field-level hull edit (slider drag etc.): mutate, then call this. */
export const touchHull = (): void => {
  persistAndRebake();
  notify();
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

export const setGpuError = (message: string): void => {
  view.gpuError = message;
  notify();
};

export const selectPart = (i: number): void => {
  sel.part = i;
  rebuildHighlight();
  notify();
};

// --- undo (one-deep, swap semantics: undo twice = redo) -----------------------

export const snapshotUndo = (label: string): void => {
  undoSlot = {
    cls: view.cls,
    hull: structuredClone(hulls[view.cls]),
    label,
  };
  notify();
};

export const undo = (): void => {
  if (!undoSlot) return;
  const redo: UndoSlot = {
    cls: undoSlot.cls,
    hull: structuredClone(hulls[undoSlot.cls]),
    label: "redo",
  };
  hulls[undoSlot.cls] = undoSlot.hull;
  view.cls = undoSlot.cls; // jump back to the class the action touched
  undoSlot = redo;
  sel.part = 0;
  touchHull();
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
  hull.parts.splice(sel.part + 1, 0, structuredClone(part));
  sel.part++;
  touchHull();
};

export const delPart = (): void => {
  const hull = hulls[view.cls];
  if (hull.parts.length <= 1) return;
  snapshotUndo(`delete part ${sel.part}`);
  hull.parts.splice(sel.part, 1);
  sel.part = Math.min(sel.part, hull.parts.length - 1);
  touchHull();
};

export const addEngine = (): void => {
  hulls[view.cls].engines.push({ pos: [0, -1.2, 0], w: 0.12 });
  touchHull();
};

export const delEngine = (i: number): void => {
  snapshotUndo(`delete engine ${i}`);
  hulls[view.cls].engines.splice(i, 1);
  touchHull();
};

export const resetClass = (): void => {
  snapshotUndo("reset");
  hulls[view.cls] = stockHull(view.cls);
  sel.part = 0;
  touchHull();
};

// --- clipboard round-trip -------------------------------------------------------
// Pure `{ parts, engines }` JSON: a valid TS literal to paste into
// ship-parts.ts, parseable back by import. Both return a status message
// for the UI to flash on the button.

export const exportHull = async (): Promise<string> => {
  const { parts, engines } = hulls[view.cls];
  const json = JSON.stringify({ parts, engines }, null, 2);
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
    snapshotUndo("import");
    hulls[view.cls] = { parts: parsed.parts, engines: parsed.engines };
    sel.part = 0;
    touchHull();
    return "imported ✓";
  } catch {
    return "clipboard is not hull JSON";
  }
};
