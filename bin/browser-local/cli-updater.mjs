// ABOUTME: Background updates for bundled agent CLIs (Codex, Claude Code) per #1637.
// ABOUTME: Fire-and-forget at startup, TTL-gated, same-channel only, silent on failure.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 24h between update checks per CLI. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Timeouts kept tight so a hung subprocess can't freeze the background task. */
const VERSION_CMD_TIMEOUT_MS = 5_000;
const NPM_VIEW_TIMEOUT_MS = 15_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;

const SEMVER_EXACT_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER_EXTRACT_RE = /\d+\.\d+\.\d+[^\s]*/;

function serenDataDir() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? os.homedir();
    return path.join(base, "Seren");
  }
  return path.join(os.homedir(), ".seren");
}

function statePath() {
  return path.join(serenDataDir(), "cli-update-state.json");
}

export function loadState() {
  try {
    const raw = readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveState(state) {
  try {
    mkdirSync(serenDataDir(), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state), "utf8");
  } catch {
    // Silent — missing persistence just means we re-check next launch.
  }
}

/**
 * Compare two semver strings. Only clean MAJOR.MINOR.PATCH triples compare;
 * anything with a pre-release suffix (e.g. "1.5.0-beta.1") returns false
 * so we never auto-update to or from a pre-release. Conservative by design.
 */
export function isNewer(installed, latest) {
  if (typeof installed !== "string" || typeof latest !== "string") return false;
  const a = installed.match(SEMVER_EXACT_RE);
  const b = latest.match(SEMVER_EXACT_RE);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const ai = Number(a[i]);
    const bi = Number(b[i]);
    if (ai !== bi) return bi > ai;
  }
  return false;
}

/**
 * Classify the install channel of a resolved binary path. Returns:
 *   - "native": installed by a native installer (claude.ai/install.sh etc.)
 *   - "npm":    installed via npm global (any flavor)
 *   - "unresolved": resolver returned the bare command name; we cannot safely
 *                   update because we don't know which install we'd be
 *                   targeting. Skip to avoid creating a shadow install that
 *                   the spawn resolver won't pick.
 */
export function classifyInstallChannel(resolvedPath, bareCommand) {
  if (typeof resolvedPath !== "string" || resolvedPath.length === 0) {
    return "unresolved";
  }
  if (resolvedPath === bareCommand) return "unresolved";

  const lower = resolvedPath.toLowerCase();
  // Native installer locations (Claude puts itself here; no Codex native today).
  if (
    lower.includes("/.claude/bin/") ||
    lower.includes("\\.claude\\bin\\") ||
    lower.includes("/.local/bin/") ||
    lower.includes("\\.local\\bin\\")
  ) {
    return "native";
  }
  // npm global wrappers
  if (
    lower.endsWith(".cmd") ||
    lower.endsWith(".ps1") ||
    lower.includes("\\npm\\") ||
    lower.includes("/npm/")
  ) {
    return "npm";
  }
  // Unix npm-global via embedded prefix/bin/<cmd>
  return "npm";
}

/**
 * Read the installed CLI's version by running the absolute resolved path
 * with `--version`. Returns the first semver-looking token or null on
 * failure. Never runs bare commands — the resolver must have produced an
 * absolute path.
 */
export async function runInstalledVersion(resolvedPath, bareCommand) {
  if (resolvedPath === bareCommand) return null; // unresolved
  if (!existsSync(resolvedPath)) return null;
  try {
    const { stdout } = await execFileAsync(resolvedPath, ["--version"], {
      timeout: VERSION_CMD_TIMEOUT_MS,
      shell: process.platform === "win32" && resolvedPath.toLowerCase().endsWith(".cmd"),
    });
    return stdout.trim().match(SEMVER_EXTRACT_RE)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Query the latest published version for a package via the bundled npm
 * (or system npm in dev). Returns the version string or null on failure.
 */
export async function runNpmView(packageName, { npmCliScript } = {}) {
  try {
    if (npmCliScript) {
      const { stdout } = await execFileAsync(
        process.execPath,
        [npmCliScript, "view", packageName, "version"],
        { timeout: NPM_VIEW_TIMEOUT_MS },
      );
      return stdout.trim();
    }
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const { stdout } = await execFileAsync(
      npmCommand,
      ["view", packageName, "version"],
      { timeout: NPM_VIEW_TIMEOUT_MS },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Install `<packageName>@latest` via the bundled npm (or system npm in
 * dev). Used only when the resolved binary is on the npm channel; never
 * cross-installs to npm when the binary came from a native installer.
 */
async function runNpmInstallLatest(packageName, { npmCliScript } = {}) {
  if (npmCliScript) {
    await execFileAsync(
      process.execPath,
      [npmCliScript, "install", "-g", `${packageName}@latest`],
      { timeout: NPM_INSTALL_TIMEOUT_MS },
    );
    return;
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await execFileAsync(
    npmCommand,
    ["install", "-g", `${packageName}@latest`],
    { timeout: NPM_INSTALL_TIMEOUT_MS },
  );
}

/**
 * Run the Claude Code native installer script. Matches the original install
 * path in agent-registry.mjs so we stay on the same channel rather than
 * silently writing a parallel npm install.
 */
async function runClaudeNativeInstaller() {
  if (process.platform === "win32") {
    await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://claude.ai/install.ps1 | iex",
      ],
      { timeout: NPM_INSTALL_TIMEOUT_MS },
    );
    return;
  }
  await execFileAsync(
    "bash",
    ["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    { timeout: NPM_INSTALL_TIMEOUT_MS },
  );
}

/**
 * Attempt the CLI's own self-update first (native-channel binaries that
 * ship `<cmd> update`, e.g. Claude Code). Returns true if the subcommand
 * exists and exited 0; false if unsupported or failed.
 */
async function tryCliSelfUpdate(resolvedPath) {
  try {
    const onWindowsCmd =
      process.platform === "win32" && resolvedPath.toLowerCase().endsWith(".cmd");
    await execFileAsync(resolvedPath, ["update"], {
      timeout: NPM_INSTALL_TIMEOUT_MS,
      shell: onWindowsCmd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget update check for a single CLI. TTL-gated; same-channel
 * only; silent on failure. Called once per app launch — two launches within
 * 24h make zero additional npm calls for this CLI.
 */
export async function backgroundUpdateCli({
  label,
  bareCommand,
  resolvedPath,
  packageName,
  npmCliScript,
  now = Date.now(),
  state,
  onUpdated,
}) {
  try {
    const persisted = state ?? loadState();
    const key = `lastUpdateCheck:${bareCommand}`;
    const lastCheck = persisted[key];
    if (typeof lastCheck === "number" && now - lastCheck < UPDATE_CHECK_TTL_MS) {
      return { skipped: "ttl" };
    }

    const channel = classifyInstallChannel(resolvedPath, bareCommand);
    if (channel === "unresolved") {
      // Don't write state — we want to re-check next launch in case the
      // install completes between now and then.
      return { skipped: "unresolved" };
    }

    const [installed, latest] = await Promise.all([
      runInstalledVersion(resolvedPath, bareCommand),
      runNpmView(packageName, { npmCliScript }),
    ]);

    // Record the check timestamp even when we couldn't compare — offline
    // and rate-limited cases should not retry every launch.
    persisted[key] = now;

    if (installed && latest && isNewer(installed, latest)) {
      try {
        if (channel === "native") {
          const selfOk = await tryCliSelfUpdate(resolvedPath);
          if (!selfOk) {
            await runClaudeNativeInstaller();
          }
        } else {
          await runNpmInstallLatest(packageName, { npmCliScript });
        }
        saveState(persisted);
        onUpdated?.({ label, bareCommand, from: installed, to: latest, channel });
        return { updated: true, from: installed, to: latest, channel };
      } catch {
        // Install failed — persist the check timestamp so we back off for
        // 24h rather than spamming the registry every launch.
        saveState(persisted);
        return { skipped: "install_failed" };
      }
    }

    saveState(persisted);
    return { skipped: "up_to_date", installed, latest };
  } catch {
    // Outermost catch-all — never allow the updater to throw into the
    // registry init path.
    return { skipped: "error" };
  }
}
