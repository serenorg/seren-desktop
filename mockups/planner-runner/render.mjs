// ABOUTME: Renders the Planner + Runner proposal mockups to PNG via Playwright/Chromium.
// ABOUTME: Run from the repo root: `node docs/proposals/planner-runner/render.mjs`.
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const shots = [
  { file: "01-launcher.html", out: "01-launcher.png", w: 900, h: 900 },
  { file: "02-config.html", out: "02-config.png", w: 900, h: 760 },
  { file: "03-thread.html", out: "03-thread.png", w: 980, h: 720 },
];

const browser = await chromium.launch();
for (const s of shots) {
  const page = await browser.newPage({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 2,
  });
  await page.goto(pathToFileURL(join(dir, s.file)).href, { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(dir, s.out), fullPage: true });
  console.log(`rendered ${s.out}`);
  await page.close();
}
await browser.close();
console.log("done");
