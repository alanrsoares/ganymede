// Input edge: pointer/keyboard/resize wiring from DOM events into the pure
// World via a single `dispatch` port. Owns the ship-pick hit-test and the live
// grid-dimension sync. No sim logic lives here — every handler just emits a Msg.

import { type Codex, mountCodex } from "../codex";
import type { Renderer } from "../gpu";
import { mountShipCard } from "../shipCard";
import type { Ui } from "../ui";
import {
  ARENA,
  DEFAULT_GRID_H,
  type LightCycle,
  type Msg,
  setGridBounds,
  type World,
} from "../world";
import { shipRadius, WHIP_ENABLED } from "../world/factory";

type PressedKeys = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  space: boolean;
};

// Nearest ship under a grid point, or null — the hull whose radius (plus a
// small margin) contains the cursor. O(ships) ≤ 12, cheap enough per move.
const pickShip = (world: World, gx: number, gy: number): LightCycle | null => {
  let best: LightCycle | null = null;
  let bestD2 = Infinity;
  for (const s of world.ships.items) {
    const dx = s.x - gx;
    const dy = s.y - gy;
    const d2 = dx * dx + dy * dy;
    const reach = shipRadius(s.level) + 3;
    if (d2 <= reach * reach && d2 < bestD2) {
      bestD2 = d2;
      best = s;
    }
  }
  return best;
};

// Re-derive the sim grid from the canvas aspect ratio (height locked).
export const updateGridDimensions = (canvas: HTMLCanvasElement) => {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const aspect = h > 0 ? w / h : 16 / 9;
  setGridBounds(Math.round(DEFAULT_GRID_H * aspect), DEFAULT_GRID_H);
};

// True while keyboard focus is inside a form control — we must not hijack its
// keys (a slider drag, a future text field) for game hotkeys.
const typingInField = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === "INPUT" ||
      t.tagName === "SELECT" ||
      t.tagName === "TEXTAREA" ||
      t.isContentEditable)
  );
};

const handlePointerDown = (
  e: PointerEvent,
  canvas: HTMLCanvasElement,
  dispatch: (msg: Msg) => void,
  getWorld: () => World,
) => {
  const cx = (e.offsetX / canvas.clientWidth) * ARENA.w;
  const cy = (e.offsetY / canvas.clientHeight) * ARENA.h;
  if (e.button === 2 || e.shiftKey) {
    dispatch({ kind: "rally", x: Math.floor(cx), y: Math.floor(cy) });
  } else {
    const clickedShip = pickShip(getWorld(), cx, cy);
    if (clickedShip) {
      dispatch({ kind: "control", shipId: clickedShip.id });
    } else {
      const world = getWorld();
      if (world.controlledShipId !== null) {
        dispatch({ kind: "control", shipId: null });
      } else {
        dispatch({ kind: "drop", x: Math.floor(cx), y: Math.floor(cy) });
      }
    }
  }
};

const getDirectionKey = (
  key: string,
): "up" | "down" | "left" | "right" | null => {
  switch (key) {
    case "w":
    case "arrowup":
      return "up";
    case "s":
    case "arrowdown":
      return "down";
    case "a":
    case "arrowleft":
      return "left";
    case "d":
    case "arrowright":
      return "right";
  }
  return null;
};

const triggerManualAction = (
  key: string,
  getWorld: () => World,
  dispatch: (msg: Msg) => void,
): boolean => {
  // 1-7 = fire/mine/missile/buffs; q = the whip special (action 8), gated off
  // while the whip is unplugged from gameplay.
  const actionId = /^[1-7]$/.test(key)
    ? Number.parseInt(key, 10)
    : key === "q" && WHIP_ENABLED
      ? 8
      : 0;
  if (actionId === 0) return false;
  const world = getWorld();
  if (world.controlledShipId !== null) {
    dispatch({ kind: "action", actionId });
    return true;
  }
  return false;
};

// e / Tab cycle the fire lock while piloting (Shift reverses). Gated on control
// so Tab still tabs through the menu chrome otherwise.
const tryCycleTarget = (
  key: string,
  shift: boolean,
  getWorld: () => World,
  dispatch: (msg: Msg) => void,
): boolean => {
  if (key !== "e" && key !== "tab") return false;
  if (getWorld().controlledShipId === null) return false;
  dispatch({ kind: "cycleTarget", dir: shift ? -1 : 1 });
  return true;
};

// Codex toggle: closing is always allowed; opening is gated so the codex
// can't cover the welcome splash or a pre-game dialog.
const toggleCodex = (codex: Codex, isSetupOpen: () => boolean): void => {
  if (codex.isOpen() || !isSetupOpen()) codex.toggle();
};

const handleKeyDown = (
  e: KeyboardEvent,
  codex: Codex,
  isSetupOpen: () => boolean,
  pressedKeys: PressedKeys,
  updateControls: () => void,
  gameKeys: Record<string, () => void>,
  dispatch: (msg: Msg) => void,
  getWorld: () => World,
) => {
  if (typingInField(e)) return;
  const key = e.key.toLowerCase();
  if (key === "c") return toggleCodex(codex, isSetupOpen);
  if (codex.isOpen() || isSetupOpen()) return;

  const dir = getDirectionKey(key);
  if (dir) {
    pressedKeys[dir] = true;
    e.preventDefault();
    updateControls();
    return;
  }

  if (key === " ") {
    pressedKeys.space = true;
    e.preventDefault();
    updateControls();
    return;
  }

  if (triggerManualAction(key, getWorld, dispatch)) {
    e.preventDefault();
    return;
  }

  if (tryCycleTarget(key, e.shiftKey, getWorld, dispatch)) {
    e.preventDefault();
    return;
  }

  gameKeys[key]?.();
};

const handleKeyUp = (
  e: KeyboardEvent,
  pressedKeys: PressedKeys,
  updateControls: () => void,
) => {
  if (typingInField(e)) return;
  const key = e.key.toLowerCase();
  const dir = getDirectionKey(key);
  if (dir) {
    pressedKeys[dir] = false;
    updateControls();
    return;
  }
  if (key === " ") {
    pressedKeys.space = false;
    updateControls();
  }
};

const createControlState = (
  dispatch: (msg: Msg) => void,
  getWorld: () => World,
) => {
  const pressedKeys: PressedKeys = {
    up: false,
    down: false,
    left: false,
    right: false,
    space: false,
  };
  const updateControls = () => {
    if (getWorld().controlledShipId !== null) {
      dispatch({ kind: "controlKeys", ...pressedKeys });
    }
  };
  const clearControls = () => {
    pressedKeys.up = false;
    pressedKeys.down = false;
    pressedKeys.left = false;
    pressedKeys.right = false;
    pressedKeys.space = false;
    updateControls();
  };
  return { pressedKeys, updateControls, clearControls };
};

// Touch has no hover, so the inspector card is unreachable via pointermove. A
// tap surfaces the ship under it transiently; any control/drop is still handled
// by the primary pointerdown handler.
const wireTouchInspect = (
  canvas: HTMLCanvasElement,
  card: ReturnType<typeof mountShipCard>,
  getWorld: () => World,
) => {
  let cardTimer = 0;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const gx = (e.offsetX / canvas.clientWidth) * ARENA.w;
    const gy = (e.offsetY / canvas.clientHeight) * ARENA.h;
    const ship = pickShip(getWorld(), gx, gy);
    card.render(ship, e.clientX, e.clientY);
    clearTimeout(cardTimer);
    if (ship) {
      cardTimer = window.setTimeout(() => card.render(null, 0, 0), 2600);
    }
  });
};

// Wire pointer/keyboard/resize; returns the codex handle the loop reads to pause.
export const wireInput = (
  canvas: HTMLCanvasElement,
  renderer: Renderer,
  dispatch: (msg: Msg) => void,
  ui: Ui,
  getWorld: () => World,
  isMenuOpen: () => boolean,
  audio: { toggleMute(): void; skip(): void },
): Codex => {
  const card = mountShipCard();
  const codex = mountCodex();
  window.addEventListener("resize", () => {
    updateGridDimensions(canvas);
    renderer.resize();
  });

  canvas.addEventListener("pointerdown", (e) => {
    // Arcade: the pilot is auto-controlled — ignore clicks so a stray tap can't
    // deselect them (the sim reads that as a lost ship) or drop stray hulls.
    if (getWorld().arcade) return;
    handlePointerDown(e, canvas, dispatch, getWorld);
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointermove", (e) => {
    const gx = (e.offsetX / canvas.clientWidth) * ARENA.w;
    const gy = (e.offsetY / canvas.clientHeight) * ARENA.h;
    card.render(pickShip(getWorld(), gx, gy), e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerleave", () => card.render(null, 0, 0));
  wireTouchInspect(canvas, card, getWorld);

  const { pressedKeys, updateControls, clearControls } = createControlState(
    dispatch,
    getWorld,
  );

  const gameKeys: Record<string, () => void> = {
    z: () => dispatch({ kind: "launch", dir: "a" }),
    x: () => dispatch({ kind: "launch", dir: "b" }),
    h: () => {
      ui.hpOn.val = !ui.hpOn.val;
    },
    m: () => audio.toggleMute(),
    ".": () => audio.skip(),
  };

  window.addEventListener("keydown", (e) =>
    handleKeyDown(
      e,
      codex,
      isMenuOpen,
      pressedKeys,
      updateControls,
      gameKeys,
      dispatch,
      getWorld,
    ),
  );
  window.addEventListener("keyup", (e) =>
    handleKeyUp(e, pressedKeys, updateControls),
  );
  window.addEventListener("blur", clearControls);

  return codex;
};
