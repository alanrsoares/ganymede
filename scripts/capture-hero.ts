// Capture the README hero straight from the live game — a real WebGPU frame,
// not a mockup. Boots a headed Chromium (real Metal/Vulkan GPU, since headless
// WebGPU is unreliable), drives the welcome splash into an Autobattle match,
// lets the fleets engage, and screenshots the running scene.
//
//   bun run hero                       # -> docs/hero.png (default CHAOS match)
//   CAP_PRESET=Standard bun run hero   # different preset
//   CAP_FRAMES=6 bun run hero          # burst mode: hero-0.png … for picking
//
// Needs the dev server up (`bun run web`) and `bunx playwright install chromium`.
import { chromium } from "playwright";

const URL = process.env.CAP_URL ?? "http://localhost:3000/";
const OUT = process.env.CAP_OUT ?? "docs/hero.png";
const PRESET = process.env.CAP_PRESET ?? "CHAOS"; // Duel | Standard | Chaos | Sandbox
const SETTLE = Number(process.env.CAP_SETTLE ?? 16000); // ms of combat before the shot
const FRAMES = Number(process.env.CAP_FRAMES ?? 1); // >1 = burst for frame-picking
const STEP = Number(process.env.CAP_STEP ?? 2500); // ms between burst frames
const W = 1920;
const H = 1080;

const browser = await chromium.launch({
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan,WebGPU",
    "--use-angle=metal",
    `--window-size=${W},${H}`,
    "--window-position=-4000,0", // keep the window off the visible desktop
    "--hide-scrollbars",
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

if (!(await page.evaluate(() => "gpu" in navigator))) {
  console.error("navigator.gpu missing — WebGPU unavailable in this Chromium.");
  await browser.close();
  process.exit(1);
}

// Welcome splash -> Autobattle setup -> chosen preset -> launch.
await page.getByRole("button", { name: "Autobattle" }).click({ timeout: 8000 });
await page.waitForTimeout(600);
try {
  await page
    .getByText(PRESET, { exact: false })
    .first()
    .click({ timeout: 3000 });
} catch {
  console.log(`preset "${PRESET}" not found — using defaults`);
}
await page.waitForTimeout(300);
await page
  .getByRole("button", { name: "Launch Match" })
  .click({ timeout: 8000 });

// Camera settle + chrome fade + first engagements.
await page.waitForTimeout(SETTLE);

if (FRAMES > 1) {
  const base = OUT.replace(/\.png$/, "");
  for (let i = 0; i < FRAMES; i++) {
    await page.screenshot({ path: `${base}-${i}.png` });
    console.log("frame ->", `${base}-${i}.png`);
    if (i < FRAMES - 1) await page.waitForTimeout(STEP);
  }
} else {
  await page.screenshot({ path: OUT });
  console.log("hero ->", OUT);
}

await browser.close();
