// Apply drydock working hulls back into src/hull/catalog.ts — the last mile of
// the design loop. Pulls tuned hulls from a running drydock tab (via the
// /api/agent bridge, cmd getAll) or a JSON file, regenerates the catalog data
// tables in the same builder style the file is authored in, and rewrites them
// in place.
//
// Usage:
//   bun run scripts/apply-hull-catalog.ts            # dry-run from live drydock
//   bun run scripts/apply-hull-catalog.ts --write    # write ENGINES + ARTICULATION
//   bun run scripts/apply-hull-catalog.ts --write --recipes   # also RECIPES *
//   bun run scripts/apply-hull-catalog.ts --file hulls.json --write
//
// * --recipes overwrites the hand-authored RECIPES part arrays. The generated
//   literals are valid and builder-styled, but the in-source design comments
//   are lost — review the diff before committing.

type V3 = [number, number, number];
type Prim =
  | { kind: "slab"; tx: number; tz: number; bevel?: number }
  | { kind: "hex"; taper: number }
  | { kind: "orb" };
interface Part {
  prim: Prim;
  scale: V3;
  rot?: V3;
  pos: V3;
  color: string;
  mirror?: boolean;
  seg?: number;
}
interface Engine {
  pos: V3;
  w: number;
}
interface Articulation {
  amp: number;
  freq: number;
  speed: number;
  headStiff: number;
  segLen: number;
}
interface Hull {
  parts: Part[];
  engines: Engine[];
  articulation: Articulation;
}
type Hulls = Record<string, Hull>;

const DEFAULT_CATALOG = new URL("../src/hull/catalog.ts", import.meta.url)
  .pathname;

// --- number / literal formatting (matches catalog.ts authored style) ---------

const n = (x: number): string => {
  const r = Math.round(x * 1e4) / 1e4;
  return Object.is(r, -0) ? "0" : String(r);
};
const vec = (v: V3): string => `[${v.map(n).join(", ")}]`;
const rad2deg = (r: number): string =>
  r === 0 ? "0" : `deg(${Math.round((r * 180) / Math.PI)})`;

const primSrc = (p: Prim): string => {
  if (p.kind === "slab") {
    const b = p.bevel ? `, ${n(p.bevel)}` : "";
    return `SLAB(${n(p.tx)}, ${n(p.tz)}${b})`;
  }
  if (p.kind === "hex") return `HEX(${n(p.taper)})`;
  return "ORB";
};

const partSrc = (p: Part): string => {
  const lines = [
    `    prim: ${primSrc(p.prim)},`,
    `    scale: ${vec(p.scale)},`,
    ...(p.rot?.some((r) => r !== 0)
      ? [`    rot: [${p.rot.map(rad2deg).join(", ")}],`]
      : []),
    `    pos: ${vec(p.pos)},`,
    `    color: "${p.color}",`,
    ...(p.mirror ? ["    mirror: true,"] : []),
    ...((p.seg ?? 1) > 1 ? [`    seg: ${Math.round(p.seg ?? 1)},`] : []),
  ];
  return `  {\n${lines.join("\n")}\n  },`;
};

const recipeSrc = (parts: Part[]): string => parts.map(partSrc).join("\n");

const enginesSrc = (hulls: Hulls): string =>
  Object.entries(hulls)
    .map(([cls, h]) => {
      const list = h.engines
        .map((e) => `{ pos: ${vec(e.pos)}, w: ${n(e.w)} }`)
        .join(", ");
      return `  ${cls}: [${list}],`;
    })
    .join("\n");

const articulationSrc = (hulls: Hulls): string =>
  Object.entries(hulls)
    .map(([cls, h]) => {
      const a = h.articulation;
      return `  ${cls}: { amp: ${n(a.amp)}, freq: ${n(a.freq)}, speed: ${n(a.speed)}, headStiff: ${n(a.headStiff)}, segLen: ${n(a.segLen)} },`;
    })
    .join("\n");

// --- comment/string-aware block finder ---------------------------------------
// Scans from an opening bracket to its match, skipping brackets inside //, /*,
// and string literals so comments in the recipe bodies never miscount.

type Mode = "code" | "line" | "block" | "str";

/** Advance one non-code mode (comment/string). Returns the mode after the
 * char and whether the next char was already consumed (escape / close pair). */
const advance = (mode: Mode, c: string, c2: string, quote: string) => {
  if (mode === "line")
    return { mode: c === "\n" ? "code" : "line", skip: false };
  if (mode === "block") {
    const done = c === "*" && c2 === "/";
    return { mode: done ? "code" : "block", skip: done };
  }
  if (c === "\\") return { mode: "str" as Mode, skip: true };
  return { mode: c === quote ? "code" : "str", skip: false };
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat lexer loop reads clearer whole than split across more helpers
function matchBracket(
  src: string,
  openIdx: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let mode: Mode = "code";
  let quote = "";
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode !== "code") {
      const step = advance(mode, c, c2, quote);
      mode = step.mode as Mode;
      if (step.skip) i++;
    } else if (c === "/" && (c2 === "/" || c2 === "*")) {
      mode = c2 === "/" ? "line" : "block";
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      mode = "str";
      quote = c;
    } else if (c === open) {
      depth++;
    } else if (c === close && --depth === 0) {
      return i;
    }
  }
  throw new Error("unbalanced block — no matching close bracket");
}

/** Replace the body between an anchor's trailing open bracket and its match. */
const replaceBlock = (
  src: string,
  anchor: string,
  open: string,
  close: string,
  body: string,
): string => {
  const aIdx = src.indexOf(anchor);
  if (aIdx < 0) throw new Error(`anchor not found: ${anchor}`);
  const openIdx = aIdx + anchor.length - 1; // anchor ends with the open char
  const closeIdx = matchBracket(src, openIdx, open, close);
  return `${src.slice(0, openIdx + 1)}\n${body}\n${src.slice(closeIdx)}`;
};

// --- input -------------------------------------------------------------------

const readHulls = async (file: string | null, port: string): Promise<Hulls> => {
  if (file) return JSON.parse(await Bun.file(file).text()) as Hulls;
  const res = await fetch(`http://localhost:${port}/api/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "getAll" }),
  });
  const data = (await res.json()) as { result?: Hulls; error?: string };
  if (!res.ok || data.error || !data.result) {
    throw new Error(
      data.error ??
        "no hulls from drydock — is `bun run web` up with /drydock open?",
    );
  }
  return data.result;
};

// --- main --------------------------------------------------------------------

const flag = (name: string): boolean => process.argv.includes(name);
const opt = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const write = flag("--write");
const withRecipes = flag("--recipes");
const port = opt("--port") ?? process.env.PORT ?? "3000";
const catalog = opt("--catalog") ?? DEFAULT_CATALOG;

const hulls = await readHulls(opt("--file"), port);
const classes = Object.keys(hulls);
console.log(`hulls: ${classes.join(", ")}`);

let src = await Bun.file(catalog).text();

src = replaceBlock(
  src,
  "export const ENGINES: Record<keyof typeof RECIPES, readonly EngineAnchor[]> = {",
  "{",
  "}",
  enginesSrc(hulls),
);
src = replaceBlock(
  src,
  "export const ARTICULATION: Record<ShipClass, ArticulationDef> = {",
  "{",
  "}",
  articulationSrc(hulls),
);

if (withRecipes) {
  console.warn(
    "⚠ --recipes: overwriting RECIPES; in-source design comments will be lost",
  );
  for (const cls of classes) {
    src = replaceBlock(
      src,
      `const ${cls.toUpperCase()}: PartDef[] = [`,
      "[",
      "]",
      recipeSrc(hulls[cls].parts),
    );
  }
}

if (write) {
  await Bun.write(catalog, src);
  console.log(
    `wrote ${catalog}\n→ run \`bun run check\` (formats) and \`bun test\` before committing`,
  );
} else {
  console.log(
    `\n--- dry run (pass --write to apply${withRecipes ? "" : "; --recipes to include part arrays"}) ---\n`,
  );
  console.log("ENGINES:\n", enginesSrc(hulls));
  console.log("\nARTICULATION:\n", articulationSrc(hulls));
}
