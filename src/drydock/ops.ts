// Hull-op DSL: the machine interface into the design loop. An agent (Claude,
// via the /api/design route) reads the current hull and emits a HullOp[]; the
// store applies them through applyOp and re-bakes live. Same mutation surface
// the sliders drive, so anything the designer can do by hand an op can do.
//
// HULL_OPS_TOOL is the single source of truth for the wire schema — the server
// hands it to the Anthropic tool-use API, the reducer below consumes the same
// shape. Keep the two in sync.

import type {
  ArticulationDef,
  EngineAnchor,
  PaletteKey,
  PartDef,
  PrimDef,
  V3,
} from "~/hull/catalog";
import type { HullDef } from "./store";

export type HullOp =
  | { op: "addPart"; part: PartDef }
  | { op: "removePart"; index: number }
  | { op: "duplicatePart"; index: number }
  | { op: "setPrim"; index: number; prim: PrimDef }
  | { op: "setScale"; index: number; scale: V3 }
  | { op: "setPos"; index: number; pos: V3 }
  | { op: "setRot"; index: number; rot: V3 }
  | { op: "setColor"; index: number; color: PaletteKey }
  | { op: "setMirror"; index: number; mirror: boolean }
  | { op: "setSeg"; index: number; seg: number }
  | { op: "addEngine"; engine: EngineAnchor }
  | { op: "removeEngine"; index: number }
  | { op: "setEngine"; index: number; pos?: V3; w?: number }
  | { op: "setArticulation"; params: Partial<ArticulationDef> };

const asV3 = (v: unknown): V3 | null =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number")
    ? [v[0], v[1], v[2]]
    : null;

// One handler per op kind. Each mutates the hull in place and returns a log
// line, or null when the op is skipped (bad index, would empty a list, etc.).
// Splitting the switch into a table keeps each handler trivial and the whole
// reducer under the cognitive-complexity gate.
type Handler<K extends HullOp["op"]> = (
  hull: HullDef,
  op: Extract<HullOp, { op: K }>,
) => string | null;

type HandlerMap = { [K in HullOp["op"]]: Handler<K> };

const partAt = (hull: HullDef, i: number): PartDef | undefined => hull.parts[i];

const HANDLERS: HandlerMap = {
  addPart: (hull, op) => {
    hull.parts.push(op.part);
    return `+ part ${hull.parts.length - 1} (${op.part.prim.kind})`;
  },
  removePart: (hull, op) => {
    if (!partAt(hull, op.index) || hull.parts.length <= 1) return null;
    hull.parts.splice(op.index, 1);
    return `− part ${op.index}`;
  },
  duplicatePart: (hull, op) => {
    const p = partAt(hull, op.index);
    if (!p) return null;
    hull.parts.splice(op.index + 1, 0, structuredClone(p));
    return `copy part ${op.index}`;
  },
  setPrim: (hull, op) => {
    const p = partAt(hull, op.index);
    if (!p) return null;
    p.prim = op.prim;
    return `part ${op.index} → ${op.prim.kind}`;
  },
  setScale: (hull, op) => {
    const p = partAt(hull, op.index);
    const v = asV3(op.scale);
    if (!p || !v) return null;
    p.scale = v;
    return `part ${op.index} scale`;
  },
  setPos: (hull, op) => {
    const p = partAt(hull, op.index);
    const v = asV3(op.pos);
    if (!p || !v) return null;
    p.pos = v;
    return `part ${op.index} pos`;
  },
  setRot: (hull, op) => {
    const p = partAt(hull, op.index);
    const v = asV3(op.rot);
    if (!p || !v) return null;
    p.rot = v;
    return `part ${op.index} rot`;
  },
  setColor: (hull, op) => {
    const p = partAt(hull, op.index);
    if (!p) return null;
    p.color = op.color;
    return `part ${op.index} → ${op.color}`;
  },
  setMirror: (hull, op) => {
    const p = partAt(hull, op.index);
    if (!p) return null;
    p.mirror = op.mirror;
    return `part ${op.index} mirror ${op.mirror ? "on" : "off"}`;
  },
  setSeg: (hull, op) => {
    const p = partAt(hull, op.index);
    if (!p) return null;
    p.seg = Math.max(1, Math.round(op.seg));
    return `part ${op.index} seg ${p.seg}`;
  },
  addEngine: (hull, op) => {
    hull.engines.push(op.engine);
    return `+ engine ${hull.engines.length - 1}`;
  },
  removeEngine: (hull, op) => {
    if (!hull.engines[op.index] || hull.engines.length <= 1) return null;
    hull.engines.splice(op.index, 1);
    return `− engine ${op.index}`;
  },
  setEngine: (hull, op) => {
    const eng = hull.engines[op.index];
    if (!eng) return null;
    const pos = op.pos && asV3(op.pos);
    if (pos) eng.pos = pos;
    if (typeof op.w === "number") eng.w = op.w;
    return `engine ${op.index}`;
  },
  setArticulation: (hull, op) => {
    const a = hull.articulation as unknown as Record<string, number>;
    for (const [k, val] of Object.entries(op.params)) {
      if (typeof val === "number") a[k] = val;
    }
    return "articulation";
  },
};

/** Apply one op to a working hull in place. Out-of-range or malformed ops are
 * skipped and reported (never throw — a bad op in a batch must not lose the
 * good ones). Returns a human line for the activity log, or null if skipped. */
export const applyOp = (hull: HullDef, op: HullOp): string | null => {
  const handler = HANDLERS[op.op] as Handler<HullOp["op"]>;
  return handler ? handler(hull, op) : null;
};

// --- Anthropic tool schema ---------------------------------------------------
// A lenient single-object shape per op (op enum + optional fields); the reducer
// above is the strict half. This keeps the schema compact and forgiving for the
// model while applyOp guards every field.

const V3_SCHEMA = {
  type: "array",
  items: { type: "number" },
  minItems: 3,
  maxItems: 3,
} as const;

const PRIM_SCHEMA = {
  type: "object",
  description:
    'A convex primitive. slab = tapered box along +Y (tx/tz taper the nose quad, bevel rounds edges); hex = tapered hex prism; orb = sphere. e.g. {"kind":"slab","tx":0.4,"tz":0.5,"bevel":0.06}',
  properties: {
    kind: { type: "string", enum: ["slab", "hex", "orb"] },
    tx: { type: "number", description: "slab nose x-taper 0.02–1" },
    tz: { type: "number", description: "slab nose z-taper 0.02–1" },
    bevel: { type: "number", description: "slab edge bevel 0–0.24" },
    taper: { type: "number", description: "hex nose taper 0.02–1" },
  },
  required: ["kind"],
} as const;

const PART_SCHEMA = {
  type: "object",
  properties: {
    prim: PRIM_SCHEMA,
    scale: { ...V3_SCHEMA, description: "per-axis scale before rotation" },
    rot: { ...V3_SCHEMA, description: "Euler radians, applied Rz·Ry·Rx" },
    pos: { ...V3_SCHEMA, description: "position; nose is +Y, body ≈ ±1.1" },
    color: {
      type: "string",
      enum: ["bone", "carapace", "sinew", "fang", "acid", "eye", "maw"],
    },
    mirror: { type: "boolean", description: "also bake an x-mirrored copy" },
    seg: {
      type: "integer",
      description:
        "centipede segmentation: split into N carapace plates (1 = solid)",
    },
  },
  required: ["prim", "scale", "pos", "color"],
} as const;

export const HULL_OPS_TOOL = {
  name: "apply_hull_ops",
  description:
    "Apply an ordered list of edits to the current ship hull. Part indices refer to the hull's current part list (0-based); addPart appends to the end, so later ops in the same batch can target the new index. Emit only the ops needed for the request — do not restate unchanged parts.",
  input_schema: {
    type: "object",
    properties: {
      note: {
        type: "string",
        description:
          "One short line summarising the change, shown to the user.",
      },
      ops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [
                "addPart",
                "removePart",
                "duplicatePart",
                "setPrim",
                "setScale",
                "setPos",
                "setRot",
                "setColor",
                "setMirror",
                "setSeg",
                "addEngine",
                "removeEngine",
                "setEngine",
                "setArticulation",
              ],
            },
            index: { type: "integer", description: "target part/engine index" },
            part: PART_SCHEMA,
            prim: PRIM_SCHEMA,
            scale: V3_SCHEMA,
            pos: V3_SCHEMA,
            rot: V3_SCHEMA,
            color: {
              type: "string",
              enum: ["bone", "carapace", "sinew", "fang", "acid", "eye", "maw"],
            },
            mirror: { type: "boolean" },
            seg: { type: "integer" },
            engine: {
              type: "object",
              properties: { pos: V3_SCHEMA, w: { type: "number" } },
              required: ["pos", "w"],
            },
            w: { type: "number" },
            params: {
              type: "object",
              description: "articulation params to set (any subset)",
              properties: {
                amp: { type: "number", description: "wave amplitude 0–0.3" },
                freq: { type: "number", description: "wave frequency 1–8" },
                speed: { type: "number", description: "swim speed 0–3" },
                headStiff: {
                  type: "number",
                  description: "rigid-head cutoff y −0.5–0.9",
                },
                segLen: {
                  type: "number",
                  description: "hinge segment length 0–0.6 (0 = smooth)",
                },
              },
            },
          },
          required: ["op"],
        },
      },
    },
    required: ["ops", "note"],
  },
} as const;
