// Welcome / title screen. Pure DOM chrome — it owns NO canvas. The living
// backdrop is the real WebGPU scene (a curated attract-mode match: fleets
// flocking around a glowing centre pad, our stand-in for the Jovian core),
// framed by the cinematic camera in bloom.wgsl's `fs_composite`.
//
// Two concerns share this module: the rAF camera director (eases the
// `CameraView` — push-in on load, calm drift while idle, quick push-in on
// launch) and the splash overlay. The director stays plain imperative TS; it
// never touches React or the DOM. The overlay is a React `<Splash>` mounted
// into its own body container (non-dialog idiom — this isn't a modal).

import type { CSSProperties } from "react";
import { forwardRef, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { AstryxRoot } from "~/astryx";
import { clamp01, lerp } from "~/engine/physics";
import { CAMERA_IDENTITY, type CameraView } from "~/render/gpu";
import { trapTab } from "./a11y";

const CYAN = "#3fd8ff";
const MINT = "#e6fbf1";
// Pixel-art display face for the wordmark; mono for legible body/HUD text.
const PIXEL = `"Press Start 2P", ui-monospace, monospace`;
const MONO = "ui-monospace,'SF Mono',Menlo,monospace";

// The entry path the player chose on the title screen.
export type WelcomeMode = "arcade" | "autobattle";

export interface Welcome {
  // Mutated in place each frame; the render loop reads it to feed the
  // composite camera. Holds the identity view once the splash is dismissed.
  readonly camera: CameraView;
  // Resolves to the chosen mode when the player launches — the moment to
  // reveal the arcade lobby (arcade) or the autobattle setup screen.
  readonly begun: Promise<WelcomeMode>;
}

const reduceMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const easeOutCubic = (k: number) => 1 - (1 - k) ** 3;
const easeInCubic = (k: number) => k * k * k;

// Camera framings. Zoom > 1 magnifies (push in); focus is the held point in uv.
const ENTER_ZOOM = 1.34; // where the load push-in starts
const IDLE_ZOOM = 1.16; // the resting frame, gently breathing
const LAUNCH_ZOOM = 1.72; // the whoosh as we dive into the match
const ENTER_MS = 2200;
const LAUNCH_MS = 720;

// --- Splash DOM -----------------------------------------------------------

// Jovian wordmark in the pixel face: one span per glyph so we can stagger the
// reveal. A hard offset plus a soft cyan bloom echoes the GPU bloom so the
// type and the scene share one light.
const WORDMARK_LETTERS = [..."GANYMEDE"];

const Wordmark = ({
  lettersRef,
}: {
  lettersRef: React.MutableRefObject<(HTMLSpanElement | null)[]>;
}) => (
  <h1
    style={{
      margin: 0,
      fontFamily: PIXEL,
      fontWeight: 400,
      letterSpacing: ".02em",
      lineHeight: 1.35,
      fontSize: "clamp(1.35rem,5.6vw,4.25rem)",
      perspective: "700px",
      perspectiveOrigin: "50% 30%",
    }}
  >
    {WORDMARK_LETTERS.map((ch, i) => (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static wordmark, index is stable
        key={i}
        ref={(el) => {
          lettersRef.current[i] = el;
        }}
        style={{
          display: "inline-block",
          color: MINT,
          transformOrigin: "50% 0",
          transformStyle: "preserve-3d",
          backfaceVisibility: "hidden",
          textShadow:
            "3px 3px 0 rgba(63,216,255,.16),0 0 26px rgba(63,216,255,.42)",
        }}
      >
        {ch}
      </span>
    ))}
  </h1>
);

const Hairline = () => (
  <div
    style={{
      width: "min(340px,60vw)",
      height: "1px",
      margin: "0 auto",
      background: `linear-gradient(90deg,transparent,${CYAN}88,transparent)`,
    }}
  />
);

// One absolutely-positioned label pinned to a screen corner.
const CornerTag = ({ pos, text }: { pos: CSSProperties; text: string }) => (
  <div
    style={{
      position: "absolute",
      ...pos,
      fontSize: "10px",
      letterSpacing: ".28em",
      textTransform: "uppercase",
      color: "#6fb7a6",
      opacity: 0.7,
      fontFamily: MONO,
    }}
  >
    {text}
  </div>
);

// "LIVE SIMULATION" badge — tells the player the backdrop is the actual game.
const LiveBadge = () => (
  <div
    style={{
      position: "absolute",
      top: "24px",
      left: "24px",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      fontSize: "10px",
      letterSpacing: ".28em",
      textTransform: "uppercase",
      color: "#8fe6ff",
      fontFamily: MONO,
    }}
  >
    <span
      style={{
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: CYAN,
        boxShadow: `0 0 10px ${CYAN}`,
      }}
    />
    live simulation
  </div>
);

// One mode CTA. The primary (arcade) one is filled brighter; the secondary
// (autobattle) reads as a quieter alternative beside it.
const CtaButton = ({
  text,
  primary,
  onClick,
  btnRef,
}: {
  text: string;
  primary: boolean;
  onClick: () => void;
  btnRef?: React.Ref<HTMLButtonElement>;
}) => {
  const rest = primary ? `${CYAN}22` : `${CYAN}10`;
  const hover = primary ? `${CYAN}3a` : `${CYAN}22`;
  return (
    <button
      ref={btnRef}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = hover;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = rest;
      }}
      style={{
        cursor: "pointer",
        border: `1px solid ${CYAN}${primary ? "aa" : "55"}`,
        background: rest,
        color: MINT,
        padding: "13px 30px",
        borderRadius: "12px",
        fontSize: "13px",
        fontWeight: 700,
        letterSpacing: ".2em",
        textTransform: "uppercase",
        fontFamily: MONO,
        transition: "background .18s",
        ...(primary ? {} : { opacity: 0.85 }),
      }}
    >
      {text}
    </button>
  );
};

// Two entry paths side by side: Arcade (primary) and Autobattle.
const CtaRow = ({
  onBegin,
  ctaRef,
  arcadeBtnRef,
}: {
  onBegin: (mode: WelcomeMode) => void;
  ctaRef: React.Ref<HTMLDivElement>;
  arcadeBtnRef: React.Ref<HTMLButtonElement>;
}) => (
  <div
    ref={ctaRef}
    style={{
      marginTop: "6px",
      display: "flex",
      gap: "14px",
      alignItems: "center",
      justifyContent: "center",
      flexWrap: "wrap",
    }}
  >
    <CtaButton
      text="Arcade"
      primary
      onClick={() => onBegin("arcade")}
      btnRef={arcadeBtnRef}
    />
    <CtaButton
      text="Autobattle"
      primary={false}
      onClick={() => onBegin("autobattle")}
    />
  </div>
);

const Label = ({ text, style }: { text: string; style: CSSProperties }) => (
  <p style={{ margin: 0, fontFamily: MONO, ...style }}>{text}</p>
);

// Half the clear zone kept around the screen centre, where the live scene's
// glowing centre pad (the Jovian core) shows through: the title sits just
// above it, the tagline/CTA just below, framing the star instead of covering
// it.
const CORE_GAP = "clamp(96px,16vh,168px)";

// Nearest git tag / commit, inlined by the prod bundler; "dev" under the dev
// server (see scripts/build.ts + globals.d.ts).
const BUILD_LABEL = `build ${typeof __BUILD__ === "string" ? __BUILD__ : "dev"}`;

// --- Entrance animation (WAAPI, skipped under reduced motion) --------------

const playEntrance = (letters: HTMLElement[], cta: HTMLElement) => {
  if (reduceMotion()) return;
  letters.forEach((l, i) => {
    // Each glyph tumbles down out of the dark on its top edge, overshoots past
    // flat, then settles — an arcade split-flap board dealing the title in.
    l.animate(
      [
        {
          opacity: 0,
          transform: "rotateX(-105deg) translateY(-0.35em) scale(1.35)",
          filter: "blur(5px)",
          offset: 0,
        },
        {
          opacity: 1,
          transform: "rotateX(18deg) translateY(0) scale(1)",
          filter: "blur(0)",
          offset: 0.68,
        },
        {
          opacity: 1,
          transform: "rotateX(-7deg)",
          offset: 0.86,
        },
        { opacity: 1, transform: "rotateX(0deg)", offset: 1 },
      ],
      {
        duration: 760,
        delay: 160 + i * 110,
        easing: "cubic-bezier(.34,1.4,.5,1)",
        fill: "backwards",
      },
    );
  });
  cta.animate(
    [
      { opacity: 0, transform: "translateY(10px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: 600, delay: 1180, easing: "ease-out", fill: "backwards" },
  );
  cta.animate(
    [
      { boxShadow: `0 0 0 0 ${CYAN}00` },
      { boxShadow: `0 0 22px 2px ${CYAN}3a` },
      { boxShadow: `0 0 0 0 ${CYAN}00` },
    ],
    {
      duration: 2600,
      delay: 1180,
      iterations: Number.POSITIVE_INFINITY,
      easing: "ease-in-out",
    },
  );
};

// --- Splash component -------------------------------------------------------

// Vignette + scrim: pull the eye to the type and lift it off the live scene
// without hiding the swarm. Cyan-tinted radial, not flat black.
const Scrim = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      background:
        "radial-gradient(120% 90% at 50% 46%,transparent 30%,rgba(4,7,10,.55) 78%,rgba(4,7,10,.86) 100%)",
    }}
  />
);

// Title block: kicker + wordmark, anchored so its base rests above the core.
const TopGroup = ({
  lettersRef,
}: {
  lettersRef: React.MutableRefObject<(HTMLSpanElement | null)[]>;
}) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      bottom: "50%",
      marginBottom: CORE_GAP,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: "18px",
      textAlign: "center",
      padding: "0 24px",
    }}
  >
    <Label
      text="▸ Jovian orbit · four-way war"
      style={{
        fontSize: "11px",
        letterSpacing: ".42em",
        textTransform: "uppercase",
        color: "#7fc4b1",
      }}
    />
    <Wordmark lettersRef={lettersRef} />
  </div>
);

// Everything below the core: divider, tagline, CTA, and the launch hint.
const BottomGroup = ({
  onBegin,
  ctaRef,
  arcadeBtnRef,
}: {
  onBegin: (mode: WelcomeMode) => void;
  ctaRef: React.Ref<HTMLDivElement>;
  arcadeBtnRef: React.Ref<HTMLButtonElement>;
}) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      top: "50%",
      marginTop: CORE_GAP,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "flex-start",
      gap: "18px",
      textAlign: "center",
      padding: "0 24px",
    }}
  >
    <Hairline />
    <Label
      text="Arcade — fly one ship, survive the waves. Autobattle — watch the war."
      style={{
        fontSize: "clamp(11px,1.6vw,14px)",
        letterSpacing: ".14em",
        color: "#a7d9cb",
      }}
    />
    <CtaRow onBegin={onBegin} ctaRef={ctaRef} arcadeBtnRef={arcadeBtnRef} />
    <Label
      text="choose your mode"
      style={{
        marginTop: "2px",
        fontSize: "10px",
        letterSpacing: ".24em",
        textTransform: "uppercase",
        color: "#5f9e8f",
      }}
    />
  </div>
);

interface SplashProps {
  onBegin: (mode: WelcomeMode) => void;
}

// Run the once-on-mount entrance: focus the primary button, then play the
// letter/CTA reveal animation.
const useSplashEntrance = (
  lettersRef: React.MutableRefObject<(HTMLSpanElement | null)[]>,
  ctaRef: React.RefObject<HTMLDivElement | null>,
  arcadeBtnRef: React.RefObject<HTMLButtonElement | null>,
) => {
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount only; refs are stable identities.
  useEffect(() => {
    // Land focus on the primary (Arcade) button; Enter/Space then activate
    // it natively, so no global key hijack is needed.
    queueMicrotask(() => arcadeBtnRef.current?.focus());
    const letters = lettersRef.current.filter(
      (el): el is HTMLSpanElement => el !== null,
    );
    if (ctaRef.current) playEntrance(letters, ctaRef.current);
  }, []);
};

// Full overlay tree. `ref` exposes the root node so `mountWelcome` can drive
// the launch fade/scale WAAPI animation on it (mirrors the old direct-`root`
// closure). Entrance animation + initial focus run once on mount.
const Splash = forwardRef<HTMLDivElement, SplashProps>(({ onBegin }, ref) => {
  const lettersRef = useRef<(HTMLSpanElement | null)[]>([]);
  const ctaRef = useRef<HTMLDivElement>(null);
  const arcadeBtnRef = useRef<HTMLButtonElement>(null);
  useSplashEntrance(lettersRef, ctaRef, arcadeBtnRef);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Ganymede — welcome"
      tabIndex={-1}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        overflow: "hidden",
        cursor: "pointer",
        color: MINT,
      }}
      onKeyDown={(e) => trapTab(e.currentTarget, e.nativeEvent)}
    >
      <Scrim />
      <LiveBadge />
      <CornerTag pos={{ bottom: "22px", left: "24px" }} text={BUILD_LABEL} />
      <CornerTag
        pos={{ bottom: "22px", right: "24px" }}
        text="webgpu · typegpu"
      />
      <TopGroup lettersRef={lettersRef} />
      <BottomGroup
        onBegin={onBegin}
        ctaRef={ctaRef}
        arcadeBtnRef={arcadeBtnRef}
      />
    </div>
  );
});

// --- Camera director --------------------------------------------------------
// Each phase is a small pure-ish mutator over the shared `camera`, kept
// separate so the per-frame `tick` stays a flat dispatch.

// Load push-in: ease from the wide framing to the resting one. Returns true
// once the entrance is complete.
const applyEnter = (
  cam: CameraView,
  elapsedMs: number,
  parX: number,
  parY: number,
): boolean => {
  const k = easeOutCubic(clamp01(elapsedMs / ENTER_MS));
  cam.zoom = lerp(ENTER_ZOOM, IDLE_ZOOM, k);
  cam.fx = lerp(0.5, parX, k);
  cam.fy = lerp(0.5, parY, k);
  return k >= 1;
};

// Resting life: breathing zoom, a lazy lissajous drift toward the cursor, a
// hair of roll.
const applyIdle = (cam: CameraView, t: number, parX: number, parY: number) => {
  cam.zoom = IDLE_ZOOM + 0.02 * Math.sin(t * 0.5);
  cam.fx += (parX + 0.014 * Math.sin(t * 0.37) - cam.fx) * 0.045;
  cam.fy += (parY + 0.011 * Math.cos(t * 0.29) - cam.fy) * 0.045;
  cam.rot = 0.008 * Math.sin(t * 0.23);
};

// Launch dive: push zoom and recentre fast, easing in.
const applyLaunch = (cam: CameraView, from: CameraView, elapsedMs: number) => {
  const k = easeInCubic(clamp01(elapsedMs / LAUNCH_MS));
  cam.zoom = lerp(from.zoom, LAUNCH_ZOOM, k);
  cam.fx = lerp(from.fx, 0.5, k);
  cam.fy = lerp(from.fy, 0.5, k);
  cam.rot = lerp(from.rot, 0, k);
};

type Phase = "enter" | "idle" | "launch" | "done";

interface Director {
  readonly camera: CameraView;
  begin(): void;
  stop(): void;
}

type Point = { x: number; y: number };

// Pointer parallax: nudge the focus a hair toward the cursor for a sense of
// depth.
const onPointerMoveFor = (pointer: Point) => (e: PointerEvent) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
};

const createCameraDirector = (reduce: boolean): Director => {
  const pointer = { x: 0, y: 0 };
  const onPointerMove = onPointerMoveFor(pointer);
  const camera: CameraView = {
    fx: 0.5,
    fy: 0.5,
    zoom: reduce ? IDLE_ZOOM : ENTER_ZOOM,
    rot: 0,
  };
  window.addEventListener("pointermove", onPointerMove);

  let phase: Phase = reduce ? "idle" : "enter";
  const t0 = performance.now();
  let launchT0 = 0;
  const launchFrom: CameraView = { ...camera };
  let raf = 0;

  // Advance one frame of whichever phase is active, returning the next phase.
  function stepPhase(p: Phase, now: number, parX: number, parY: number): Phase {
    switch (p) {
      case "enter":
        return applyEnter(camera, now - t0, parX, parY) ? "idle" : "enter";
      case "idle":
        applyIdle(camera, (now - t0) / 1000, parX, parY);
        return "idle";
      case "launch":
        applyLaunch(camera, launchFrom, now - launchT0);
        break;
    }
    return p;
  }

  const tick = (now: number) => {
    phase = stepPhase(
      phase,
      now,
      0.5 + pointer.x * 0.03,
      0.5 + pointer.y * 0.022,
    );
    if (phase !== "done") raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    camera,
    begin() {
      Object.assign(launchFrom, camera);
      launchT0 = performance.now();
      phase = "launch";
    },
    stop() {
      phase = "done";
      Object.assign(camera, CAMERA_IDENTITY); // hand the game a clean frame
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
    },
  };
};

// --- Public entry ------------------------------------------------------------

export const mountWelcome = (): Welcome => {
  const reduce = reduceMotion();
  const director = createCameraDirector(reduce);

  let resolveBegun: (mode: WelcomeMode) => void = () => {};
  const begun = new Promise<WelcomeMode>((res) => {
    resolveBegun = res;
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  // Plain ref object (not a hook — we're outside a component): React accepts
  // any object shaped `{ current }` as a ref target.
  const splashRef: { current: HTMLDivElement | null } = { current: null };

  let dismissed = false;
  const finish = (mode: WelcomeMode) => {
    director.stop();
    reactRoot.unmount();
    container.remove();
    resolveBegun(mode);
  };
  const begin = (mode: WelcomeMode) => {
    if (dismissed) return;
    dismissed = true;
    director.begin();
    const root = splashRef.current;
    if (reduce || !root) return finish(mode);
    // Fade + scale the chrome out while the camera dives in; reveal on finish.
    const anim = root.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(1.06)" },
      ],
      {
        duration: LAUNCH_MS,
        easing: "cubic-bezier(.5,0,.75,0)",
        fill: "forwards",
      },
    );
    anim.onfinish = () => finish(mode);
    anim.oncancel = () => finish(mode);
  };

  reactRoot.render(
    <AstryxRoot>
      <Splash ref={splashRef} onBegin={begin} />
    </AstryxRoot>,
  );

  return { camera: director.camera, begun };
};
