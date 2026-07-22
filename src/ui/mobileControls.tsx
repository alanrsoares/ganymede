// On-screen touch controls: a left virtual stick that drives the ship's
// direction vector, a right fire button, and an ability pad — the touch
// equivalent of WASD / Space / keys 1-7. Mounted only on touch-primary devices
// and shown only while a ship is under control (arcade always, autobattle when
// a hull is tapped). Pure view: it emits the same `controlKeys`/`action` intent
// the keyboard path does, so the sim stays oblivious to the input source.

import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { AstryxRoot } from "~/astryx";
import { type Signal, signal, useSignal } from "~/ui/signal";
import type { LightCycle } from "~/world";

// Live boolean set the stick + fire button write into; mirrors World.controlKeys.
export interface Keys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  space: boolean;
}

// Structural `.val` read cell: satisfied by both a legacy vanjs `State<T>`
// (today's `ui.ts`, which hasn't been ported off vanjs yet) and our own
// `Signal<T>` (from `~/ui/signal`, once `ui.ts` migrates). A plain vanjs
// `State` exposes no `subscribe`, so visibility below is polled once per
// frame rather than pushed — see the rAF loop in `MobileControls`.
export interface ValCell<T> {
  readonly val: T;
}

export interface MobileControlsOpts {
  controlledShip: ValCell<LightCycle | null>;
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

// Owns pointer capture on the stick base and rewrites the shared `keys` on
// every move, emitting only when the latched directions change. The knob's
// transform is written directly to the DOM (not through React state) so
// dragging never triggers a re-render, matching the original's imperative
// `knob.style.transform` writes.
const useStickDrag = (keys: Keys, emit: () => void) => {
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);

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

  const move = (e: { clientX: number; clientY: number }) => {
    const base = baseRef.current;
    const knob = knobRef.current;
    if (!base || !knob) return;
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
    if (knobRef.current) {
      knobRef.current.style.transform = "translate(-50%,-50%)";
    }
    setDirs(0, 0);
  };

  return { baseRef, knobRef, move, release };
};

const Stick = ({ keys, emit }: { keys: Keys; emit: () => void }) => {
  const { baseRef, knobRef, move, release } = useStickDrag(keys, emit);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: preserved verbatim from the original vanilla `aria-label`
    <div
      ref={baseRef}
      aria-label="Movement stick"
      className="pointer-events-auto relative rounded-full border border-signal/25 bg-deep/55 backdrop-blur-[3px] [touch-action:none]"
      style={{ width: STICK, height: STICK }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons || e.pointerType === "touch") move(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div
        ref={knobRef}
        className="absolute rounded-full border border-signal/70 bg-signal/25 shadow-[0_0_12px_#3fd8ff55]"
        style={{
          width: KNOB,
          height: KNOB,
          left: "50%",
          top: "50%",
          transform: "translate(-50%,-50%)",
          transition: "transform .05s linear",
        }}
      />
    </div>
  );
};

// Hold-to-fire button; sets `space` for the duration of the press.
const Fire = ({ keys, emit }: { keys: Keys; emit: () => void }) => {
  const press = (down: boolean) => {
    keys.space = down;
    emit();
  };
  return (
    <button
      type="button"
      aria-label="Fire"
      className="pointer-events-auto flex h-[92px] w-[92px] items-center justify-center rounded-full border border-[#ffd866]/70 bg-gold/20 text-[13px] font-bold uppercase tracking-[0.14em] text-gold-ink shadow-[0_0_16px_#ffb83f44] [touch-action:none] active:bg-gold/40"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        press(true);
      }}
      onPointerUp={() => press(false)}
      onPointerCancel={() => press(false)}
    >
      Fire
    </button>
  );
};

// One tap = one ability trigger (the sim gates cooldown/fuel itself).
const AbilityButton = ({
  ability,
  onAction,
}: {
  ability: { id: number; label: string; icon: string };
  onAction: (id: number) => void;
}) => (
  <button
    type="button"
    aria-label={ability.label}
    className="pointer-events-auto flex h-11 w-11 flex-col items-center justify-center rounded-lg border border-signal/35 bg-deep/70 text-mint-soft [touch-action:manipulation] active:bg-signal/20"
    onClick={() => onAction(ability.id)}
  >
    <span className="text-[15px] leading-none">{ability.icon}</span>
    <span className="mt-0.5 text-[7px] uppercase tracking-[0.08em] opacity-70">
      {ability.label}
    </span>
  </button>
);

// Cycle the fire lock to the next in-range enemy.
const CycleButton = ({ onCycle }: { onCycle: (dir: 1 | -1) => void }) => (
  <button
    type="button"
    aria-label="Cycle target"
    className="pointer-events-auto flex h-11 items-center justify-center gap-1 rounded-lg border border-[#ff6b6b]/45 bg-deep/70 px-3 text-[11px] uppercase tracking-[0.1em] text-[#ffb4b4] [touch-action:manipulation] active:bg-[#ff6b6b]/20"
    onClick={() => onCycle(1)}
  >
    <span className="text-[14px] leading-none">🎯</span>
    <span>Target</span>
  </button>
);

// Touch pause toggle — the sim has no other pause affordance and touch has no
// keyboard. Positioned top-left under the existing codex opener (`◈ Ships`) via
// the .hud-mobile-pause CSS hook, so it shares the safe-area column and never
// collides with the top-right status readout. (The codex is already reachable
// on touch through its own opener button, so it needs no duplicate here.)
const PauseButton = ({ onPause }: { onPause: (paused: boolean) => void }) => {
  const pausedRef = useRef<Signal<boolean> | null>(null);
  if (!pausedRef.current) pausedRef.current = signal(false);
  const paused = pausedRef.current;
  const isPaused = useSignal(paused);
  return (
    <button
      type="button"
      aria-label={isPaused ? "Resume" : "Pause"}
      aria-pressed={isPaused}
      className="hud-mobile-pause flex h-10 w-10 items-center justify-center rounded-full border border-signal/35 bg-deep/75 text-[16px] text-mint-soft backdrop-blur-[4px] [touch-action:manipulation] active:bg-signal/20"
      onClick={() => {
        paused.val = !paused.val;
        onPause(paused.val);
      }}
    >
      {isPaused ? "▶" : "⏸"}
    </button>
  );
};

// Piloting flag drives the "cockpit mode" CSS that clears rival chrome, and
// guarantees keys don't stick when control is dropped mid-press. Polled on a
// rAF loop rather than pushed: `controlledShip` is only a structural `.val`
// cell (see `ValCell`), since pre-T4 `ui.ts` still hands in a plain vanjs
// `State` with no `subscribe` hook. `frame.ts` writes it at most once per
// game frame, so a rAF poll is never more than a frame behind a true push.
const useVisibility = (
  controlledShip: ValCell<LightCycle | null>,
  keys: Keys,
  emit: () => void,
) => {
  const visibleRef = useRef<Signal<boolean> | null>(null);
  if (!visibleRef.current) visibleRef.current = signal(false);
  const visible = visibleRef.current;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const on = controlledShip.val !== null;
      visible.val = on;
      document.body.dataset.piloting = on ? "1" : "0";
      const anyKeyDown =
        keys.up || keys.down || keys.left || keys.right || keys.space;
      if (!on && anyKeyDown) {
        keys.up = keys.down = keys.left = keys.right = keys.space = false;
        emit();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [controlledShip, keys, emit, visible]);

  return useSignal(visible);
};

const MobileControls = ({
  controlledShip,
  onKeys,
  onAction,
  onCycle,
  onPause,
}: MobileControlsOpts) => {
  const keysRef = useRef<Keys>({
    up: false,
    down: false,
    left: false,
    right: false,
    space: false,
  });
  const keys = keysRef.current;
  const emit = () => onKeys({ ...keys });
  const on = useVisibility(controlledShip, keys, emit);

  return (
    <>
      <div
        className={`pointer-events-none fixed inset-x-0 z-40 flex items-end justify-between gap-4 px-4 ${on ? "flex" : "hidden"}`}
        style={{ bottom: 0 }}
        data-mobile-controls="1"
      >
        <Stick keys={keys} emit={emit} />
        <div className="flex flex-col items-end gap-2">
          <CycleButton onCycle={onCycle} />
          <div className="grid grid-cols-3 gap-1.5">
            {ABILITIES.map((a) => (
              <AbilityButton key={a.id} ability={a} onAction={onAction} />
            ))}
          </div>
          <Fire keys={keys} emit={emit} />
        </div>
      </div>
      <PauseButton onPause={onPause} />
    </>
  );
};

export const mountMobileControls = (opts: MobileControlsOpts) => {
  if (!isTouchPrimary()) return;
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <AstryxRoot>
      <MobileControls {...opts} />
    </AstryxRoot>,
  );
};
