// GPGPU parity + bench driver. Serves the harness page (Bun bundles the .ts +
// .wgsl text imports), drives a real-GPU headless Chromium via playwright, runs
// window.__bench(), prints the JSON, tears down. Real GPU because headless
// WebGPU is flaky — same launch recipe as scripts/capture-hero.ts.
//
//   bun run scripts/gpgpu-bench.ts
//
// Needs `bunx playwright install chromium`.
import { chromium } from "playwright";
import index from "../src/gpgpu/bench/index.html";

const server = Bun.serve({ port: 0, routes: { "/": index } });
const url = server.url.href;

const browser = await chromium.launch({
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan,WebGPU",
    "--use-angle=metal",
    "--window-size=400,300",
    "--window-position=-4000,0",
    "--hide-scrollbars",
  ],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => console.log("[console]", m.text()));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(
  // biome-ignore lint/suspicious/noExplicitAny: harness bridge
  () => (window as any).__bench !== undefined,
  { timeout: 10000 },
);

// biome-ignore lint/suspicious/noExplicitAny: harness bridge
const out = await page.evaluate(() => (window as any).__bench());
console.log(JSON.stringify(out, null, 2));

await browser.close();
server.stop(true);
