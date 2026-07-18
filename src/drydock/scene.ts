// Drydock scene: the WebGPU half of the tool, reusing the real engine pieces —
// GPU context, mesh-pass, asteroid mesh, starfield background — so what you
// see is what the game renders. One scene: a big inspector hull on the left
// (drag to orbit, click a part to select it in the designer), a drifting
// swarm at true gameplay scale (with two live rocks for the ship-vs-rock
// read) on the right. Reads the shared store every frame; registers mesh
// rebuild hooks so designer edits re-bake the hull.

import { spineOffset } from "~/hull/articulation";
import { assembleShipMesh, makePlumeMesh, pickPart } from "~/hull/bake";
import {
  type ArticulationDef,
  type PartDef,
  SHIP_CLASSES,
  type ShipClass,
  type V3,
} from "~/hull/catalog";
import { acquireGpu } from "~/render/gpu-context";
import { makeAsteroidMesh } from "~/render/mesh";
import {
  createMeshPass,
  instanceLayout,
  type MeshPass,
} from "~/render/mesh-pass";
import backgroundWGSL from "~/shaders/background.wgsl" with { type: "text" };
import highlightWGSL from "~/shaders/highlight.wgsl" with { type: "text" };
import plumeWGSL from "~/shaders/plume.wgsl" with { type: "text" };
import rockWGSL from "~/shaders/rock.wgsl" with { type: "text" };
import shipWGSL from "~/shaders/ship.wgsl" with { type: "text" };
import { TEAMS } from "~/world/types";
import {
  hulls,
  registerRebuild,
  sel,
  selectPart,
  stopSpinForDrag,
  view,
} from "./store";

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const DEPTH_SCALE = 0.0016; // same z compression as gpu.ts
const SHIP_LEVEL_SIZES = [4.5, 5.9, 7.0, 8.1, 9.2]; // overlay/ships.ts
const MONO: readonly [number, number, number] = [0.72, 0.74, 0.78];
const MAX_SHIPS = 64;
const MAX_PLUMES = 192;

// prettier-ignore
const SHIP_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "roll",
  "heading",
  "tilt",
  "wavePhase", // spine articulation (ship.wgsl) — keep identical to the
  "bendCurve", // game's SHIP_LAYOUT in render/overlay/frame.ts
  "amp",
  "freq",
  "headStiff",
  "segLen",
  "r",
  "g",
  "b",
  "alpha",
]);
// prettier-ignore
const PLUME_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "roll",
  "heading",
  "tilt",
  "throttle",
  "phase",
  "nx",
  "ny",
  "nz",
  "w",
  "r",
  "g",
  "b",
  "alpha",
]);
// prettier-ignore
const ROCK_LAYOUT = instanceLayout([
  "cx",
  "cy",
  "radius",
  "_a",
  "rx",
  "ry",
  "rz",
  "_b",
  "r",
  "g",
  "b",
  "damage",
]);

const ARCH_SPEED: Record<ShipClass, number> = {
  scout: 1.3,
  fighter: 1,
  heavy: 0.78,
  interceptor: 1.12,
};

interface SwarmShip {
  cls: ShipClass;
  team: number;
  level: number;
  x: number;
  y: number;
  heading: number;
  turn: number;
  phase: number;
}

const teamTint = (team: number): readonly [number, number, number] =>
  view.mono ? MONO : TEAMS[team].rgb;

// --- ship transform (TS mirror of ship.wgsl's shipMat) --------------------------
// Row-major mat3; used to invert the inspector pose for click-picking.

type Mat3 = readonly number[];
const matMul = (a: Mat3, b: Mat3): number[] => {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
};
const mulV = (m: Mat3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const transpose = (m: Mat3): number[] => [
  m[0],
  m[3],
  m[6],
  m[1],
  m[4],
  m[7],
  m[2],
  m[5],
  m[8],
];

/** Rz(heading)·Rx(tilt)·Ry(roll) — must match ship.wgsl's shipMat exactly. */
const shipMat = (heading: number, tilt: number, roll: number): number[] => {
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const rz = [ch, -sh, 0, sh, ch, 0, 0, 0, 1];
  const rx = [1, 0, 0, 0, ct, -st, 0, st, ct];
  const ry = [cr, 0, sr, 0, 1, 0, -sr, 0, cr];
  return matMul(rz, matMul(rx, ry));
};

/** The inspector hull's current pose — shared by draw, pick and highlight. */
const inspectorPose = (w: number, h: number) => ({
  cx: w * 0.24,
  cy: h * 0.5,
  radius: Math.min(w, h) * 0.19,
  roll: view.bank ? Math.sin(view.t * 1.6) * 0.55 : 0,
  heading: Math.PI + view.spinPhase + view.orbitYaw,
  tilt: (view.tiltDeg * Math.PI) / 180 + view.orbitPitch,
});

// --- GPU setup ----------------------------------------------------------------

interface Passes {
  bgPipeline: GPURenderPipeline;
  bgBindGroup: GPUBindGroup;
  shipPasses: Record<ShipClass, MeshPass>;
  rockPass: MeshPass;
  plumePass: MeshPass;
  /** Selected-part glow shell; rebuilt on selection/edit, null when nothing selected. */
  highlightPass: MeshPass | null;
}

const createShipPass = (
  device: GPUDevice,
  format: GPUTextureFormat,
  uniformBuffer: GPUBuffer,
  cls: ShipClass,
): MeshPass =>
  createMeshPass(device, {
    format,
    uniformBuffer,
    mesh: assembleShipMesh(hulls[cls].parts),
    shader: shipWGSL,
    layout: SHIP_LAYOUT,
    maxInstances: MAX_SHIPS,
    depthFormat: DEPTH_FORMAT,
    depthWrite: true,
    depthCompare: "less",
  });

const createPasses = (
  device: GPUDevice,
  format: GPUTextureFormat,
  uniformBuffer: GPUBuffer,
): Passes => {
  const bgModule = device.createShaderModule({ code: backgroundWGSL });
  const bgPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: bgModule, entryPoint: "vs" },
    fragment: { module: bgModule, entryPoint: "fs", targets: [{ format }] },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "always",
    },
  });
  const bgBindGroup = device.createBindGroup({
    layout: bgPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });
  const shipPasses = {} as Record<ShipClass, MeshPass>;
  for (const cls of SHIP_CLASSES) {
    shipPasses[cls] = createShipPass(device, format, uniformBuffer, cls);
  }
  const rockPass = createMeshPass(device, {
    format,
    uniformBuffer,
    mesh: makeAsteroidMesh(2),
    shader: rockWGSL,
    layout: ROCK_LAYOUT,
    maxInstances: 8,
    depthFormat: DEPTH_FORMAT,
    depthWrite: true,
    depthCompare: "less",
  });
  // Additive plume cones: no depth write (glow), still occluded by hulls.
  const plumePass = createMeshPass(device, {
    format,
    uniformBuffer,
    mesh: makePlumeMesh(),
    shader: plumeWGSL,
    layout: PLUME_LAYOUT,
    maxInstances: MAX_PLUMES,
    depthFormat: DEPTH_FORMAT,
    depthWrite: false,
    depthCompare: "less",
    blend: {
      color: { srcFactor: "one", dstFactor: "one" },
      alpha: { srcFactor: "one", dstFactor: "one" },
    },
  });
  return {
    bgPipeline,
    bgBindGroup,
    shipPasses,
    rockPass,
    plumePass,
    highlightPass: null,
  };
};

/** Additive glow shell for the currently selected part (design mode). */
const createHighlightPass = (
  device: GPUDevice,
  format: GPUTextureFormat,
  uniformBuffer: GPUBuffer,
  part: PartDef,
): MeshPass =>
  createMeshPass(device, {
    format,
    uniformBuffer,
    mesh: assembleShipMesh([part]),
    shader: highlightWGSL,
    layout: SHIP_LAYOUT,
    maxInstances: 1,
    depthFormat: DEPTH_FORMAT,
    depthWrite: false,
    depthCompare: "always", // glow through the hull: occluded parts stay findable
    blend: {
      color: { srcFactor: "one", dstFactor: "one" },
      alpha: { srcFactor: "one", dstFactor: "one" },
    },
  });

// --- scene --------------------------------------------------------------------

const seedSwarm = (): SwarmShip[] =>
  Array.from({ length: 20 }, (_, i) => ({
    cls: SHIP_CLASSES[i % SHIP_CLASSES.length],
    team: (i >> 2) % TEAMS.length,
    level: 1 + ((i * 7) % 5),
    x: 0.45 + Math.random() * 0.5, // right-hand field, canvas fractions
    y: 0.08 + Math.random() * 0.84,
    heading: Math.random() * Math.PI * 2,
    turn: (Math.random() - 0.5) * 0.4,
    phase: Math.random() * Math.PI * 2,
  }));

const ROCKS = [
  { x: 0.58, y: 0.3, size: 34, id: 1 },
  { x: 0.82, y: 0.72, size: 46, id: 4 },
];

const stepSwarm = (swarm: SwarmShip[], dt: number): void => {
  for (const s of swarm) {
    s.heading += s.turn * dt;
    const speed = 0.03 * ARCH_SPEED[s.cls];
    s.x = (s.x + Math.sin(s.heading) * speed * dt + 1) % 1;
    s.y = (s.y + Math.cos(s.heading) * speed * dt + 1) % 1;
  }
};

// --- instance packing -----------------------------------------------------------

const S = SHIP_LAYOUT.idx;
const R = ROCK_LAYOUT.idx;

interface ShipInstance {
  cls: ShipClass;
  cx: number;
  cy: number;
  radius: number;
  roll: number;
  heading: number;
  team: readonly [number, number, number];
  /** Per-ship tilt override (inspector orbit); defaults to the slider. */
  tilt?: number;
  /** Engine output 0..1 — plume length/brightness. */
  throttle: number;
  /** Per-ship flicker phase so plumes never strobe in unison. */
  phase: number;
  /** Spine articulation (ship.wgsl): temporal wave phase + turn lean, and
   * the hull's tuning with the *effective* amp already applied — the same
   * values the plume anchor shift uses. */
  wavePhase: number;
  bendCurve: number;
  art: ArticulationDef;
}

const packShip = (data: Float32Array, i: number, ship: ShipInstance): void => {
  const o = i * SHIP_LAYOUT.floats;
  data[o + S.cx] = ship.cx;
  data[o + S.cy] = ship.cy;
  data[o + S.radius] = ship.radius;
  data[o + S.roll] = ship.roll;
  data[o + S.heading] = ship.heading;
  data[o + S.tilt] = ship.tilt ?? (view.tiltDeg * Math.PI) / 180;
  data[o + S.wavePhase] = ship.wavePhase;
  data[o + S.bendCurve] = ship.bendCurve;
  data[o + S.amp] = ship.art.amp;
  data[o + S.freq] = ship.art.freq;
  data[o + S.headStiff] = ship.art.headStiff;
  data[o + S.segLen] = ship.art.segLen;
  data[o + S.r] = ship.team[0];
  data[o + S.g] = ship.team[1];
  data[o + S.b] = ship.team[2];
  data[o + S.alpha] = 1;
};

/** Inspector hull + swarm ships, bucketed per class mesh. */
// Effective articulation for a hull: the working-copy tuning with the wave
// amplitude scaled by engine output — the same read the game packer uses
// (fast ships swim hard, idlers ripple). `freeze` forces a rigid rest pose.
const effArt = (
  cls: ShipClass,
  throttle: number,
  freeze: boolean,
): ArticulationDef => {
  const a = hulls[cls].articulation;
  return { ...a, amp: freeze ? 0 : a.amp * (0.4 + 0.6 * throttle) };
};

// Wave phase advances with scene time at the game's rate (4 rad/s at
// speed 1 — overlay/ships.ts uses now·ms × 0.004); pausing freezes view.t,
// so reduced-motion users get a still hull for free.
const wavePhase = (a: ArticulationDef, flickerPhase: number): number =>
  view.t * 4 * a.speed + flickerPhase;

const collectShips = (
  swarm: SwarmShip[],
  w: number,
  h: number,
  cellPx: number,
): ShipInstance[] => {
  // Inspector hull: articulate normally, EXCEPT in design mode — click-picking
  // and the highlight shell invert the rest pose, so the wave freezes there
  // to keep part clicks and the glow exact.
  const inspArt = effArt(view.cls, 0.85, view.design);
  const pose = inspectorPose(w, h);
  const ships: ShipInstance[] = [
    {
      cls: view.cls,
      ...pose,
      team: teamTint(view.team),
      throttle: 0.85,
      phase: 1,
      wavePhase: wavePhase(inspArt, 1),
      // Lean deforms even at amp 0, so design mode zeroes it with the wave —
      // picking and the highlight shell assume the exact rest pose.
      bendCurve: view.bank && !view.design ? Math.sin(view.t * 1.6) * 0.28 : 0,
      art: inspArt,
    },
  ];
  for (const s of swarm) {
    if (s.x < 0.44) continue; // keep the field clear of the inspector
    const throttle =
      0.35 +
      0.5 * ARCH_SPEED[s.cls] * (0.7 + 0.3 * Math.sin(view.t * 0.7 + s.phase));
    const art = effArt(s.cls, throttle, false);
    ships.push({
      cls: s.cls,
      cx: s.x * w,
      cy: s.y * h,
      radius: SHIP_LEVEL_SIZES[s.level - 1] * cellPx,
      roll: Math.sin(view.t * 1.3 + s.phase) * 0.3 + s.turn * 0.8,
      heading: s.heading,
      team: teamTint(s.team),
      throttle,
      phase: s.phase * 7,
      wavePhase: wavePhase(art, s.phase),
      bendCurve: Math.max(-0.35, Math.min(0.35, s.turn * 0.5)),
      art,
    });
  }
  return ships;
};

/** One plume instance per engine anchor per ship. Returns instance count. */
const packPlumes = (data: Float32Array, ships: ShipInstance[]): number => {
  const P = PLUME_LAYOUT.idx;
  let count = 0;
  for (const ship of ships) {
    for (const eng of hulls[ship.cls].engines) {
      if (count >= MAX_PLUMES) return count;
      const o = count * PLUME_LAYOUT.floats;
      data[o + P.cx] = ship.cx;
      data[o + P.cy] = ship.cy;
      data[o + P.radius] = ship.radius;
      data[o + P.roll] = ship.roll;
      data[o + P.heading] = ship.heading;
      data[o + P.tilt] = ship.tilt ?? (view.tiltDeg * Math.PI) / 180;
      data[o + P.throttle] = ship.throttle;
      data[o + P.phase] = ship.phase + count;
      // Tail-follow: the nozzle rides the spine's lateral offset at its y —
      // CPU mirror of the deformation ship.wgsl applies to hull vertices.
      data[o + P.nx] =
        eng.pos[0] +
        spineOffset(eng.pos[1], ship.wavePhase, ship.bendCurve, ship.art);
      data[o + P.ny] = eng.pos[1];
      data[o + P.nz] = eng.pos[2];
      data[o + P.w] = eng.w;
      data[o + P.r] = ship.team[0];
      data[o + P.g] = ship.team[1];
      data[o + P.b] = ship.team[2];
      data[o + P.alpha] = 1;
      count++;
    }
  }
  return count;
};

const packRocks = (
  data: Float32Array,
  w: number,
  h: number,
  cellPx: number,
): void => {
  ROCKS.forEach((rock, i) => {
    const o = i * ROCK_LAYOUT.floats;
    data[o + R.cx] = rock.x * w;
    data[o + R.cy] = rock.y * h;
    data[o + R.radius] = rock.size * (cellPx / 3);
    data[o + R.rx] = view.t * 0.6 + rock.id * 1.3;
    data[o + R.ry] = view.t * 0.9 + rock.id * 2.1;
    data[o + R.rz] = rock.id;
    data[o + R.r] = 0.52;
    data[o + R.g] = 0.53;
    data[o + R.b] = 0.6;
    data[o + R.damage] = 0;
  });
};

/** Selected-part glow rides the inspector's pose; design mode only. */
const packHighlight = (
  data: Float32Array,
  w: number,
  h: number,
  passes: Passes,
): Float32Array | null => {
  if (!view.design || !passes.highlightPass) return null;
  packShip(data, 0, {
    cls: view.cls,
    ...inspectorPose(w, h),
    team: MONO,
    throttle: 0,
    phase: 0,
    // Design mode is rest pose (inspector amp is frozen to 0), so the glow
    // shell packs a rigid spine too and stays glued to the picked part.
    wavePhase: 0,
    bendCurve: 0,
    art: effArt(view.cls, 0, true),
  });
  return data;
};

// --- render loop ----------------------------------------------------------------

const encodeFrame = (
  device: GPUDevice,
  context: GPUCanvasContext,
  passes: Passes,
  depth: () => GPUTexture,
  buf: Record<ShipClass, Float32Array>,
  counts: Record<ShipClass, number>,
  rockData: Float32Array,
  plumeData: Float32Array,
  plumeCount: number,
  highlightData: Float32Array | null,
): void => {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.016, g: 0.023, b: 0.043, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: depth().createView(),
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
  pass.setPipeline(passes.bgPipeline);
  pass.setBindGroup(0, passes.bgBindGroup);
  pass.draw(3);
  passes.rockPass.draw(pass, rockData, ROCKS.length);
  for (const cls of SHIP_CLASSES) {
    if (counts[cls] > 0)
      passes.shipPasses[cls].draw(pass, buf[cls], counts[cls]);
  }
  if (plumeCount > 0) passes.plumePass.draw(pass, plumeData, plumeCount);
  if (highlightData && passes.highlightPass) {
    passes.highlightPass.draw(pass, highlightData, 1);
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
};

const runLoop = (
  device: GPUDevice,
  context: GPUCanvasContext,
  canvas: HTMLCanvasElement,
  uniformBuffer: GPUBuffer,
  passes: Passes,
  depth: () => GPUTexture,
): void => {
  const swarm = seedSwarm();
  const buf = {} as Record<ShipClass, Float32Array>;
  for (const cls of SHIP_CLASSES) {
    buf[cls] = new Float32Array(MAX_SHIPS * SHIP_LAYOUT.floats);
  }
  const rockData = new Float32Array(8 * ROCK_LAYOUT.floats);
  const plumeData = new Float32Array(MAX_PLUMES * PLUME_LAYOUT.floats);
  const highlightData = new Float32Array(SHIP_LAYOUT.floats);

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!view.paused) {
      view.t += dt;
      if (view.spin) view.spinPhase += dt * 0.5;
      stepSwarm(swarm, dt);
    }
    const w = canvas.width;
    const h = canvas.height;
    const cellPx = 3 * Math.min(devicePixelRatio || 1, 2);
    device.queue.writeBuffer(
      uniformBuffer,
      0,
      new Float32Array([w, h, view.t, DEPTH_SCALE]),
    );
    const counts = {} as Record<ShipClass, number>;
    for (const cls of SHIP_CLASSES) counts[cls] = 0;
    const ships = collectShips(swarm, w, h, cellPx);
    for (const ship of ships) {
      packShip(buf[ship.cls], counts[ship.cls]++, ship);
    }
    const plumeCount = packPlumes(plumeData, ships);
    packRocks(rockData, w, h, cellPx);
    const hlData = packHighlight(highlightData, w, h, passes);
    encodeFrame(
      device,
      context,
      passes,
      depth,
      buf,
      counts,
      rockData,
      plumeData,
      plumeCount,
      hlData,
    );
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

// --- orbit drag + part picking ---------------------------------------------------
// Drag anywhere on the canvas to orbit the inspector hull: x = yaw, y = pitch
// (added on top of the tilt slider). Grabbing stops the auto-spin. In design
// mode, a click (< 5px travel) on the inspector hull ray-picks the part under
// the cursor and selects it in the designer panel.

/** Screen px -> part index on the inspector hull, or null on miss. */
const pickInspectorPart = (
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): number | null => {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const px = clientX * dpr;
  const py = clientY * dpr;
  const pose = inspectorPose(canvas.width, canvas.height);
  // Invert the orthographic instance transform: world = c + R·(local·radius),
  // so local = Rᵀ·((world − c)/radius). The pick ray runs along +z (viewer).
  const rt = transpose(shipMat(pose.heading, pose.tilt, pose.roll));
  const origin = mulV(rt, [
    (px - pose.cx) / pose.radius,
    (py - pose.cy) / pose.radius,
    0,
  ]);
  const dir = mulV(rt, [0, 0, 1]);
  return pickPart(hulls[view.cls].parts, origin, dir);
};

const wireOrbitDrag = (canvas: HTMLCanvasElement): void => {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let travel = 0;
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";
  canvas.onpointerdown = (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    travel = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  };
  canvas.onpointermove = (e) => {
    if (!dragging) return;
    travel += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    if (travel >= 5) {
      stopSpinForDrag(); // a real drag takes over from auto-spin
      view.orbitYaw += (e.clientX - lastX) * 0.008;
      view.orbitPitch += (e.clientY - lastY) * 0.006;
    }
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const release = (e: PointerEvent): void => {
    if (dragging && travel < 5 && view.design) {
      const hit = pickInspectorPart(canvas, e.clientX, e.clientY);
      if (hit !== null) selectPart(hit);
    }
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = "grab";
  };
  canvas.onpointerup = release;
  canvas.onpointercancel = release;
};

/** Boot the GPU scene on `canvas`. Rejects when WebGPU is unavailable. */
export const startScene = async (canvas: HTMLCanvasElement): Promise<void> => {
  const { device, context, format } = await acquireGpu(canvas);
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const passes = createPasses(device, format, uniformBuffer);
  registerRebuild(
    (cls) => {
      passes.shipPasses[cls] = createShipPass(
        device,
        format,
        uniformBuffer,
        cls,
      );
    },
    () => {
      const part = hulls[view.cls].parts[sel.part];
      passes.highlightPass = part
        ? createHighlightPass(device, format, uniformBuffer, part)
        : null;
    },
  );
  const part = hulls[view.cls].parts[sel.part];
  passes.highlightPass = part
    ? createHighlightPass(device, format, uniformBuffer, part)
    : null;

  let depthTexture: GPUTexture | null = null;
  const resize = (): void => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    depthTexture?.destroy();
    depthTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  };
  resize();
  addEventListener("resize", resize);
  wireOrbitDrag(canvas);
  runLoop(device, context, canvas, uniformBuffer, passes, () => {
    if (!depthTexture) throw new Error("depth texture missing");
    return depthTexture;
  });
};
