// Store-level draft behaviour. draft.ts is tested directly in
// drydock-draft.test.ts; these cover the wiring on top of it, where a stray
// touchHull() can re-dirty a class that just went clean.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  addPart,
  beginEdit,
  delPart,
  dirtyClasses,
  hulls,
  isDirty,
  redo,
  redoLabel,
  resetClass,
  revertClass,
  saveHulls,
  sel,
  setCls,
  stockHull,
  touchHull,
  undo,
  undoLabel,
  view,
} from "~/drydock/store";

/** The store is a module singleton, so each test resets it by hand. */
beforeEach(() => {
  setCls("scout");
  for (const cls of ["scout", "fighter"] as const) {
    hulls[cls] = stockHull(cls);
  }
  saveHulls();
  sel.part = 0;
});

/** A field edit, in the same beginEdit → mutate → touchHull order as fields.tsx. */
const move = (x: number): void => {
  beginEdit("position x");
  hulls[view.cls].parts[0].pos[0] = x;
  touchHull();
};

describe("dirty state", () => {
  test("a field edit dirties the class", () => {
    expect(isDirty()).toBe(false);
    move(0.5);
    expect(isDirty("scout")).toBe(true);
    expect(dirtyClasses()).toEqual(["scout"]);
  });

  test("undo back to the saved state goes clean again", () => {
    addPart();
    move(0.5);
    expect(isDirty("scout")).toBe(true);

    undo(); // the move
    undo(); // the added part
    expect(isDirty("scout")).toBe(false);
    expect(hulls.scout).toEqual(stockHull("scout"));
  });

  test("redo re-dirties", () => {
    addPart();
    undo();
    expect(isDirty("scout")).toBe(false);
    redo();
    expect(isDirty("scout")).toBe(true);
  });

  test("revert goes clean, reset stays dirty", () => {
    move(0.5);
    revertClass();
    expect(isDirty("scout")).toBe(false);

    move(0.5);
    saveHulls();
    resetClass();
    expect(hulls.scout).toEqual(stockHull("scout"));
    expect(isDirty("scout")).toBe(true);
  });
});

describe("history", () => {
  test("structural ops are undoable", () => {
    const before = hulls.scout.parts.length;
    addPart();
    expect(undoLabel()).toBe("add part");
    undo();
    expect(hulls.scout.parts.length).toBe(before);
    expect(redoLabel()).toBe("add part");
  });

  test("delete is undoable and restores the part", () => {
    addPart();
    const count = hulls.scout.parts.length;
    delPart();
    expect(hulls.scout.parts.length).toBe(count - 1);
    undo();
    expect(hulls.scout.parts.length).toBe(count);
  });

  test("undo restores the selection the edit was made under", () => {
    sel.part = 2;
    move(0.5);
    sel.part = 0;

    undo();
    // Not reset to 0: the gizmo should stay on the part you were editing.
    expect(sel.part).toBe(2);
  });

  test("undo follows the edit to its own class", () => {
    move(0.5);
    setCls("fighter");
    move(0.7);

    undo();
    expect(view.cls).toBe("fighter");
    undo();
    expect(view.cls).toBe("scout");
  });

  test("saving clears the history", () => {
    addPart();
    expect(undoLabel()).not.toBeNull();
    saveHulls();
    expect(undoLabel()).toBeNull();
    expect(redoLabel()).toBeNull();
  });
});
