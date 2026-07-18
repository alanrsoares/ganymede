// Formats the working hull as catalog.ts-style TS literals — the dev-facing
// code preview in the designer's code tab. One part per line, optional fields
// (rot/mirror/seg) omitted at their defaults, floats rounded so slider noise
// never leaks into the paste-back diff.

import type {
  ArticulationDef,
  EngineAnchor,
  PartDef,
  PrimDef,
  ShipClass,
} from "~/hull/catalog";
import type { HullDef } from "./store";

const fmt = (n: number): string => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? "0" : String(r);
};

const vec = (v: readonly number[]): string => `[${v.map(fmt).join(", ")}]`;

const primTs = (p: PrimDef): string => {
  if (p.kind === "slab") {
    const bevel = p.bevel ? `, bevel: ${fmt(p.bevel)}` : "";
    return `{ kind: "slab", tx: ${fmt(p.tx)}, tz: ${fmt(p.tz)}${bevel} }`;
  }
  if (p.kind === "hex") return `{ kind: "hex", taper: ${fmt(p.taper)} }`;
  return `{ kind: "orb" }`;
};

const partTs = (p: PartDef): string => {
  const fields = [
    `prim: ${primTs(p.prim)}`,
    `scale: ${vec(p.scale)}`,
    ...(p.rot?.some((r) => r !== 0) ? [`rot: ${vec(p.rot)}`] : []),
    `pos: ${vec(p.pos)}`,
    `color: "${p.color}"`,
    ...(p.mirror ? ["mirror: true"] : []),
    ...((p.seg ?? 1) > 1 ? [`seg: ${Math.round(p.seg ?? 1)}`] : []),
  ];
  return `  { ${fields.join(", ")} },`;
};

const engineTs = (e: EngineAnchor): string =>
  `{ pos: ${vec(e.pos)}, w: ${fmt(e.w)} }`;

const articulationTs = (a: ArticulationDef): string =>
  `{ amp: ${fmt(a.amp)}, freq: ${fmt(a.freq)}, speed: ${fmt(a.speed)}, ` +
  `headStiff: ${fmt(a.headStiff)}, segLen: ${fmt(a.segLen)} }`;

/** The full paste-ready snippet: one `cls:` entry per catalog table. */
export const hullToCatalogTs = (cls: ShipClass, hull: HullDef): string =>
  [
    `// ${cls} — drydock export. Paste each entry into src/hull/catalog.ts.`,
    "",
    "// RECIPES",
    `${cls}: [`,
    ...hull.parts.map(partTs),
    "],",
    "",
    "// ENGINES",
    `${cls}: [${hull.engines.map(engineTs).join(", ")}],`,
    "",
    "// ARTICULATION",
    `${cls}: ${articulationTs(hull.articulation)},`,
  ].join("\n");
