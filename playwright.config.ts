import { defineConfig, devices } from "@playwright/test";

const PORT = 1420;
const HOST = process.env.PLAYWRIGHT_WEB_HOST ?? "localhost";
const WEB_COMMAND = process.env.PLAYWRIGHT_WEB_COMMAND ?? "pnpm tauri dev";
const WEB_TIMEOUT = Number(process.env.PLAYWRIGHT_WEB_TIMEOUT ?? 360_000);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    browserName: "chromium",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: WEB_COMMAND,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: WEB_TIMEOUT,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
