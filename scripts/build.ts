// Production build for the WebGPU SPA.
//
// `bun build <html>` on the CLI does not apply the Tailwind plugin (that's only
// wired for the dev server via bunfig's [serve.static]), so a raw
// `@import "tailwindcss"` would ship uncompiled. This script runs the bundler
// through the Bun.build API with the plugin registered, then copies the runtime
// texture assets the sim fetches from the absolute /assets path at runtime.

import { $ } from "bun";
import tailwind from "bun-plugin-tailwind";

const OUT = "dist";

await $`rm -rf ${OUT}`;

const result = await Bun.build({
  entrypoints: ["src/index.html"],
  outdir: OUT,
  plugins: [tailwind],
  minify: true,
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Textures load from an absolute `/assets/...` URL at runtime, so they must sit
// at the site root next to index.html.
await $`cp -R src/assets ${OUT}/assets`;

console.log(`Built ${result.outputs.length} files → ${OUT}/ (+ assets)`);
