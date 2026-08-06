// ABOUTME: Drives two running-terminal folder groups and captures the sidebar headers.
// ABOUTME: Asserts folder headers show a total count with no green "active" running dot.

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

const SIDEBAR = "[data-testid='thread-sidebar']";
// Within the sidebar the green "active" dot was the only bg-green-500 element;
// per-row and footer running indicators use bg-status-running instead.
const RUNNING_DOT = "[data-testid='thread-sidebar'] .bg-green-500";
const NEW_MENU = "[data-testid='new-thread-button']";
const NEW_TERMINAL = "[data-testid='new-terminal']";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RasterResult {
  dataUrl?: string;
  rasterSuccess?: boolean;
  method?: string;
  buildCommit?: string;
}

async function savePng(
  artifactsDir: string,
  name: string,
  shot: RasterResult | undefined,
): Promise<boolean> {
  const dataUrl = shot?.dataUrl;
  const match =
    typeof dataUrl === "string" ? dataUrl.match(/^data:image\/[^;]+;base64,/) : null;
  if (!match) return false;
  const base64 = dataUrl.slice(match[0].length);
  await writeFile(path.join(artifactsDir, name), Buffer.from(base64, "base64"));
  return true;
}

async function createRunningTerminalFolder(
  client: ScenarioContext["client"],
  dir: string,
): Promise<void> {
  await client.command({ command: "setRootPath", path: dir });
  await client.click(NEW_MENU);
  await client.waitFor(NEW_TERMINAL, 8_000);
  await client.click(NEW_TERMINAL);
  // A fresh terminal buffer reports status "running" until its shell exits,
  // which is what a folder group keys its "active" state off of.
  await sleep(1_500);
}

// Absence probe: waitFor throws a "Timed out" error when the selector never
// becomes visible. We treat that timeout as "the dot is gone" and any resolve
// as "the dot is still present".
async function runningDotPresent(
  client: ScenarioContext["client"],
): Promise<boolean> {
  try {
    await client.waitFor(RUNNING_DOT, 2_000);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Timed out")) return false;
    throw error;
  }
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const { client, artifactsDir } = ctx;
  await client.waitFor(SIDEBAR, 30_000);

  // Folder group headers only render when more than one project group exists,
  // so create two folders, each anchored by a running terminal thread.
  const dirA = path.join(os.tmpdir(), "seren-3723-folder-alpha");
  const dirB = path.join(os.tmpdir(), "seren-3723-folder-beta");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });

  await createRunningTerminalFolder(client, dirA);
  await createRunningTerminalFolder(client, dirB);
  await sleep(1_000);

  const sidebarText = await client.dumpText(SIDEBAR);
  await ctx.writeArtifact("sidebar-text.json", sidebarText);

  const domShot = (await client.screenshot(SIDEBAR)) as RasterResult;
  await ctx.writeArtifact("sidebar-dom-screenshot.json", {
    ...domShot,
    dataUrl: undefined,
  });
  const domSaved = await savePng(artifactsDir, "sidebar-dom.png", domShot);

  let nativeShot: RasterResult | undefined;
  let nativeSaved = false;
  try {
    nativeShot = (await client.nativeScreenshot()) as RasterResult;
    await ctx.writeArtifact("sidebar-native-screenshot.json", {
      ...nativeShot,
      dataUrl: undefined,
    });
    nativeSaved = await savePng(artifactsDir, "sidebar-native.png", nativeShot);
  } catch (error) {
    await ctx.writeArtifact("sidebar-native-screenshot.json", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const dotPresent = await runningDotPresent(client);

  await ctx.writeArtifact("verification.json", {
    scenario: "folder-header-active-dot",
    runningFolders: [path.basename(dirA), path.basename(dirB)],
    runningDotPresentInSidebar: dotPresent,
    expectation:
      "folder headers show a total thread count with no green active dot even while folders have running threads",
    evidence: {
      domRasterSaved: domSaved,
      nativeCaptureSaved: nativeSaved,
    },
    buildCommit: domShot?.buildCommit ?? null,
  });

  if (dotPresent) {
    throw new Error(
      "Regression: folder header still renders a green .bg-green-500 active dot while folders have running threads.",
    );
  }
}
