// Object-relative transform gizmo for drydock design mode. The artwork lives
// in SVG for crisp labels and lines; HTML buttons sit on top for generous,
// keyboard-accessible hit targets.

import { partBounds, partRotMat } from "~/hull/bake";
import type { PartDef, V3 } from "~/hull/catalog";
import { inspectorPose, mulV, PANEL_CLEAR_PX, shipMat } from "./projection";
import {
  beginEdit,
  getVersion,
  hulls,
  pushUndo,
  sel,
  stopSpinForDrag,
  touchHull,
  view,
} from "./store";

const SVG_NS = "http://www.w3.org/2000/svg";
const AXES = [0, 1, 2] as const;
type Axis = (typeof AXES)[number];
type HandleKind =
  | "move-free"
  | `move-${Axis}`
  | `scale-${Axis}`
  | "scale-uniform";
type GizmoMode = "move" | "scale";

type Vec2 = { x: number; y: number };

interface AxisFrame {
  direction: Vec2;
  point: Vec2;
  boundary: Vec2;
  pixelsPerUnit: number;
}

interface GizmoFrame {
  pivot: Vec2;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  corners: Vec2[];
  freeBasis: { x: Vec2; y: Vec2 };
  moveAxes: Record<Axis, AxisFrame>;
  scaleAxes: Record<Axis, AxisFrame>;
  /** Uniform-scale grip, parked off the box corner clear of the axis handles. */
  uniform: Vec2;
}

interface DragState {
  button: HTMLButtonElement;
  kind: HandleKind;
  part: PartDef;
  startPointer: Vec2;
  startPos: V3;
  startScale: V3;
  frame: GizmoFrame;
  startDistance: number;
}

interface PartProjection {
  pivotLocal: V3;
  pivot: Vec2;
  localCorners: V3[];
  corners: Vec2[];
  box: GizmoFrame["box"];
  project: (local: V3) => Vec2;
  projectDirection: (local: V3) => Vec2;
}

const AXIS_LABELS: Record<Axis, string> = { 0: "x", 1: "y", 2: "z" };
/** Clearance between the part's projected surface and its scale handle, in px. */
const SCALE_HANDLE_GAP = 16;
/** Shortest usable lever arm: below this an axis is too edge-on to grab safely. */
const MIN_SCALE_ARM = 30;
/** Mode shortcuts, mirroring the rail buttons' `data-key` badges. */
const MODE_KEYS: Record<string, GizmoMode> = { w: "move", r: "scale" };
const GIZMO_AXIS_LENGTH = 58;
const AXIS_VECTORS: Record<Axis, V3> = {
  0: [1, 0, 0],
  1: [0, 1, 0],
  2: [0, 0, 1],
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Vec2, n: number): Vec2 => ({ x: a.x * n, y: a.y * n });
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const length = (a: Vec2): number => Math.hypot(a.x, a.y);
const unit = (a: Vec2): Vec2 => scale(a, 1 / Math.max(length(a), 1e-6));

const svg = <K extends keyof SVGElementTagNameMap>(
  tag: K,
): SVGElementTagNameMap[K] => document.createElementNS(SVG_NS, tag);

const attr = (node: Element, name: string, value: number | string): void => {
  node.setAttribute(name, String(value));
};

const point = (x: number, y: number): Vec2 => ({ x, y });

const cornersOf = (min: V3, max: V3): V3[] => [
  [min[0], min[1], min[2]],
  [max[0], min[1], min[2]],
  [min[0], max[1], min[2]],
  [max[0], max[1], min[2]],
  [min[0], min[1], max[2]],
  [max[0], min[1], max[2]],
  [min[0], max[1], max[2]],
  [max[0], max[1], max[2]],
];

const partPivot = (part: PartDef): V3 =>
  part.mirror ? [0, part.pos[1], part.pos[2]] : [...part.pos];

const setButtonPosition = (button: HTMLButtonElement, p: Vec2): void => {
  button.style.left = `${p.x}px`;
  button.style.top = `${p.y}px`;
};

const placeHandle = (
  handles: Map<HandleKind, HTMLButtonElement>,
  kind: HandleKind,
  position: Vec2,
): void => {
  const button = handles.get(kind);
  if (button) setButtonPosition(button, position);
};

const distanceFrom = (a: Vec2, b: Vec2): number => length(sub(a, b));

// Baking a part's triangles is far too costly to redo every animation frame,
// and the geometry only moves when the store version bumps.
let boundsCache: { version: number; part: PartDef; bounds: V3[] } | null = null;

/** Ship-local corners of the part's bounding box; the pivot alone if degenerate. */
const partCorners = (part: PartDef, pivotLocal: V3): V3[] => {
  const version = getVersion();
  if (boundsCache?.version === version && boundsCache.part === part) {
    return boundsCache.bounds;
  }
  const bounds = partBounds(part);
  const corners = bounds ? cornersOf(bounds.min, bounds.max) : [pivotLocal];
  boundsCache = { version, part, bounds: corners };
  return corners;
};

// The control deck's width varies with viewport and collapses on demand, so the
// label inset is measured rather than assumed. Throttled: the gizmo writes DOM
// every frame, and an unthrottled rect read after those writes forces a
// synchronous layout each time.
let panelClear = { px: PANEL_CLEAR_PX, at: Number.NEGATIVE_INFINITY };
const PANEL_REMEASURE_MS = 250;

const panelClearPx = (): number => {
  const now = performance.now();
  if (now - panelClear.at > PANEL_REMEASURE_MS) {
    const panel = document.querySelector(".panel-left");
    panelClear = {
      px: panel ? panel.getBoundingClientRect().right : PANEL_CLEAR_PX,
      at: now,
    };
  }
  return panelClear.px;
};

const projectPart = (
  canvas: HTMLCanvasElement,
  part: PartDef,
): PartProjection => {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const pose = inspectorPose(canvas.width, canvas.height);
  const shipRotation = shipMat(pose.heading, pose.tilt, pose.roll);
  const project = (local: V3): Vec2 => {
    const p = mulV(shipRotation, local);
    return point(
      (pose.cx + p[0] * pose.radius) / dpr,
      (pose.cy + p[1] * pose.radius) / dpr,
    );
  };
  const projectDirection = (local: V3): Vec2 => {
    const p = mulV(shipRotation, local);
    return point((p[0] * pose.radius) / dpr, (p[1] * pose.radius) / dpr);
  };

  const pivotLocal = partPivot(part);
  const pivot = project(pivotLocal);
  const localCorners = partCorners(part, pivotLocal);
  const corners = localCorners.map(project);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  // A degenerate part collapses to a single point; give it a nominal box so
  // the frame and mode rail still have somewhere to sit.
  const pad = corners.length > 1 ? 0 : 20;
  const box = {
    minX: Math.min(...xs) - pad,
    minY: Math.min(...ys) - pad,
    maxX: Math.max(...xs) + pad,
    maxY: Math.max(...ys) + pad,
  };
  return {
    pivotLocal,
    pivot,
    localCorners,
    corners,
    box,
    project,
    projectDirection,
  };
};

const makeAxisFrames = (
  part: PartDef,
  projection: PartProjection,
): Pick<GizmoFrame, "moveAxes" | "scaleAxes"> => {
  const { pivot, pivotLocal, localCorners, project, projectDirection } =
    projection;
  const moveAxes = {} as Record<Axis, AxisFrame>;
  for (const axis of AXES) {
    const screenAxis = projectDirection(AXIS_VECTORS[axis]);
    const direction = unit(screenAxis);
    const pixelsPerUnit = Math.max(length(screenAxis), 1);
    moveAxes[axis] = {
      direction,
      pixelsPerUnit,
      point: add(pivot, scale(direction, GIZMO_AXIS_LENGTH)),
      boundary: pivot,
    };
  }

  const partRotation = partRotMat(part.rot ?? [0, 0, 0]);
  const scaleAxes = {} as Record<Axis, AxisFrame>;
  for (const axis of AXES) {
    const localAxis = mulV(partRotation, AXIS_VECTORS[axis]);
    const screenAxis = projectDirection(localAxis);
    const direction = unit(screenAxis);
    const extent = Math.max(
      ...localCorners.map((corner) =>
        Math.abs(
          (corner[0] - pivotLocal[0]) * localAxis[0] +
            (corner[1] - pivotLocal[1]) * localAxis[1] +
            (corner[2] - pivotLocal[2]) * localAxis[2],
        ),
      ),
      0.05,
    );
    const boundary = project([
      pivotLocal[0] + localAxis[0] * extent,
      pivotLocal[1] + localAxis[1] * extent,
      pivotLocal[2] + localAxis[2] * extent,
    ]);
    // Sit the handle on the part's own surface, just clear of it, so the thing
    // you grab is the face you are resizing. An edge-on axis projects to almost
    // nothing, so fall back to a fixed arm to keep it grabbable.
    const arm = length(sub(boundary, pivot));
    const point =
      arm >= MIN_SCALE_ARM
        ? add(boundary, scale(direction, SCALE_HANDLE_GAP))
        : add(pivot, scale(direction, MIN_SCALE_ARM));
    scaleAxes[axis] = {
      direction,
      pixelsPerUnit: Math.max(
        arm / Math.max(Math.abs(part.scale[axis]), 0.02),
        4,
      ),
      boundary,
      point,
    };
  }

  return { moveAxes, scaleAxes };
};

const projectFrame = (canvas: HTMLCanvasElement, part: PartDef): GizmoFrame => {
  const projection = projectPart(canvas, part);
  const { moveAxes, scaleAxes } = makeAxisFrames(part, projection);
  return {
    pivot: projection.pivot,
    box: projection.box,
    corners: projection.corners,
    freeBasis: {
      x: projection.projectDirection([1, 0, 0]),
      y: projection.projectDirection([0, 1, 0]),
    },
    moveAxes,
    scaleAxes,
    uniform: point(projection.box.maxX + 14, projection.box.maxY + 14),
  };
};

const pointer = (event: PointerEvent): Vec2 =>
  point(event.clientX, event.clientY);

const isHandleTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest(".drydock-gizmo__handle") !== null;

/** Bare w/r switch mode; any modifier means the key belongs to someone else. */
const modeFromKey = (event: KeyboardEvent): GizmoMode | undefined =>
  event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    ? undefined
    : MODE_KEYS[event.key.toLowerCase()];

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches("input, textarea, select") || target.isContentEditable);

/**
 * Turn a screen-pixel delta into hull-local (dx, dy) through the projected hull
 * x/y basis. Null when the basis is degenerate — the hull is edge-on, so screen
 * motion has no unique preimage in the hull plane.
 */
const solveScreenDelta = (
  basis: GizmoFrame["freeBasis"],
  delta: Vec2,
): { dx: number; dy: number } | null => {
  const { x: ax, y: ay } = basis;
  const determinant = ax.x * ay.y - ax.y * ay.x;
  if (Math.abs(determinant) < 1e-4) return null;
  return {
    dx: (delta.x * ay.y - delta.y * ay.x) / determinant,
    dy: (ax.x * delta.y - ax.y * delta.x) / determinant,
  };
};

const updateFromDrag = (drag: DragState, current: Vec2): void => {
  const delta = sub(current, drag.startPointer);
  const { part, startPos, startScale, frame, kind } = drag;
  if (kind === "move-free") {
    const solved = solveScreenDelta(frame.freeBasis, delta);
    if (!solved) return;
    part.pos[0] = clamp(startPos[0] + solved.dx, -1.6, 1.6);
    part.pos[1] = clamp(startPos[1] + solved.dy, -1.6, 1.6);
    return;
  }
  if (kind === "scale-uniform") {
    const startDistance = Math.max(drag.startDistance, 10);
    const factor = clamp(
      distanceFrom(current, frame.pivot) / startDistance,
      0.2,
      5,
    );
    for (const axis of AXES) {
      part.scale[axis] = clamp(startScale[axis] * factor, 0.02, 2.5);
    }
    return;
  }
  const [mode, axisValue] = kind.split("-");
  const axis = Number(axisValue) as Axis;
  if (mode === "move") {
    const axisFrame = frame.moveAxes[axis];
    part.pos[axis] = clamp(
      startPos[axis] +
        dot(delta, axisFrame.direction) / axisFrame.pixelsPerUnit,
      -1.6,
      1.6,
    );
    return;
  }
  // Scale by the ratio of lever arms, so the grabbed face tracks the cursor
  // instead of drifting away from it: the same gesture means the same
  // proportional change at any zoom, orbit angle or part size.
  const axisFrame = frame.scaleAxes[axis];
  const startArm = dot(
    sub(drag.startPointer, frame.pivot),
    axisFrame.direction,
  );
  if (Math.abs(startArm) < MIN_SCALE_ARM / 2) return; // grabbed too near the pivot
  const nowArm = dot(sub(current, frame.pivot), axisFrame.direction);
  part.scale[axis] = clamp(startScale[axis] * (nowArm / startArm), 0.02, 2.5);
};

/** The slice of a key event the focused-handle nudge reads. */
type HandleNudgeEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
>;

const stepFromKey = (event: HandleNudgeEvent): number =>
  event.shiftKey ? 0.1 : 0.01;

const isNudgeKey = (key: string): boolean =>
  key.startsWith("Arrow") || key === "+" || key === "-";

const nudgePartFromKey = (
  kind: HandleKind,
  event: HandleNudgeEvent,
): boolean => {
  if (!isNudgeKey(event.key) || kind === "move-free") return false;
  // Alt combos belong to the screen-plane path, focused handle or not.
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const part = hulls[view.cls].parts[sel.part];
  if (!part) return false;
  const axisValue = Number(kind.split("-")[1]);
  if (!Number.isInteger(axisValue)) return false;
  const axis = axisValue as Axis;
  const direction =
    event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "-"
      ? -1
      : 1;
  // Coalescing collapses a held arrow — and a burst of taps — into one step.
  beginEdit(`${kind.split("-")[0]} part ${sel.part}`);
  const step = direction * stepFromKey(event);
  if (kind.startsWith("move-")) {
    part.pos[axis] = clamp(part.pos[axis] + step, -1.6, 1.6);
  } else {
    part.scale[axis] = clamp(part.scale[axis] + step, 0.02, 2.5);
  }
  touchHull();
  return true;
};

/**
 * A keypress expressed as the screen-pixel delta an equivalent drag would
 * produce. Routing it through the projected basis is what makes ↑ move the part
 * visually up at any orbit yaw, tilt or bank — no sign-flip guesswork, and the
 * keyboard can never disagree with a free drag. Screen y grows downward.
 */
const NUDGE_PX = 2;
const SCREEN_STEPS: Record<string, Vec2> = {
  ArrowLeft: { x: -NUDGE_PX, y: 0 },
  ArrowRight: { x: NUDGE_PX, y: 0 },
  ArrowUp: { x: 0, y: -NUDGE_PX },
  ArrowDown: { x: 0, y: NUDGE_PX },
};
/**
 * z moves in hull units, not pixels: edge-on, the z axis projects to almost
 * nothing and `pixelsPerUnit` floors at 1, so a pixel step would fling the part
 * across the hull.
 */
const NUDGE_Z = 0.01;

/**
 * Shift+Arrow moves the selected part in the hull's screen plane;
 * Shift+Alt+Up/Down moves it along hull z. Auto-repeat is the accelerator —
 * there is no coarse tier, since Shift is the trigger and Alt is taken.
 * Returns false to decline, leaving the event untouched.
 */
const nudgeInScreenPlane = (
  frame: GizmoFrame | null,
  event: KeyboardEvent,
): boolean => {
  if (!event.shiftKey || event.metaKey || event.ctrlKey) return false;
  const step = SCREEN_STEPS[event.key];
  if (!step) return false;
  const part = hulls[view.cls].parts[sel.part];
  if (!part) return false;

  if (event.altKey) {
    if (step.y === 0) return false; // left/right has no depth meaning
    beginEdit(`nudge part ${sel.part}`);
    // Screen-up (negative y) reads as "toward the viewer" — positive hull z.
    part.pos[2] = clamp(part.pos[2] - Math.sign(step.y) * NUDGE_Z, -1.6, 1.6);
    touchHull();
    return true;
  }

  if (!frame) return false;
  const solved = solveScreenDelta(frame.freeBasis, step);
  if (!solved) return false; // hull is edge-on
  beginEdit(`nudge part ${sel.part}`);
  part.pos[0] = clamp(part.pos[0] + solved.dx, -1.6, 1.6);
  part.pos[1] = clamp(part.pos[1] + solved.dy, -1.6, 1.6);
  touchHull();
  return true;
};

export interface GizmoOverlay {
  update: (canvas: HTMLCanvasElement) => void;
  destroy: () => void;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one gizmo owns its DOM, pointer wiring, and render loop
export const createGizmoOverlay = (): GizmoOverlay => {
  const layer = document.createElement("div");
  layer.className = "drydock-gizmo";
  layer.setAttribute("aria-hidden", "true");

  const artwork = svg("svg");
  artwork.classList.add("drydock-gizmo__artwork");
  artwork.setAttribute("aria-hidden", "true");
  layer.append(artwork);

  const frame = svg("rect");
  frame.classList.add("drydock-gizmo__frame");
  artwork.append(frame);
  const caption = svg("text");
  caption.classList.add("drydock-gizmo__caption");
  artwork.append(caption);

  const moveLines = {} as Record<Axis, SVGLineElement>;
  const scaleLines = {} as Record<Axis, SVGLineElement>;
  const moveLabels = {} as Record<Axis, SVGTextElement>;
  const scaleLabels = {} as Record<Axis, SVGTextElement>;
  for (const axis of AXES) {
    const moveLine = svg("line");
    moveLine.classList.add("drydock-gizmo__move-line", `is-axis-${axis}`);
    artwork.append(moveLine);
    moveLines[axis] = moveLine;
    const moveLabel = svg("text");
    moveLabel.classList.add("drydock-gizmo__axis-label", `is-axis-${axis}`);
    moveLabel.textContent = AXIS_LABELS[axis];
    artwork.append(moveLabel);
    moveLabels[axis] = moveLabel;

    const scaleLine = svg("line");
    scaleLine.classList.add("drydock-gizmo__scale-line", `is-axis-${axis}`);
    artwork.append(scaleLine);
    scaleLines[axis] = scaleLine;
    const scaleLabel = svg("text");
    scaleLabel.classList.add("drydock-gizmo__scale-label", `is-axis-${axis}`);
    scaleLabel.textContent = AXIS_LABELS[axis];
    artwork.append(scaleLabel);
    scaleLabels[axis] = scaleLabel;
  }

  let mode: GizmoMode = "move";
  const modeRail = document.createElement("div");
  modeRail.className = "drydock-gizmo__mode-rail";
  const modeButtons = new Map<GizmoMode, HTMLButtonElement>();
  const setMode = (next: GizmoMode): void => {
    mode = next;
    layer.dataset.mode = next;
    for (const [buttonMode, button] of modeButtons) {
      const active = buttonMode === next;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  };
  for (const [buttonMode, label, key] of [
    ["move", "MOVE", "W"],
    ["scale", "SCALE", "R"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drydock-gizmo__mode";
    button.textContent = label;
    button.dataset.key = key;
    button.setAttribute("aria-label", `${label.toLowerCase()} mode (${key})`);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => setMode(buttonMode));
    modeButtons.set(buttonMode, button);
    modeRail.append(button);
  }
  layer.append(modeRail);
  setMode(mode);

  const hits = document.createElement("div");
  hits.className = "drydock-gizmo__hits";
  layer.append(hits);

  const handles = new Map<HandleKind, HTMLButtonElement>();
  const makeHandle = (
    kind: HandleKind,
    label: string,
    axis?: Axis,
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `drydock-gizmo__handle is-${kind.split("-")[0]} is-${kind}`;
    button.setAttribute("aria-label", label);
    button.dataset.kind = kind;
    if (axis !== undefined) button.dataset.axis = AXIS_LABELS[axis];
    button.addEventListener("pointerdown", (event) => {
      if (!(event instanceof PointerEvent)) return;
      const part = hulls[view.cls].parts[sel.part];
      const activeFrame = lastFrame;
      if (!part || !activeFrame) return;
      event.preventDefault();
      event.stopPropagation();
      stopSpinForDrag();
      // One pointerdown is exactly one undo step, so no coalescing here.
      pushUndo(`${kind.split("-")[0]} part ${sel.part}`);
      const startPointer = pointer(event);
      drag = {
        button,
        kind,
        part,
        startPointer,
        startPos: [...part.pos],
        startScale: [...part.scale],
        frame: activeFrame,
        startDistance: distanceFrom(startPointer, activeFrame.pivot),
      };
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic clicks have no active pointer to capture; real drags do.
      }
    });
    button.addEventListener("keydown", (event) => {
      if (!nudgePartFromKey(kind, event)) return;
      event.preventDefault();
      event.stopPropagation();
    });
    hits.append(button);
    handles.set(kind, button);
    return button;
  };

  makeHandle("move-free", "Move selected part freely in the hull plane");
  for (const axis of AXES) {
    makeHandle(
      `move-${axis}`,
      `Move selected part on the ${AXIS_LABELS[axis]} axis`,
      axis,
    );
    makeHandle(
      `scale-${axis}`,
      `Resize selected part on the ${AXIS_LABELS[axis]} axis`,
      axis,
    );
  }
  makeHandle("scale-uniform", "Resize selected part proportionally");

  document.body.append(layer);

  let lastFrame: GizmoFrame | null = null;
  let drag: DragState | null = null;

  const onPointerMove = (event: PointerEvent): void => {
    if (!drag) return;
    event.preventDefault();
    updateFromDrag(drag, pointer(event));
    touchHull();
  };
  const onPointerEnd = (event: PointerEvent): void => {
    if (!drag) return;
    if (drag.button.hasPointerCapture(event.pointerId)) {
      drag.button.releasePointerCapture(event.pointerId);
    }
    drag = null;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    // Outside design mode the gizmo is hidden, so its keys must stay free for
    // whatever else the page (or the browser) wants them for. A focused handle
    // owns the arrows itself: axis-locked, and it can scale.
    if (!view.design || isEditableTarget(event.target)) return;
    if (isHandleTarget(event.target)) return;
    if (nudgeInScreenPlane(lastFrame, event)) {
      event.preventDefault();
      return;
    }
    const next = modeFromKey(event);
    if (!next) return;
    setMode(next);
    event.preventDefault();
  };
  addEventListener("pointermove", onPointerMove);
  addEventListener("pointerup", onPointerEnd);
  addEventListener("pointercancel", onPointerEnd);
  addEventListener("keydown", onKeyDown);

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: render pass mirrors the SVG and hit-target geometry together
  const update = (canvas: HTMLCanvasElement): void => {
    const part = view.design ? hulls[view.cls].parts[sel.part] : undefined;
    if (!part) {
      lastFrame = null;
      drag = null; // leaving design mode mid-drag must not strand the handle
      layer.classList.remove("is-visible");
      layer.setAttribute("aria-hidden", "true");
      return;
    }
    const frameData = projectFrame(canvas, part);
    lastFrame = frameData;
    layer.classList.add("is-visible");
    layer.setAttribute("aria-hidden", "false");
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    artwork.setAttribute("viewBox", `0 0 ${width} ${height}`);
    artwork.setAttribute("width", String(width));
    artwork.setAttribute("height", String(height));

    attr(frame, "x", frameData.box.minX - 8);
    attr(frame, "y", frameData.box.minY - 8);
    attr(
      frame,
      "width",
      Math.max(frameData.box.maxX - frameData.box.minX + 16, 24),
    );
    attr(
      frame,
      "height",
      Math.max(frameData.box.maxY - frameData.box.minY + 16, 24),
    );
    // The left control panel floats over the canvas, so labels have to start
    // clear of it or they read as clipped garbage.
    const labelX = Math.max(frameData.box.minX, panelClearPx() + 12);
    // Rail above the box, caption below it — stacking both on top hides the
    // caption behind the rail.
    attr(caption, "x", labelX);
    // Below the uniform grip's row, which hangs off the box's bottom-right.
    attr(caption, "y", Math.min(frameData.box.maxY + 38, height - 6));
    // Show the live numbers: mid-drag the panel knobs are off to the side, and
    // "how big is it now" is the question the gesture is actually asking.
    const values =
      mode === "move"
        ? part.pos.map((v) => v.toFixed(2)).join("  ")
        : part.scale.map((v) => v.toFixed(2)).join("  ×  ");
    caption.textContent = `part ${String(sel.part + 1).padStart(2, "0")}  ·  ${part.prim.kind}  ·  ${mode === "move" ? "hull" : "part"} axes  ·  ${values}`;
    modeRail.style.left = `${labelX}px`;
    modeRail.style.top = `${Math.max(frameData.box.minY - 38, 12)}px`;

    placeHandle(handles, "move-free", frameData.pivot);
    for (const axis of AXES) {
      const move = frameData.moveAxes[axis];
      const scaleData = frameData.scaleAxes[axis];
      attr(moveLines[axis], "x1", frameData.pivot.x);
      attr(moveLines[axis], "y1", frameData.pivot.y);
      attr(moveLines[axis], "x2", move.point.x);
      attr(moveLines[axis], "y2", move.point.y);
      attr(moveLabels[axis], "x", move.point.x + 7);
      attr(moveLabels[axis], "y", move.point.y + 4);
      attr(scaleLines[axis], "x1", frameData.pivot.x);
      attr(scaleLines[axis], "y1", frameData.pivot.y);
      attr(scaleLines[axis], "x2", scaleData.point.x);
      attr(scaleLines[axis], "y2", scaleData.point.y);
      attr(scaleLabels[axis], "x", scaleData.point.x + 7);
      attr(scaleLabels[axis], "y", scaleData.point.y + 4);
      placeHandle(handles, `move-${axis}`, move.point);
      placeHandle(handles, `scale-${axis}`, scaleData.point);
    }
    placeHandle(handles, "scale-uniform", frameData.uniform);
  };

  return {
    update,
    destroy: () => {
      removeEventListener("pointermove", onPointerMove);
      removeEventListener("pointerup", onPointerEnd);
      removeEventListener("pointercancel", onPointerEnd);
      removeEventListener("keydown", onKeyDown);
      layer.remove();
    },
  };
};
