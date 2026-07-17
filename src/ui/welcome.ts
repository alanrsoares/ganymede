// Welcome / title screen. Pure DOM chrome — it owns NO canvas. The living
// backdrop is the real WebGPU scene (a curated attract-mode match: fleets
// flocking around the glowing centre pad, our stand-in for the Jovian core),
// framed by the cinematic camera in bloom.wgsl `fs_composite`.
//
// This module is the camera director + the splash overlay: it eases a
// `CameraView` (push-in on load, calm drift while idle, a quick push-in on
// launch) and hands off to the setup screen. It never touches the sim.

import van from "vanjs-core";
import { clamp01, lerp } from "~/engine/physics";
import { CAMERA_IDENTITY, type CameraView } from "~/render/gpu";
import { trapTab } from "./a11y";

const CYAN = "#3fd8ff";
const MINT = "#e6fbf1";
// Pixel-art display face for the wordmark; mono for legible body/HUD text.
const PIXEL = `"Press Start 2P", ui-monospace, monospace`;
const MONO = "ui-monospace,'SF Mono',Menlo,monospace";
const { div, h1, p, span, button } = van.tags;

// Which entry path the player chose from the title screen.
export type WelcomeMode = "arcade" | "autobattle";

export interface Welcome {
  // Mutated in place every frame; the render loop reads it and feeds the
  // composite camera. Holds identity once the splash is dismissed.
  readonly camera: CameraView;
  // Resolves with the chosen mode when the player launches — the moment to
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

// --- Splash DOM ---------------------------------------------------------------

// The Jovian wordmark in the pixel face: one span per glyph so we can stagger
// the reveal. A hard offset plus a soft cyan bloom echoes the GPU bloom so the
// type and the scene share one light.
const wordmark = (): { el: HTMLElement; letters: HTMLElement[] } => {
  const letters = [..."GANYMEDE"].map((ch) =>
    span(
      {
        style:
          `display:inline-block;color:${MINT};transform-origin:50% 0;` +
          "transform-style:preserve-3d;backface-visibility:hidden;" +
          "text-shadow:3px 3px 0 rgba(63,216,255,.16),0 0 26px rgba(63,216,255,.42);",
      },
      ch,
    ),
  );
  const el = h1(
    {
      style:
        `margin:0;font-family:${PIXEL};font-weight:400;letter-spacing:.02em;` +
        "line-height:1.35;font-size:clamp(1.35rem,5.6vw,4.25rem);" +
        "perspective:700px;perspective-origin:50% 30%;",
    },
    ...letters,
  );
  return { el, letters };
};

const hairline = () =>
  div({
    style: `width:min(340px,60vw);height:1px;margin:0 auto;background:linear-gradient(90deg,transparent,${CYAN}88,transparent);`,
  });

const cornerTag = (corner: string, text: string) =>
  div(
    {
      style:
        `position:absolute;${corner};font-size:10px;letter-spacing:.28em;` +
        `text-transform:uppercase;color:#6fb7a6;opacity:.7;font-family:${MONO};`,
    },
    text,
  );

// "LIVE SIMULATION" badge — tells the player the backdrop is the actual game.
const liveBadge = () =>
  div(
    {
      style:
        "position:absolute;top:24px;left:24px;display:flex;align-items:center;gap:8px;" +
        `font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:#8fe6ff;font-family:${MONO};`,
    },
    span({
      style: `width:7px;height:7px;border-radius:50%;background:${CYAN};box-shadow:0 0 10px ${CYAN};`,
    }),
    "live simulation",
  );

// One mode CTA. The primary (arcade) is filled brighter; the secondary
// (autobattle) reads as a quieter alternative beside it.
const ctaButton = (
  text: string,
  onBegin: () => void,
  primary: boolean,
): HTMLButtonElement => {
  const rest = primary ? `${CYAN}22` : `${CYAN}10`;
  const hover = primary ? `${CYAN}3a` : `${CYAN}22`;
  return button(
    {
      type: "button",
      onclick: (e: Event) => {
        e.stopPropagation();
        onBegin();
      },
      style:
        `cursor:pointer;border:1px solid ${CYAN}${primary ? "aa" : "55"};background:${rest};` +
        `color:${MINT};padding:13px 30px;border-radius:12px;font-size:13px;font-weight:700;` +
        `letter-spacing:.2em;text-transform:uppercase;font-family:${MONO};transition:background .18s;` +
        (primary ? "" : "opacity:.85;"),
      onmouseenter: (e: Event) => {
        (e.target as HTMLElement).style.background = hover;
      },
      onmouseleave: (e: Event) => {
        (e.target as HTMLElement).style.background = rest;
      },
    },
    text,
  ) as HTMLButtonElement;
};

// The two entry paths side by side: Arcade (primary) and Autobattle.
const ctaRow = (
  onBegin: (mode: WelcomeMode) => void,
): { row: HTMLElement; buttons: HTMLElement[] } => {
  const arcade = ctaButton("Arcade", () => onBegin("arcade"), true);
  const auto = ctaButton("Autobattle", () => onBegin("autobattle"), false);
  const row = div(
    {
      style:
        "margin-top:6px;display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;",
    },
    arcade,
    auto,
  );
  return { row, buttons: [arcade, auto] };
};

const label = (text: string, extra: string) =>
  p({ style: `margin:0;font-family:${MONO};${extra}` }, text);

// Half of the clear zone kept around the screen centre, where the live scene's
// glowing centre pad (the Jovian core) shows through: the title sits just above
// it, the tagline/CTA just below, framing the star instead of covering it.
const CORE_GAP = "clamp(96px,16vh,168px)";

// Nearest git tag / commit, inlined by the prod bundler; "dev" under the dev
// server (see scripts/build.ts + globals.d.ts).
const BUILD_LABEL = `build ${typeof __BUILD__ === "string" ? __BUILD__ : "dev"}`;

// Build the full overlay tree; returns the nodes the animator needs to drive.
const buildOverlay = (onBegin: (mode: WelcomeMode) => void) => {
  const { el: mark, letters } = wordmark();
  const { row: cta, buttons } = ctaRow(onBegin);

  // Title block: kicker + wordmark, anchored so its base rests above the core.
  const topGroup = div(
    {
      style:
        "position:absolute;left:0;right:0;bottom:50%;" +
        `margin-bottom:${CORE_GAP};` +
        "display:flex;flex-direction:column;align-items:center;" +
        "justify-content:flex-end;gap:18px;text-align:center;padding:0 24px;",
    },
    label(
      "▸ Jovian orbit · four-way war",
      "font-size:11px;letter-spacing:.42em;text-transform:uppercase;color:#7fc4b1;",
    ),
    mark,
  );

  // Everything below the core: divider, tagline, CTA, and the launch hint.
  const bottomGroup = div(
    {
      style:
        "position:absolute;left:0;right:0;top:50%;" +
        `margin-top:${CORE_GAP};` +
        "display:flex;flex-direction:column;align-items:center;" +
        "justify-content:flex-start;gap:18px;text-align:center;padding:0 24px;",
    },
    hairline(),
    label(
      "Arcade — fly one ship, survive the waves. Autobattle — watch the war.",
      "font-size:clamp(11px,1.6vw,14px);letter-spacing:.14em;color:#a7d9cb;",
    ),
    cta,
    label(
      "choose your mode",
      "margin-top:2px;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#5f9e8f;",
    ),
  );

  // Vignette + scrim: pull the eye to the type and lift it off the live scene
  // without hiding the swarm. Cyan-tinted radial, not flat black.
  const scrim = div({
    style:
      "position:absolute;inset:0;pointer-events:none;" +
      "background:radial-gradient(120% 90% at 50% 46%,transparent 30%,rgba(4,7,10,.55) 78%,rgba(4,7,10,.86) 100%);",
  });

  const root = div(
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Ganymede — welcome",
      tabindex: "-1",
      style: `position:absolute;inset:0;z-index:50;overflow:hidden;cursor:pointer;color:${MINT};`,
      onkeydown: (e: KeyboardEvent) => trapTab(root as HTMLElement, e),
    },
    scrim,
    liveBadge(),
    cornerTag("bottom:22px;left:24px", BUILD_LABEL),
    cornerTag("bottom:22px;right:24px", "webgpu · typegpu"),
    topGroup,
    bottomGroup,
  ) as HTMLElement;

  return { root, letters, cta, buttons };
};

// --- Entrance animation (WAAPI, skipped under reduced motion) -----------------

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

// --- Camera director ----------------------------------------------------------
// Each phase is a small pure-ish mutator of the shared `camera`, kept separate
// so the per-frame `tick` stays a flat dispatch.

// Load push-in: ease from the wide framing to the resting one. Returns true once
// the entrance is complete.
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

// Resting life: a breathing zoom, a lazy lissajous drift toward the cursor, and
// a hair of roll.
const applyIdle = (cam: CameraView, t: number, parX: number, parY: number) => {
  cam.zoom = IDLE_ZOOM + 0.02 * Math.sin(t * 0.5);
  cam.fx += (parX + 0.014 * Math.sin(t * 0.37) - cam.fx) * 0.045;
  cam.fy += (parY + 0.011 * Math.cos(t * 0.29) - cam.fy) * 0.045;
  cam.rot = 0.008 * Math.sin(t * 0.23);
};

// Launch dive: push hard toward the centre as the chrome fades out.
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

// Pointer parallax: nudge focus a hair toward the cursor for a sense of depth.
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

// --- Public entry -------------------------------------------------------------

export const mountWelcome = (): Welcome => {
  const reduce = reduceMotion();
  const director = createCameraDirector(reduce);

  let resolveBegun: (mode: WelcomeMode) => void = () => {};
  const begun = new Promise<WelcomeMode>((res) => {
    resolveBegun = res;
  });

  let dismissed = false;
  const finish = (mode: WelcomeMode) => {
    director.stop();
    root.remove();
    resolveBegun(mode);
  };
  const begin = (mode: WelcomeMode) => {
    if (dismissed) return;
    dismissed = true;
    director.begin();
    if (reduce) return finish(mode);
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

  const { root, letters, cta, buttons } = buildOverlay(begin);
  van.add(document.body, root);
  // Land focus on the primary (Arcade) button; Enter/Space then activate it
  // natively, so no global key hijack is needed.
  queueMicrotask(() => buttons[0].focus());
  playEntrance(letters, cta);

  return { camera: director.camera, begun };
};
