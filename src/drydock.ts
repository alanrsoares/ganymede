// Drydock: throwaway concept-validation harness for the procedural ship
// hulls (ship-parts.ts + ship.wgsl), reusing the real engine pieces — GPU
// context, mesh-pass, asteroid mesh, starfield background — so the verdict
// transfers. One scene: a big inspector hull on the left, a drifting swarm
// at true gameplay scale (with two live rocks for the ship-vs-rock read) on
// the right. Not wired into the game; delete or promote after the verdict.

import van from "vanjs-core";
import { acquireGpu } from "./gpu-context";
import { makeAsteroidMesh } from "./mesh";
import { createMeshPass, instanceLayout, type MeshPass } from "./mesh-pass";
import backgroundWGSL from "./shaders/background.wgsl" with { type: "text" };
import plumeWGSL from "./shaders/plume.wgsl" with { type: "text" };
import rockWGSL from "./shaders/rock.wgsl" with { type: "text" };
import shipWGSL from "./shaders/ship.wgsl" with { type: "text" };
import {
  assembleShipMesh,
  ENGINES,
  type EngineAnchor,
  makePlumeMesh,
  PALETTE_KEYS,
  type PartDef,
  type PrimDef,
  RECIPES,
  SHIP_CLASSES,
  type ShipClass,
} from "./ship-parts";
import { TEAMS } from "./world/types";

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
  "_a",
  "_b",
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

const GEAR: Record<ShipClass, string> = {
  scout:
    "<b>scout — lamprey</b><br>speed 1.3× · recon · shredder bolts · cyclopean eye, barbed spine",
  fighter:
    "<b>fighter — ossuary</b><br>cadence 1.39× · L5 arc lightning · bone-blade wings, tusk barrels",
  heavy:
    "<b>heavy — leviathan</b><br>hp 1.5× · rammer/carrier · mine barnacles · the eye is off-centre. it watches",
  interceptor:
    "<b>interceptor — stinger</b><br>speed 1.12× · seeking missiles L3+ · egg-sac polyps about to hatch",
};

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

const state = {
  cls: "scout" as ShipClass,
  team: 0,
  tiltDeg: 28,
  bank: false,
  mono: false,
  paused: matchMedia("(prefers-reduced-motion: reduce)").matches,
  t: 0,
  // Inspector orbit: drag adds yaw/pitch on top of the slider tilt; dragging
  // stops the auto-spin (spinPhase freezes), the `spin` button resumes it.
  spin: true,
  spinPhase: 0,
  orbitYaw: 0,
  orbitPitch: 0,
  design: false,
};

const teamTint = (team: number): readonly [number, number, number] =>
  state.mono ? MONO : TEAMS[team].rgb;

// --- hull designer state --------------------------------------------------------
// Working copies of the stock recipes, edited live and persisted to
// localStorage. `rebuildHull` is bound inside main() once the GPU exists.

interface HullDef {
  parts: PartDef[];
  engines: EngineAnchor[];
}
const STORE_KEY = "drydock-hulls-v1";

const stockHull = (cls: ShipClass): HullDef =>
  structuredClone({
    parts: RECIPES[cls] as PartDef[],
    engines: ENGINES[cls] as EngineAnchor[],
  });

const loadHulls = (): Record<ShipClass, HullDef> => {
  const out = {} as Record<ShipClass, HullDef>;
  for (const cls of SHIP_CLASSES) out[cls] = stockHull(cls);
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<ShipClass, HullDef>>;
      for (const cls of SHIP_CLASSES) {
        const h = saved[cls];
        if (h?.parts?.length && h.engines) out[cls] = h;
      }
    }
  } catch {
    // corrupt store — fall back to stock
  }
  return out;
};

const hulls = loadHulls();
let rebuildHull: (cls: ShipClass) => void = () => {};
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

/** Persist + debounce a mesh re-bake for the class being edited. */
const touchHull = (): void => {
  localStorage.setItem(STORE_KEY, JSON.stringify(hulls));
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuildHull(state.cls), 80);
};

// --- GPU setup ----------------------------------------------------------------

interface Passes {
  bgPipeline: GPURenderPipeline;
  bgBindGroup: GPUBindGroup;
  shipPasses: Record<ShipClass, MeshPass>;
  rockPass: MeshPass;
  plumePass: MeshPass;
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
  return { bgPipeline, bgBindGroup, shipPasses, rockPass, plumePass };
};

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
}

const packShip = (data: Float32Array, i: number, ship: ShipInstance): void => {
  const o = i * SHIP_LAYOUT.floats;
  data[o + S.cx] = ship.cx;
  data[o + S.cy] = ship.cy;
  data[o + S.radius] = ship.radius;
  data[o + S.roll] = ship.roll;
  data[o + S.heading] = ship.heading;
  data[o + S.tilt] = ship.tilt ?? (state.tiltDeg * Math.PI) / 180;
  data[o + S.r] = ship.team[0];
  data[o + S.g] = ship.team[1];
  data[o + S.b] = ship.team[2];
  data[o + S.alpha] = 1;
};

/** Inspector hull + swarm ships, bucketed per class mesh. */
const collectShips = (
  swarm: SwarmShip[],
  w: number,
  h: number,
  cellPx: number,
): ShipInstance[] => {
  const ships: ShipInstance[] = [
    {
      cls: state.cls,
      cx: w * 0.24,
      cy: h * 0.5,
      radius: Math.min(w, h) * 0.19,
      roll: state.bank ? Math.sin(state.t * 1.6) * 0.55 : 0,
      heading: Math.PI + state.spinPhase + state.orbitYaw,
      tilt: (state.tiltDeg * Math.PI) / 180 + state.orbitPitch,
      team: teamTint(state.team),
      throttle: 0.85,
      phase: 1,
    },
  ];
  for (const s of swarm) {
    if (s.x < 0.44) continue; // keep the field clear of the inspector
    ships.push({
      cls: s.cls,
      cx: s.x * w,
      cy: s.y * h,
      radius: SHIP_LEVEL_SIZES[s.level - 1] * cellPx,
      roll: Math.sin(state.t * 1.3 + s.phase) * 0.3 + s.turn * 0.8,
      heading: s.heading,
      team: teamTint(s.team),
      throttle:
        0.35 +
        0.5 *
          ARCH_SPEED[s.cls] *
          (0.7 + 0.3 * Math.sin(state.t * 0.7 + s.phase)),
      phase: s.phase * 7,
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
      data[o + P.tilt] = ship.tilt ?? (state.tiltDeg * Math.PI) / 180;
      data[o + P.throttle] = ship.throttle;
      data[o + P.phase] = ship.phase + count;
      data[o + P.nx] = eng.pos[0];
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
    data[o + R.rx] = state.t * 0.6 + rock.id * 1.3;
    data[o + R.ry] = state.t * 0.9 + rock.id * 2.1;
    data[o + R.rz] = rock.id;
    data[o + R.r] = 0.52;
    data[o + R.g] = 0.53;
    data[o + R.b] = 0.6;
    data[o + R.damage] = 0;
  });
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

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!state.paused) {
      state.t += dt;
      if (state.spin) state.spinPhase += dt * 0.5;
      stepSwarm(swarm, dt);
    }
    const w = canvas.width;
    const h = canvas.height;
    const cellPx = 3 * Math.min(devicePixelRatio || 1, 2);
    device.queue.writeBuffer(
      uniformBuffer,
      0,
      new Float32Array([w, h, state.t, DEPTH_SCALE]),
    );
    const counts = {} as Record<ShipClass, number>;
    for (const cls of SHIP_CLASSES) counts[cls] = 0;
    const ships = collectShips(swarm, w, h, cellPx);
    for (const ship of ships) {
      packShip(buf[ship.cls], counts[ship.cls]++, ship);
    }
    const plumeCount = packPlumes(plumeData, ships);
    packRocks(rockData, w, h, cellPx);
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
    );
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

const main = async (): Promise<void> => {
  const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
  const { device, context, format } = await acquireGpu(canvas);
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const passes = createPasses(device, format, uniformBuffer);
  rebuildHull = (cls) => {
    passes.shipPasses[cls] = createShipPass(device, format, uniformBuffer, cls);
  };

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

// --- orbit drag -----------------------------------------------------------------
// Drag anywhere on the canvas to orbit the inspector hull: x = yaw, y = pitch
// (added on top of the tilt slider). Grabbing stops the auto-spin.

const wireOrbitDrag = (canvas: HTMLCanvasElement): void => {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";
  canvas.onpointerdown = (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    state.spin = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
    sync();
  };
  canvas.onpointermove = (e) => {
    if (!dragging) return;
    state.orbitYaw += (e.clientX - lastX) * 0.008;
    state.orbitPitch += (e.clientY - lastY) * 0.006;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const release = (e: PointerEvent): void => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = "grab";
  };
  canvas.onpointerup = release;
  canvas.onpointercancel = release;
};

// --- HUD wiring ----------------------------------------------------------------

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

// --- hull designer UI ------------------------------------------------------------
// Panel editor over `hulls`, built with van.tags like the rest of the HUD.
// Recipes are deep-mutable arrays, so the panel re-renders wholesale on
// structural change instead of threading van.state through every field.

const { button, div, input, label, option, output, select } = van.tags;

let selPart = 0;

const hudButton = (text: string, onclick: () => void): HTMLButtonElement =>
  button({ type: "button", onclick }, text);

const sliderRow = (
  text: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void,
): HTMLElement => {
  const out = output(get().toFixed(2));
  return div(
    { class: "ctl" },
    label(text, out),
    input({
      type: "range",
      min,
      max,
      step,
      value: get(),
      oninput: (e: Event) => {
        set(Number((e.target as HTMLInputElement).value));
        out.textContent = get().toFixed(2);
        touchHull();
      },
    }),
  );
};

const selectRow = (
  text: string,
  options: readonly string[],
  value: string,
  onChange: (v: string) => void,
): HTMLElement =>
  div(
    { class: "ctl" },
    label(text),
    select(
      {
        onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
      },
      ...options.map((o) => option({ value: o, selected: o === value }, o)),
    ),
  );

const vec3Rows = (
  text: string,
  min: number,
  max: number,
  vec: () => [number, number, number],
): HTMLElement[] =>
  ["x", "y", "z"].map((axis, i) =>
    sliderRow(
      `${text}.${axis}`,
      min,
      max,
      0.01,
      () => vec()[i],
      (v) => {
        vec()[i] = v;
      },
    ),
  );

const defaultPrim = (kind: string): PrimDef =>
  kind === "hex"
    ? { kind: "hex", taper: 0.7 }
    : kind === "orb"
      ? { kind: "orb" }
      : { kind: "slab", tx: 0.5, tz: 0.5 };

const taperRows = (p: PrimDef): HTMLElement[] => {
  if (p.kind === "slab") {
    return [
      sliderRow(
        "taper.x",
        0.02,
        1,
        0.01,
        () => p.tx,
        (v) => {
          p.tx = v;
        },
      ),
      sliderRow(
        "taper.z",
        0.02,
        1,
        0.01,
        () => p.tz,
        (v) => {
          p.tz = v;
        },
      ),
    ];
  }
  if (p.kind === "hex") {
    return [
      sliderRow(
        "taper",
        0.02,
        1,
        0.01,
        () => p.taper,
        (v) => {
          p.taper = v;
        },
      ),
    ];
  }
  return [];
};

const rotRows = (part: PartDef): HTMLElement[] => {
  part.rot ??= [0, 0, 0];
  const rot = part.rot;
  return ["x", "y", "z"].map((axis, i) =>
    sliderRow(
      `rot.${axis}°`,
      -180,
      180,
      1,
      () => (rot[i] * 180) / Math.PI,
      (v) => {
        rot[i] = (v * Math.PI) / 180;
      },
    ),
  );
};

const partControls = (part: PartDef): HTMLElement[] => [
  selectRow("prim", ["slab", "hex", "orb"], part.prim.kind, (kind) => {
    part.prim = defaultPrim(kind);
    touchHull();
    renderEditor();
  }),
  ...taperRows(part.prim),
  ...vec3Rows("pos", -1.6, 1.6, () => part.pos),
  ...vec3Rows("scale", 0.02, 2.5, () => part.scale),
  ...rotRows(part),
  selectRow("color", PALETTE_KEYS, part.color, (v) => {
    part.color = v as PartDef["color"];
    touchHull();
  }),
  label(
    { class: "check" },
    input({
      type: "checkbox",
      checked: !!part.mirror,
      onchange: (e: Event) => {
        part.mirror = (e.target as HTMLInputElement).checked;
        touchHull();
      },
    }),
    "mirror x",
  ),
];

const engineControls = (engines: EngineAnchor[], i: number): HTMLElement[] => {
  const eng = engines[i];
  return [
    div(
      { class: "row" },
      hudButton(`engine ${i} ✕`, () => {
        engines.splice(i, 1);
        touchHull();
        renderEditor();
      }),
    ),
    sliderRow(
      "x",
      -1.2,
      1.2,
      0.01,
      () => eng.pos[0],
      (v) => {
        eng.pos[0] = v;
      },
    ),
    sliderRow(
      "y",
      -1.8,
      1.8,
      0.01,
      () => eng.pos[1],
      (v) => {
        eng.pos[1] = v;
      },
    ),
    sliderRow(
      "width",
      0.03,
      0.4,
      0.01,
      () => eng.w,
      (v) => {
        eng.w = v;
      },
    ),
  ];
};

const partListButtons = (parts: PartDef[]): HTMLElement[] =>
  parts.map((part, i) =>
    button(
      {
        type: "button",
        class: `part-btn${i === selPart ? " on" : ""}`,
        title: part.color,
        onclick: () => {
          selPart = i;
          renderEditor();
        },
      },
      `${i}·${part.prim.kind}`,
    ),
  );

const renderEditor = (): void => {
  const hull = hulls[state.cls];
  selPart = Math.min(selPart, hull.parts.length - 1);
  el("edCls").textContent = state.cls;
  const list = el("partList");
  list.replaceChildren();
  van.add(list, ...partListButtons(hull.parts));
  const ctl = el("partCtl");
  ctl.replaceChildren();
  if (hull.parts[selPart]) van.add(ctl, ...partControls(hull.parts[selPart]));
  const eng = el("engCtl");
  eng.replaceChildren();
  for (let i = 0; i < hull.engines.length; i++) {
    van.add(eng, ...engineControls(hull.engines, i));
  }
};

const exportHullTs = (): void => {
  const hull = hulls[state.cls];
  const text = [
    `// ${state.cls} hull — exported from /drydock designer`,
    `const PARTS: PartDef[] = ${JSON.stringify(hull.parts, null, 2)};`,
    `const HULL_ENGINES: EngineAnchor[] = ${JSON.stringify(hull.engines, null, 2)};`,
    "",
  ].join("\n");
  navigator.clipboard?.writeText(text).catch(() => {});
  console.log(text);
  const btn = el("exportTs");
  btn.textContent = "copied ✓";
  setTimeout(() => {
    btn.textContent = "export → clipboard";
  }, 1200);
};

const wireEditor = (): void => {
  el("addPart").onclick = () => {
    const hull = hulls[state.cls];
    hull.parts.push({
      prim: defaultPrim("slab"),
      scale: [0.3, 0.3, 0.3],
      pos: [0, 0, 0],
      color: "bone",
    });
    selPart = hull.parts.length - 1;
    touchHull();
    renderEditor();
  };
  el("dupPart").onclick = () => {
    const hull = hulls[state.cls];
    const part = hull.parts[selPart];
    if (!part) return;
    hull.parts.splice(selPart + 1, 0, structuredClone(part));
    selPart++;
    touchHull();
    renderEditor();
  };
  el("delPart").onclick = () => {
    const hull = hulls[state.cls];
    if (hull.parts.length <= 1) return;
    hull.parts.splice(selPart, 1);
    touchHull();
    renderEditor();
  };
  el("addEng").onclick = () => {
    hulls[state.cls].engines.push({ pos: [0, -1.2, 0], w: 0.12 });
    touchHull();
    renderEditor();
  };
  el("exportTs").onclick = exportHullTs;
  el("resetCls").onclick = () => {
    hulls[state.cls] = stockHull(state.cls);
    selPart = 0;
    touchHull();
    renderEditor();
  };
};

const sync = (): void => {
  for (const b of el("classRow").children) {
    b.classList.toggle("on", b.textContent === state.cls);
  }
  [...el("teamRow").children].forEach((b, i) => {
    b.classList.toggle("on", i === state.team);
  });
  el("spin").classList.toggle("on", state.spin);
  el("bank").classList.toggle("on", state.bank);
  el("mono").classList.toggle("on", state.mono);
  el("pause").classList.toggle("on", state.paused);
  el("pause").textContent = state.paused ? "resume" : "pause";
  el("design").classList.toggle("on", state.design);
  (el("editor") as HTMLElement).hidden = !state.design;
  el("gear").innerHTML = GEAR[state.cls];
  if (state.design) renderEditor();
};

const wireHud = (): void => {
  van.add(
    el("classRow"),
    ...SHIP_CLASSES.map((cls) =>
      button(
        {
          type: "button",
          onclick: () => {
            state.cls = cls;
            sync();
          },
        },
        cls,
      ),
    ),
  );
  van.add(
    el("teamRow"),
    ...TEAMS.map((team, i) =>
      button({
        type: "button",
        class: "swatch",
        style: `background: rgb(${team.rgb.map((c) => Math.round(c * 255)).join(",")})`,
        "aria-label": `team ${team.name}`,
        onclick: () => {
          state.team = i;
          sync();
        },
      }),
    ),
  );
  (el("tilt") as HTMLInputElement).oninput = (e) => {
    state.tiltDeg = Number((e.target as HTMLInputElement).value);
    el("tiltOut").textContent = `${state.tiltDeg}°`;
  };
  const toggle = (id: string, fn: () => void): void => {
    el(id).onclick = () => {
      fn();
      sync();
    };
  };
  toggle("spin", () => {
    state.spin = !state.spin;
    if (state.spin) state.orbitYaw = 0; // resume clean auto-yaw
  });
  toggle("bank", () => {
    state.bank = !state.bank;
  });
  toggle("mono", () => {
    state.mono = !state.mono;
  });
  toggle("pause", () => {
    state.paused = !state.paused;
  });
  toggle("design", () => {
    state.design = !state.design;
  });
  sync();
};

wireHud();
wireEditor();
main().catch((err) => {
  el("hud").remove();
  van.add(
    document.body,
    div(
      { class: "err" },
      `Drydock needs WebGPU: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
});
