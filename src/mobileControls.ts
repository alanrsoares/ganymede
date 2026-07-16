// On-screen touch controls: a left virtual stick that drives the ship's
// direction vector, a right fire button, and an ability pad — the touch
// equivalent of WASD / Space / keys 1-7. Mounted only on touch-primary devices
// and shown only while a ship is under control (arcade always, autobattle when
// a hull is tapped). Pure view: it emits the same `controlKeys`/`action` intent
// the keyboard path does, so the sim stays oblivious to the input source.

import van, { type State } from "vanjs-core";
import type { LightCycle } from "./world";
import { WHIP_ENABLED } from "./world/factory";

const { div, button, span } = van.tags;

// Live boolean set the stick + fire button write into; mirrors World.controlKeys.
export interface Keys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  space: boolean;
}

export interface MobileControlsOpts {
  controlledShip: State<LightCycle | null>;
  onKeys: (k: Keys) => void;
  onAction: (id: number) => void;
  onCycle: (dir: 1 | -1) => void;
  // Touch has no keyboard, so surface a real pause toggle. `onPause` receives
  // the new paused state; the loop reads it. (The codex already has its own
  // on-screen opener, so it needs no button here.)
  onPause: (paused: boolean) => void;
}

// Touch-primary device: no hover, coarse pointer. Desktops (incl. touchscreen
// laptops with a mouse) report `hover: hover`, so they keep the keyboard path.
export const isTouchPrimary = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(hover: none) and (pointer: coarse)").matches;

const ABILITIES: readonly { id: number; label: string; icon: string }[] = [
  { id: 8, label: "Whip", icon: "🐙" },
  { id: 2, label: "Mine", icon: "💣" },
  { id: 3, label: "Missile", icon: "🚀" },
  { id: 4, label: "Boost", icon: "⚡" },
  { id: 5, label: "Shield", icon: "🛡" },
  { id: 6, label: "Cloak", icon: "👁" },
  { id: 7, label: "Field", icon: "⬡" },
];

const STICK = 132; // base diameter (px)
const KNOB = 58; // knob diameter (px)
const MAX_R = (STICK - KNOB) / 2; // knob travel radius
const DIR_T = 0.36; // fraction of travel before a direction latches

// Resolve a clamped stick offset into the 4 direction booleans. Screen y grows
// downward, which already matches the sim's `iy = down - up`.
const dirsFor = (nx: number, ny: number) => ({
  up: ny < -DIR_T,
  down: ny > DIR_T,
  left: nx < -DIR_T,
  right: nx > DIR_T,
});

// The virtual stick. Owns pointer capture on its base and rewrites the shared
// `keys` on every move, emitting only when the latched directions change.
const makeStick = (keys: Keys, emit: () => void) => {
  const knob = div({
    class:
      "absolute rounded-full border border-[#3fd8ff]/70 bg-[#3fd8ff]/25 shadow-[0_0_12px_#3fd8ff55]",
    style: `width:${KNOB}px;height:${KNOB}px;left:50%;top:50%;transform:translate(-50%,-50%);transition:transform .05s linear`,
  });

  const setDirs = (nx: number, ny: number) => {
    const d = dirsFor(nx, ny);
    const changed =
      d.up !== keys.up ||
      d.down !== keys.down ||
      d.left !== keys.left ||
      d.right !== keys.right;
    keys.up = d.up;
    keys.down = d.down;
    keys.left = d.left;
    keys.right = d.right;
    if (changed) emit();
  };

  const base = div(
    {
      "aria-label": "Movement stick",
      class:
        "pointer-events-auto relative rounded-full border border-[#3fd8ff]/25 bg-[#040a0e]/55 backdrop-blur-[3px] [touch-action:none]",
      style: `width:${STICK}px;height:${STICK}px`,
    },
    knob,
  );

  const move = (e: PointerEvent) => {
    const r = base.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy) || 1;
    if (len > MAX_R) {
      dx = (dx / len) * MAX_R;
      dy = (dy / len) * MAX_R;
    }
    knob.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`;
    setDirs(dx / MAX_R, dy / MAX_R);
  };

  const release = () => {
    knob.style.transform = "translate(-50%,-50%)";
    setDirs(0, 0);
  };

  base.addEventListener("pointerdown", (e) => {
    base.setPointerCapture(e.pointerId);
    move(e);
  });
  base.addEventListener("pointermove", (e) => {
    if (e.buttons || e.pointerType === "touch") move(e);
  });
  base.addEventListener("pointerup", release);
  base.addEventListener("pointercancel", release);
  return base;
};

// Hold-to-fire button; sets `space` for the duration of the press.
const makeFire = (keys: Keys, emit: () => void) => {
  const press = (down: boolean) => {
    keys.space = down;
    emit();
  };
  const btn = button(
    {
      type: "button",
      "aria-label": "Fire",
      class:
        "pointer-events-auto flex h-[92px] w-[92px] items-center justify-center rounded-full border border-[#ffd866]/70 bg-[#ffb83f]/20 text-[13px] font-bold uppercase tracking-[0.14em] text-[#ffe08a] shadow-[0_0_16px_#ffb83f44] [touch-action:none] active:bg-[#ffb83f]/40",
    },
    "Fire",
  );
  btn.addEventListener("pointerdown", (e) => {
    btn.setPointerCapture(e.pointerId);
    press(true);
  });
  btn.addEventListener("pointerup", () => press(false));
  btn.addEventListener("pointercancel", () => press(false));
  return btn;
};

// One tap = one ability trigger (the sim gates cooldown/fuel itself).
const abilityButton = (
  a: { id: number; label: string; icon: string },
  onAction: (id: number) => void,
) =>
  button(
    {
      type: "button",
      "aria-label": a.label,
      class:
        "pointer-events-auto flex h-11 w-11 flex-col items-center justify-center rounded-lg border border-[#3fd8ff]/35 bg-[#040a0e]/70 text-[#cfeee2] [touch-action:manipulation] active:bg-[#3fd8ff]/20",
      onclick: () => onAction(a.id),
    },
    span({ class: "text-[15px] leading-none" }, a.icon),
    span(
      { class: "mt-0.5 text-[7px] uppercase tracking-[0.08em] opacity-70" },
      a.label,
    ),
  );

// Cycle the fire lock to the next in-range enemy.
const cycleButton = (onCycle: (dir: 1 | -1) => void) =>
  button(
    {
      type: "button",
      "aria-label": "Cycle target",
      class:
        "pointer-events-auto flex h-11 items-center justify-center gap-1 rounded-lg border border-[#ff6b6b]/45 bg-[#040a0e]/70 px-3 text-[11px] uppercase tracking-[0.1em] text-[#ffb4b4] [touch-action:manipulation] active:bg-[#ff6b6b]/20",
      onclick: () => onCycle(1),
    },
    span({ class: "text-[14px] leading-none" }, "🎯"),
    span({}, "Target"),
  );

// Touch pause toggle — the sim has no other pause affordance and touch has no
// keyboard. Positioned top-left under the existing codex opener (`◈ Ships`) via
// the .hud-mobile-pause CSS hook, so it shares the safe-area column and never
// collides with the top-right status readout. (The codex is already reachable
// on touch through its own opener button, so it needs no duplicate here.)
const makePauseButton = (onPause: (paused: boolean) => void) => {
  const paused = van.state(false);
  return button(
    {
      type: "button",
      "aria-label": () => (paused.val ? "Resume" : "Pause"),
      "aria-pressed": () => String(paused.val),
      class:
        "hud-mobile-pause flex h-10 w-10 items-center justify-center rounded-full border border-[#3fd8ff]/35 bg-[#040a0e]/75 text-[16px] text-[#cfeee2] backdrop-blur-[4px] [touch-action:manipulation] active:bg-[#3fd8ff]/20",
      onclick: () => {
        paused.val = !paused.val;
        onPause(paused.val);
      },
    },
    () => (paused.val ? "▶" : "⏸"),
  );
};

export const mountMobileControls = (opts: MobileControlsOpts) => {
  if (!isTouchPrimary()) return;
  const { controlledShip, onKeys, onAction, onCycle, onPause } = opts;
  const keys: Keys = {
    up: false,
    down: false,
    left: false,
    right: false,
    space: false,
  };
  const emit = () => onKeys({ ...keys });

  const abilityPad = div(
    { class: "grid grid-cols-3 gap-1.5" },
    ...ABILITIES.filter((a) => a.id !== 8 || WHIP_ENABLED).map((a) =>
      abilityButton(a, onAction),
    ),
  );
  const rightCluster = div(
    { class: "flex flex-col items-end gap-2" },
    cycleButton(onCycle),
    abilityPad,
    makeFire(keys, emit),
  );

  const root = div(
    {
      class: () =>
        `pointer-events-none fixed inset-x-0 z-40 flex items-end justify-between gap-4 px-4 ${controlledShip.val ? "flex" : "hidden"}`,
      // Sit above the home-indicator; the class carries the anchoring so CSS can
      // fold in safe-area insets.
      style: "bottom:0",
      "data-mobile-controls": "1",
    },
    makeStick(keys, emit),
    rightCluster,
  );
  van.add(document.body, root);
  // Always-on pause toggle (top-left, under the codex opener), independent of
  // the piloting HUD so it's reachable while spectating and while piloting.
  van.add(document.body, makePauseButton(onPause));

  // Piloting flag drives the "cockpit mode" CSS that clears rival chrome, and
  // guarantees keys don't stick when control is dropped mid-press.
  van.derive(() => {
    const on = controlledShip.val !== null;
    document.body.dataset.piloting = on ? "1" : "0";
    if (
      !on &&
      (keys.up || keys.down || keys.left || keys.right || keys.space)
    ) {
      keys.up = keys.down = keys.left = keys.right = keys.space = false;
      emit();
    }
  });
};
