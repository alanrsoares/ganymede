import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const shadersDir = join(import.meta.dir, "../src/shaders");
const files = readdirSync(shadersDir).filter((f) => f.endsWith(".wgsl"));

console.log(`Checking ${files.length} WGSL shader(s) with vgpu...`);

let failed = 0;
for (const file of files) {
  const filePath = join(shadersDir, file);
  const result = spawnSync("bun", ["x", "vgpu", "check", filePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    console.error(`❌ ${file} failed:`);
    console.error(result.stderr.toString() || result.stdout.toString());
    failed++;
  } else {
    console.log(`✓ ${file}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} shader(s) failed validation.`);
  process.exit(1);
}

console.log("All shaders valid!\n");
