import { beforeEach, describe, expect, test } from "bun:test";
import {
  createDraft,
  type DraftApi,
  STORE_KEY,
  stockHull,
} from "~/drydock/draft";
import type { Kv } from "~/drydock/env";

// A fake kv plus an injected clock: every test gets a virgin draft, and the
// coalescing window is driven by hand instead of by wall time.
const fakeKv = (): Kv & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
};

let kv: ReturnType<typeof fakeKv>;
let clock: number;
let draft: DraftApi;

const make = (): DraftApi =>
  createDraft({ kv, now: () => clock, limit: 50, coalesceMs: 600 });

beforeEach(() => {
  kv = fakeKv();
  clock = 0;
  draft = make();
});

/** Mutate scout's first part the way a field edit or a gizmo drag would. */
const nudge = (d: DraftApi, x: number): void => {
  d.hulls.scout.parts[0].pos[0] = x;
  d.touch("scout");
};

describe("boot", () => {
  test("empty storage gives every class its stock recipe", () => {
    expect(draft.hulls.scout).toEqual(stockHull("scout"));
    expect(draft.hulls.fighter).toEqual(stockHull("fighter"));
    expect(draft.dirtyClasses()).toEqual([]);
  });

  test("saved classes load, absent ones stay stock", () => {
    nudge(draft, 0.5);
    draft.save();

    const next = make();
    expect(next.hulls.scout.parts[0].pos[0]).toBe(0.5);
    expect(next.hulls.fighter).toEqual(stockHull("fighter"));
  });

  test("corrupt storage falls back to stock without throwing", () => {
    kv.map.set(STORE_KEY, "{not json");
    expect(() => make()).not.toThrow();
    expect(make().hulls.scout).toEqual(stockHull("scout"));
  });

  test("pre-articulation saves get articulation backfilled", () => {
    const stock = stockHull("scout");
    kv.map.set(
      STORE_KEY,
      JSON.stringify({ scout: { parts: stock.parts, engines: stock.engines } }),
    );
    expect(make().hulls.scout.articulation).toEqual(stock.articulation);
  });

  test("the draft is not aliased to the saved baseline", () => {
    nudge(draft, 0.4);
    draft.save();
    const next = make();
    next.hulls.scout.parts[0].pos[0] = 0.9;
    // Reverting proves the baseline was cloned, not shared.
    next.revert("scout");
    expect(next.hulls.scout.parts[0].pos[0]).toBe(0.4);
  });
});

describe("persistence", () => {
  test("editing never writes to storage", () => {
    draft.beginEdit("scout", 0, "position x");
    nudge(draft, 0.5);
    expect(kv.getItem(STORE_KEY)).toBeNull();
    expect(draft.isDirty()).toBe(true);
  });

  test("save writes the draft and clears dirty and history", () => {
    draft.pushUndo("scout", 0, "position x");
    nudge(draft, 0.5);
    draft.save();

    const raw = kv.getItem(STORE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).scout.parts[0].pos[0]).toBe(0.5);
    expect(draft.isDirty()).toBe(false);
    expect(draft.dirtyClasses()).toEqual([]);
    expect(draft.peekUndo()).toBeNull();
    expect(draft.peekRedo()).toBeNull();
  });
});

describe("revert and reset", () => {
  test("revert restores the last saved state and goes clean", () => {
    nudge(draft, 0.5);
    draft.save();
    nudge(draft, 1.2);
    draft.revert("scout");

    expect(draft.hulls.scout.parts[0].pos[0]).toBe(0.5);
    expect(draft.isDirty("scout")).toBe(false);
  });

  test("revert on a never-saved class lands on stock", () => {
    nudge(draft, 1.2);
    draft.revert("scout");
    expect(draft.hulls.scout).toEqual(stockHull("scout"));
  });

  test("revert is itself undoable", () => {
    nudge(draft, 1.2);
    draft.revert("scout");
    draft.undo();
    expect(draft.hulls.scout.parts[0].pos[0]).toBe(1.2);
  });

  test("reset loads stock but stays dirty and unwritten", () => {
    nudge(draft, 0.5);
    draft.save();
    nudge(draft, 1.2);
    draft.reset("scout");

    expect(draft.hulls.scout).toEqual(stockHull("scout"));
    expect(draft.isDirty("scout")).toBe(true);
    expect(
      JSON.parse(kv.getItem(STORE_KEY) as string).scout.parts[0].pos[0],
    ).toBe(0.5);
  });

  test("reset on an already-saved stock hull is clean", () => {
    draft.save();
    draft.reset("scout");
    // Nothing actually changed, so the honest answer is "not dirty".
    expect(draft.isDirty("scout")).toBe(false);
  });
});

describe("undo and redo", () => {
  test("undo restores the pre-edit state and reports its selection", () => {
    draft.pushUndo("scout", 2, "move part 2");
    nudge(draft, 0.5);

    expect(draft.undo()).toEqual({
      cls: "scout",
      sel: 2,
      label: "move part 2",
    });
    expect(draft.hulls.scout.parts[0].pos[0]).toBe(
      stockHull("scout").parts[0].pos[0],
    );
  });

  test("redo re-applies what undo took away", () => {
    draft.pushUndo("scout", 0, "move part 0");
    nudge(draft, 0.5);
    draft.undo();
    draft.redo();
    expect(draft.hulls.scout.parts[0].pos[0]).toBe(0.5);
  });

  test("a fresh edit clears the redo stack", () => {
    draft.pushUndo("scout", 0, "first");
    nudge(draft, 0.5);
    draft.undo();
    expect(draft.peekRedo()).toBe("first");

    draft.pushUndo("scout", 0, "second");
    nudge(draft, 0.9);
    expect(draft.peekRedo()).toBeNull();
  });

  test("undoing back to the saved state clears dirty, redo re-dirties", () => {
    draft.save();
    draft.pushUndo("scout", 0, "move");
    nudge(draft, 0.5);
    expect(draft.isDirty("scout")).toBe(true);

    draft.undo();
    expect(draft.isDirty("scout")).toBe(false);

    draft.redo();
    expect(draft.isDirty("scout")).toBe(true);
  });
});

describe("undo history limits and reporting", () => {
  test("the stack is bounded and drops the oldest entries", () => {
    for (let i = 1; i <= 60; i++) {
      draft.pushUndo("scout", 0, `edit ${i}`);
      nudge(draft, i);
    }
    for (let i = 0; i < 50; i++) expect(draft.undo()).not.toBeNull();
    expect(draft.undo()).toBeNull();
    // 60 edits, 50 remembered — we land on the state after the 10 dropped ones.
    expect(draft.hulls.scout.parts[0].pos[0]).toBe(10);
  });

  test("undo with no history is a no-op", () => {
    expect(draft.undo()).toBeNull();
    expect(draft.redo()).toBeNull();
  });

  test("undo reports the class the edit touched", () => {
    draft.pushUndo("scout", 0, "scout edit");
    nudge(draft, 0.5);
    draft.pushUndo("fighter", 1, "fighter edit");
    draft.hulls.fighter.parts[0].pos[0] = 0.7;
    draft.touch("fighter");

    expect(draft.undo()?.cls).toBe("fighter");
    expect(draft.undo()?.cls).toBe("scout");
  });
});

describe("coalescing", () => {
  test("a drag's worth of ticks collapses to one undo step", () => {
    for (let i = 1; i <= 60; i++) {
      draft.beginEdit("scout", 0, "position x");
      nudge(draft, i / 100);
      clock += 16;
    }
    expect(draft.undo()).not.toBeNull();
    expect(draft.undo()).toBeNull();
    expect(draft.hulls.scout.parts[0].pos[0]).toBe(
      stockHull("scout").parts[0].pos[0],
    );
  });

  test("a pause past the window starts a new step", () => {
    draft.beginEdit("scout", 0, "position x");
    nudge(draft, 0.3);
    clock += 601;
    draft.beginEdit("scout", 0, "position x");
    nudge(draft, 0.6);

    draft.undo();
    expect(draft.hulls.scout.parts[0].pos[0]).toBe(0.3);
    draft.undo();
    expect(draft.hulls.scout.parts[0].pos[0]).toBe(
      stockHull("scout").parts[0].pos[0],
    );
  });

  test("different labels inside the window stay separate steps", () => {
    draft.beginEdit("scout", 0, "position x");
    nudge(draft, 0.3);
    draft.beginEdit("scout", 0, "position y");
    draft.hulls.scout.parts[0].pos[1] = 0.4;
    draft.touch("scout");

    expect(draft.peekUndo()).toBe("position y");
    draft.undo();
    expect(draft.peekUndo()).toBe("position x");
  });

  test("switching part inside the window starts a new step", () => {
    draft.beginEdit("scout", 0, "position x");
    nudge(draft, 0.3);
    draft.beginEdit("scout", 1, "position x");
    nudge(draft, 0.6);

    draft.undo();
    expect(draft.hulls.scout.parts[0].pos[0]).toBe(0.3);
  });

  test("discrete pushes with the same label never coalesce", () => {
    draft.pushUndo("scout", 0, "add part");
    draft.pushUndo("scout", 0, "add part");
    expect(draft.undo()).not.toBeNull();
    expect(draft.undo()).not.toBeNull();
  });
});
