// Keyboard shortcuts. Skipped while typing in a field; space is left alone
// when a button has focus so keyboard activation still works. Each action
// returns false to decline (leaves the event untouched).

import { SHIP_CLASSES } from "~/hull/catalog";
import {
  setCls,
  setDesign,
  toggleBank,
  toggleMono,
  togglePause,
  view,
} from "./store";

const selectClass = (i: number): boolean => {
  setCls(SHIP_CLASSES[i]);
  return true;
};

const KEY_ACTIONS: Record<string, (e: KeyboardEvent) => boolean> = {
  1: () => selectClass(0),
  2: () => selectClass(1),
  3: () => selectClass(2),
  4: () => selectClass(3),
  d: () => {
    setDesign(!view.design);
    return true;
  },
  m: () => {
    toggleMono();
    return true;
  },
  b: () => {
    toggleBank();
    return true;
  },
  " ": (e) => {
    if (e.target instanceof HTMLButtonElement) return false; // keep space = click
    e.preventDefault();
    togglePause();
    return true;
  },
  Escape: () => {
    if (!view.design) return false;
    setDesign(false);
    return true;
  },
};

export const wireKeys = (): void => {
  addEventListener("keydown", (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement ||
      t.isContentEditable
    ) {
      return;
    }
    KEY_ACTIONS[e.key]?.(e);
  });
};
