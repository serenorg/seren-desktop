// ABOUTME: Launches the validation-isolated Tauri app and runs a typed walkthrough scenario.
// ABOUTME: Collects DOM evidence artifacts for PR merge-gate review.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

interface DiscoveryFile {
  port: number;
  token: string;
  controlUrl: string;
  appIdentifier: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
}

interface HealthResponse {
  ok: boolean;
  frontendReady?: boolean;
}

interface ControlClient {
  command<T = unknown>(input: Record<string, unknown>): Promise<T>;
  navigate(route: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  press(key: string): Promise<unknown>;
  waitFor(selector: string, timeoutMs?: number): Promise<unknown>;
  dumpText(selector?: string): Promise<unknown>;
  screenshot(selector?: string): Promise<unknown>;
  nativeScreenshot(): Promise<unknown>;
}

interface ScenarioModule {
  default?: (ctx: ScenarioContext) => Promise<void>;
  run?: (ctx: ScenarioContext) => Promise<void>;
}

export interface ScenarioContext {
  client: ControlClient;
  artifactsDir: string;
  writeArtifact(name: string, value: unknown): Promise<void>;
}

const root = process.cwd();
const artifactsDir = path.join(root, "artifacts", "validation-walkthrough");
const discoveryPath = path.join(artifactsDir, "validation-control.json");
const scenarioName =
  process.argv[2] ?? process.env.SEREN_VALIDATION_SCENARIO ?? "app-ready";
const scenarioPath = path.join(
  root,
  "tests",
  "validation",
  "scenarios",
  `${scenarioName}.ts`,
);
const validationDevPort = 1422;
const discoveryTimeoutMs = Number(
  process.env.SEREN_VALIDATION_DISCOVERY_TIMEOUT_MS ?? 600_000,
);
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  const app = launchValidationApp();
  let discovery: DiscoveryFile | null = null;
  try {
    discovery = await waitForDiscovery(discoveryPath, discoveryTimeoutMs);
    await waitForFrontendReady(discovery, 60_000);
    const client = createClient(discovery);
    const scenario = (await import(
      pathToFileURL(scenarioPath).href
    )) as ScenarioModule;
    const run = scenario.default ?? scenario.run;
    if (!run) {
      throw new Error(`Scenario ${scenarioName} does not export default or run()`);
    }

    const manifest = {
      scenario: scenarioName,
      discovery: {
        controlUrl: discovery.controlUrl,
        appIdentifier: discovery.appIdentifier,
        pid: discovery.pid,
        createdAt: discovery.createdAt,
        expiresAt: discovery.expiresAt,
      },
      startedAt: new Date().toISOString(),
      artifactsDir,
    };
    await writeJson("manifest.json", manifest);

    await run({
      client,
      artifactsDir,
      writeArtifact: writeJson,
    });

    await writeJson("result.json", {
      ok: true,
      completedAt: new Date().toISOString(),
      scenario: scenarioName,
    });
  } finally {
    if (discovery) {
      await fetch(`${discovery.controlUrl}/quit`, {
        method: "POST",
        headers: { "x-seren-validation-token": discovery.token },
      }).catch(() => undefined);
    }
    await stopProcess(app);
    await cleanupValidationDevServer();
  }
}

async function waitForFrontendReady(
  discovery: DiscoveryFile,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    try {
      const response = await fetch(`${discovery.controlUrl}/health`);
      const health = (await response.json()) as HealthResponse;
      if (health.ok && health.frontendReady === true) return;
    } catch {
      // App is still loading; keep polling until the WebView bridge marks ready.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for validation WebView bridge readiness");
}

function launchValidationApp(): ChildProcess {
  const child = spawn(
    "pnpm",
    [
      "tauri",
      "dev",
      "--no-watch",
      "--features",
      "validation",
      "--config",
      "src-tauri/tauri.validation.conf.json",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        SEREN_VALIDATION_INSTANCE: "1",
        SEREN_VALIDATION_DISCOVERY_PATH: discoveryPath,
      },
    },
  );

  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[validate:walkthrough] app exited with code ${code}`);
    }
    if (signal) {
      console.error(`[validate:walkthrough] app exited with signal ${signal}`);
    }
  });

  return child;
}

async function waitForDiscovery(
  filePath: string,
  timeoutMs: number,
): Promise<DiscoveryFile> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as DiscoveryFile;
      if (parsed.port && parsed.token && parsed.controlUrl) {
        return parsed;
      }
    } catch {
      // Keep polling until the app publishes the atomic discovery file.
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for validation discovery file at ${filePath}`,
  );
}

function createClient(discovery: DiscoveryFile): ControlClient {
  async function command<T = unknown>(
    input: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${discovery.controlUrl}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seren-validation-token": discovery.token,
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(
        `Validation command failed ${response.status}: ${await response.text()}`,
      );
    }
    return await response.json() as T;
  }

  return {
    command,
    navigate: (route) => command({ command: "navigate", route }),
    click: (selector) => command({ command: "click", selector }),
    fill: (selector, value) => command({ command: "fill", selector, value }),
    press: (key) => command({ command: "press", key }),
    waitFor: (selector, timeoutMs = 5000) =>
      command({ command: "waitFor", selector, timeoutMs }),
    dumpText: (selector = "body") => command({ command: "dumpText", selector }),
    screenshot: (selector = "body") =>
      command({ command: "screenshot", selector }),
    nativeScreenshot: () => command({ command: "screenshot", native: true }),
  };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(
    path.join(artifactsDir, name),
    `${JSON.stringify(redact(value), null, 2)}\n`,
    "utf8",
  );
}

function redact(value: unknown): unknown {
  return redactValue(value);
}

function redactValue(value: unknown, key = ""): unknown {
  if (
    key === "dataUrl" &&
    typeof value === "string" &&
    value.startsWith("data:image/")
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.toLowerCase().includes("token") ? `${key}_redacted` : key,
        key.toLowerCase().includes("token")
          ? "[REDACTED]"
          : redactValue(entry, key),
      ]),
    );
  }
  return value;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5000).then(() => child.kill("SIGKILL")),
  ]);
}

async function cleanupValidationDevServer(): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,command="]);
    const pids = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.includes(root) &&
          line.includes("vite") &&
          line.includes(`--port ${validationDevPort}`),
      )
      .map((line) => Number(line.split(/\s+/, 1)[0]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process already exited.
      }
    }
  } catch {
    // Best-effort cleanup; the next run's port check will expose leftovers.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  await writeJson("result.json", {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    completedAt: new Date().toISOString(),
    scenario: scenarioName,
  }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
