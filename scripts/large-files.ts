const MIN_LINES = Number(process.argv[2] ?? 600);
const ROOT = `${import.meta.dir}/..`;

const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".wgsl",
  ".css",
  ".py",
]);

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".serena",
]);

const glob = new Bun.Glob("**/*");

const results: { path: string; lines: number }[] = [];

for await (const relativePath of glob.scan({ cwd: ROOT, onlyFiles: true })) {
  if (relativePath.split("/").some((part) => IGNORE_DIRS.has(part))) continue;

  const ext = relativePath.slice(relativePath.lastIndexOf("."));
  if (!EXTENSIONS.has(ext)) continue;

  const text = await Bun.file(`${ROOT}/${relativePath}`).text();
  const lines = text.split("\n").length;
  if (lines > MIN_LINES) results.push({ path: relativePath, lines });
}

results.sort((a, b) => b.lines - a.lines);

for (const { path, lines } of results) {
  console.log(`${String(lines).padStart(5)}  ${path}`);
}

if (results.length === 0) {
  console.log(`No files over ${MIN_LINES} lines.`);
}
