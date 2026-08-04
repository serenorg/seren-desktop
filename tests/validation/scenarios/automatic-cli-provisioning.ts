// ABOUTME: Proves first-run coding-agent CLI provisioning in the real validation app.
// ABOUTME: Compares every launcher row with the live native registry without mocks.

import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface LiveAgent {
  type?: string;
  name?: string;
  available?: boolean;
}

interface LiveTerminalBuffer {
  id?: string;
  cliKind?: "claude" | "codex" | null;
  status?: "running" | "exited";
}

const TARGETS = [
  {
    type: "claude-code",
    testId: "new-claude-agent",
    label: "Claude Code",
  },
  { type: "codex", testId: "new-codex-agent", label: "Codex" },
  {
    type: "claude-codex",
    testId: "new-claude-codex-agent",
    label: "Claude + Codex",
  },
  { type: "gemini", testId: "new-gemini-agent", label: "Antigravity" },
  { type: "grok", testId: "new-grok-agent", label: "Grok" },
  {
    type: "lmstudio",
    testId: "new-lmstudio-agent",
    label: "LM Studio Agent",
  },
] as const;

const CLI_LAUNCHERS = [
  { cliKind: "claude", testId: "new-claude-cli", label: "Claude Code" },
  { cliKind: "codex", testId: "new-codex-cli", label: "Codex" },
] as const;

const execFileAsync = promisify(execFile);
const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function managedCliBinary(validationHome: string, command: string): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("Windows validation requires APPDATA");
    return path.join(appData, "Seren", "cli-tools", `${command}.cmd`);
  }
  return path.join(validationHome, ".seren", "cli-tools", "bin", command);
}

function antigravityBinary(validationHome: string): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("Windows validation requires LOCALAPPDATA");
    return path.join(localAppData, "agy", "bin", "agy.exe");
  }
  return path.join(validationHome, ".local", "bin", "agy");
}

async function readVersion(binary: string): Promise<string | null> {
  try {
    if (path.isAbsolute(binary)) await access(binary);
    const { stdout } = await execFileAsync(binary, ["--version"], {
      encoding: "utf8",
      shell:
        process.platform === "win32" &&
        (!path.isAbsolute(binary) || binary.endsWith(".cmd")),
      timeout: 15_000,
    });
    return stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  } catch {
    return null;
  }
}

async function waitForUsableClis(
  validationHome: string,
): Promise<{
  versions: Record<string, string>;
  serenManaged: Record<string, boolean>;
}> {
  const candidates = {
    claude: [managedCliBinary(validationHome, "claude"), "claude"],
    codex: [managedCliBinary(validationHome, "codex"), "codex"],
    grok: [managedCliBinary(validationHome, "grok"), "grok"],
    antigravity: [antigravityBinary(validationHome), "agy"],
  };
  const started = Date.now();
  while (Date.now() - started <= 360_000) {
    const resolved = Object.fromEntries(
      await Promise.all(
        Object.entries(candidates).map(async ([name, binaries]) => {
          for (const [index, binary] of binaries.entries()) {
            const version = await readVersion(binary);
            if (version) return [name, { version, serenManaged: index === 0 }];
          }
          return [name, null];
        }),
      ),
    );
    if (Object.values(resolved).every(Boolean)) {
      const entries = Object.entries(resolved) as Array<
        [string, { version: string; serenManaged: boolean }]
      >;
      return {
        versions: Object.fromEntries(
          entries.map(([name, result]) => [name, result.version]),
        ),
        serenManaged: Object.fromEntries(
          entries.map(([name, result]) => [name, result.serenManaged]),
        ),
      };
    }
    await sleep(1_000);
  }
  throw new Error("Timed out waiting for automatic managed CLI provisioning");
}

async function assertAbsent(
  ctx: ScenarioContext,
  selector: string,
): Promise<void> {
  try {
    await ctx.client.waitFor(selector, 250);
  } catch {
    return;
  }
  throw new Error(`Unexpected user-intervention control: ${selector}`);
}

async function assertRunningCliTerminal(
  ctx: ScenarioContext,
  cliKind: "claude" | "codex",
): Promise<void> {
  await sleep(1_500);
  const buffers = (await ctx.client.command({
    command: "readState",
    invokeName: "terminal_list_buffers",
  })) as LiveTerminalBuffer[];
  const matching = Array.isArray(buffers)
    ? buffers.filter((buffer) => buffer.cliKind === cliKind).at(-1)
    : undefined;
  if (!matching?.id || matching.status !== "running") {
    throw new Error(
      `${cliKind} terminal did not stay running after its real CLI launch`,
    );
  }
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const projectPath = path.join(
    os.tmpdir(),
    "seren-cli-provisioning-walkthrough",
  );
  await mkdir(projectPath, { recursive: true });
  await ctx.client.command({ command: "setRootPath", path: projectPath });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);

  const clis = await waitForUsableClis(ctx.validationHome);
  await assertAbsent(ctx, "[data-testid='cli-update-action-required']");

  const liveAgents = (await ctx.client.command({
    command: "readState",
    invokeName: "provider_get_available_agents",
  })) as LiveAgent[];
  if (!Array.isArray(liveAgents)) {
    throw new Error("The native provider runtime did not return an agent list");
  }
  const liveTypes = liveAgents
    .filter((agent): agent is LiveAgent & { type: string } =>
      Boolean(agent.type),
    )
    .map((agent) => agent.type);
  const expectedTypes = TARGETS.map((target) => target.type);
  if (
    liveTypes.length !== expectedTypes.length ||
    expectedTypes.some((type) => !liveTypes.includes(type))
  ) {
    throw new Error(
      `Live registry mismatch: expected ${expectedTypes.join(", ")}; received ${liveTypes.join(", ")}`,
    );
  }

  await ctx.client.click("[data-testid='new-thread-button']");
  for (const target of TARGETS) {
    const selector = `[data-testid='${target.testId}']`;
    await ctx.client.waitFor(selector, 10_000);
    const row = (await ctx.client.dumpText(selector)) as { text?: string };
    if (!row.text?.includes(target.label)) {
      throw new Error(`${target.type} launcher omitted ${target.label}`);
    }
    await ctx.writeArtifact(
      `launcher-${target.type}.json`,
      await ctx.client.screenshot(selector),
    );
  }
  for (const launcher of CLI_LAUNCHERS) {
    const selector = `[data-testid='${launcher.testId}']`;
    await ctx.client.waitFor(selector, 10_000);
    const row = (await ctx.client.dumpText(selector)) as { text?: string };
    if (!row.text?.includes(launcher.label)) {
      throw new Error(`${launcher.cliKind} CLI launcher omitted ${launcher.label}`);
    }
    await ctx.writeArtifact(
      `launcher-${launcher.cliKind}-cli.json`,
      await ctx.client.screenshot(selector),
    );
  }
  await assertAbsent(ctx, "[data-testid='cli-update-action-required']");

  for (const launcher of CLI_LAUNCHERS) {
    await ctx.client.click(`[data-testid='${launcher.testId}']`);
    await ctx.client.waitFor(
      "[data-testid='terminal-launch-mode-toggle']",
      20_000,
    );
    await assertRunningCliTerminal(ctx, launcher.cliKind);
    if (launcher.cliKind === "claude") {
      await ctx.client.waitFor("[data-testid='claude-cli-version-pill']", 20_000);
    }
    await ctx.writeArtifact(
      `running-${launcher.cliKind}-cli.json`,
      await ctx.client.screenshot(),
    );
    if (launcher.cliKind !== CLI_LAUNCHERS.at(-1)?.cliKind) {
      await ctx.client.click("[data-testid='new-thread-button']");
    }
  }

  await ctx.writeArtifact("automatic-cli-provisioning-result.json", {
    platform: process.platform,
    architecture: process.arch,
    cliVersions: clis.versions,
    serenManagedInstall: clis.serenManaged,
    liveAgentTypes: liveTypes,
    launcherAgentTypes: expectedTypes,
    launcherCliKinds: CLI_LAUNCHERS.map((launcher) => launcher.cliKind),
    everyManagedCliUsable: Object.keys(clis.versions).length === 4,
    everyLiveLocalAgentRendered: liveTypes.length === TARGETS.length,
    everyCliTerminalLaunched: true,
    userInterventionRequired: false,
  });

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
