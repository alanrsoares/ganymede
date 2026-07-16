// Drydock: throwaway concept-validation harness for the procedural ship
// hulls (ship-parts.ts + ship.wgsl), reusing the real engine pieces — GPU
// context, mesh-pass, asteroid mesh, starfield background — so the verdict
// transfers. One scene: a big inspector hull on the left, a drifting swarm
// at true gameplay scale (with two live rocks for the ship-vs-rock read) on
// the right. Not wired into the game; delete or promote after the verdict.

import { acquireGpu } from "./gpu-context";
import { makeAsteroidMesh } from "./mesh";
import { createMeshPass, instanceLayout, type MeshPass } from "./mesh-pass";
import backgroundWGSL from "./shaders/background.wgsl" with { type: "text" };
import plumeWGSL from "./shaders/plume.wgsl" with { type: "text" };
import rockWGSL from "./shaders/rock.wgsl" with { type: "text" };
import shipWGSL from "./shaders/ship.wgsl" with { type: "text" };
import {
  ENGINES,
  makePlumeMesh,
  makeShipMesh,
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
};

const teamTint = (team: number): readonly [number, number, number] =>
  state.mono ? MONO : TEAMS[team].rgb;

// --- GPU setup ----------------------------------------------------------------

interface Passes {
  bgPipeline: GPURenderPipeline;
  bgBindGroup: GPUBindGroup;
  shipPasses: Record<ShipClass, MeshPass>;
  rockPass: MeshPass;
  plumePass: MeshPass;
}

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
    shipPasses[cls] = createMeshPass(device, {
      format,
      uniformBuffer,
      mesh: makeShipMesh(cls),
      shader: shipWGSL,
      layout: SHIP_LAYOUT,
      maxInstances: MAX_SHIPS,
      depthFormat: DEPTH_FORMAT,
      depthWrite: true,
      depthCompare: "less",
    });
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
    for (const eng of ENGINES[ship.cls]) {
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
  el("gear").innerHTML = GEAR[state.cls];
};

const wireHud = (): void => {
  const classRow = el("classRow");
  for (const cls of SHIP_CLASSES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = cls;
    b.onclick = () => {
      state.cls = cls;
      sync();
    };
    classRow.appendChild(b);
  }
  const teamRow = el("teamRow");
  TEAMS.forEach((team, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.style.background = `rgb(${team.rgb.map((c) => Math.round(c * 255)).join(",")})`;
    b.setAttribute("aria-label", `team ${team.name}`);
    b.onclick = () => {
      state.team = i;
      sync();
    };
    teamRow.appendChild(b);
  });
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
  sync();
};

wireHud();
main().catch((err) => {
  el("hud").remove();
  const div = document.createElement("div");
  div.className = "err";
  div.textContent = `Drydock needs WebGPU: ${err instanceof Error ? err.message : String(err)}`;
  document.body.appendChild(div);
});
