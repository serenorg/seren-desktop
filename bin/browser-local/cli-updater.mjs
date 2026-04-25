// ABOUTME: Background updates for bundled agent CLIs (Codex, Claude Code) per #1637.
// ABOUTME: Fire-and-forget at startup, TTL-gated, same-channel only, silent on failure.

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { npmPackToDirectory, scanTarball } from "./cli-scanner.mjs";

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
  // Test-only override so tests can exercise saveState/loadState atomicity
  // without touching the user's real ~/.seren/cli-update-state.json. Not a
  // user-facing knob — undocumented on purpose.
  const override = process.env.SEREN_CLI_UPDATER_STATE_PATH;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
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
  // Atomic write: serialize to a temp sibling, then rename. rename(2) is
  // atomic on POSIX and on Windows NTFS for same-volume same-directory
  // renames, which we satisfy by keeping the .tmp next to the target.
  // Without this, a crash mid-write corrupts cli-update-state.json; loadState
  // tolerates the parse error by returning {}, but TTL timestamps are lost
  // and the updater re-checks every launch until network recovers — turning
  // a transient registry blip into a launch-amplified hammer. See #1644.
  const target = statePath();
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(serenDataDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, target);
  } catch {
    // Best-effort tmp cleanup so a previous failed write doesn't leak.
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up — silent.
    }
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
 * Install from an already-downloaded local tarball. Used after the scanner
 * passes — we install the exact bytes we scanned, not whatever the registry
 * serves at install time. Eliminates the post-scan/pre-install TOCTOU window.
 */
async function runNpmInstallFromTarball(tarballPath, { npmCliScript } = {}) {
  if (npmCliScript) {
    await execFileAsync(
      process.execPath,
      [npmCliScript, "install", "-g", tarballPath],
      { timeout: NPM_INSTALL_TIMEOUT_MS },
    );
    return;
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await execFileAsync(
    npmCommand,
    ["install", "-g", tarballPath],
    { timeout: NPM_INSTALL_TIMEOUT_MS },
  );
}

/**
 * Per-CLI hostname allowlists for the static-check scanner. Strings the
 * upstream's published code is expected to contain; anything outside this
 * set in a flagged file gets a `unallowed_host` flag (#1647).
 *
 * Use parent domains — suffix matching in the scanner accepts subdomains.
 */
const HOSTNAME_ALLOWLIST = {
  "@anthropic-ai/claude-code": [
    "anthropic.com",
    "claude.ai",
    "claude.com",
    "github.com",
    "githubusercontent.com",
    "googleapis.com",
    "amazonaws.com",
  ],
  "@openai/codex": [
    "openai.com",
    "oaistatic.com",
    "github.com",
    "githubusercontent.com",
  ],
};

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
  // Test seams — production callers leave these undefined and the real
  // scanner runs against npm.
  _scannerOverrides,
}) {
  const packFn = _scannerOverrides?.npmPackToDirectory ?? npmPackToDirectory;
  const scanFn = _scannerOverrides?.scanTarball ?? scanTarball;
  const installFromTarballFn =
    _scannerOverrides?.runNpmInstallFromTarball ?? runNpmInstallFromTarball;
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
      // Native installs are gated by the upstream's signed installer + their
      // own self-update mechanism; we don't have a tarball to scan. Keep
      // existing flow. npm channel updates are scanned per #1647.
      if (channel === "native") {
        try {
          const selfOk = await tryCliSelfUpdate(resolvedPath);
          if (!selfOk) {
            await runClaudeNativeInstaller();
          }
          saveState(persisted);
          onUpdated?.({
            label,
            bareCommand,
            from: installed,
            to: latest,
            channel,
          });
          return { updated: true, from: installed, to: latest, channel };
        } catch {
          saveState(persisted);
          return { skipped: "install_failed" };
        }
      }

      // npm channel: pack-extract-scan-install-baseline.
      const stagingDir = path.join(
        serenDataDir(),
        "scan-staging",
        bareCommand,
        latest,
      );
      // Best-effort cleanup of any leftover staging from a prior crashed run.
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // Silent.
      }
      try {
        const tarballPath = await packFn({
          packageName,
          version: latest,
          destinationDir: stagingDir,
          npmCliScript,
        });
        const baseline = persisted[`baseline:${packageName}`];
        const scan = await scanFn({
          tarballPath,
          baseline,
          workDir: path.join(stagingDir, "extracted"),
          hostnameAllowlist: HOSTNAME_ALLOWLIST[packageName] ?? [],
        });

        if (scan.verdict === "reject") {
          // Quarantine: leave the rejected tarball + flag list on disk under
          // ~/.seren/scan-rejected/<cli>/<version>/ for later inspection.
          const quarantine = path.join(
            serenDataDir(),
            "scan-rejected",
            bareCommand,
            latest,
          );
          try {
            mkdirSync(quarantine, { recursive: true });
            writeFileSync(
              path.join(quarantine, "flags.json"),
              JSON.stringify({ flags: scan.flags, version: latest }, null, 2),
              "utf8",
            );
          } catch {
            // Best-effort — never fail the update path on quarantine I/O.
          }
          persisted[`lastScanReject:${packageName}`] = {
            version: latest,
            flags: scan.flags,
            at: now,
          };
          saveState(persisted);
          // Cleanup staging now that we've recorded the rejection.
          try {
            rmSync(stagingDir, { recursive: true, force: true });
          } catch {
            // Silent.
          }
          return {
            skipped: "scan_rejected",
            from: installed,
            to: latest,
            flags: scan.flags,
          };
        }

        // verdict is "pass" or "no_baseline" — install. First install of a
        // CLI is unguarded by design (no baseline to diff against); the
        // candidate snapshot becomes the seed baseline so subsequent
        // updates ARE scanned.
        try {
          await installFromTarballFn(tarballPath, { npmCliScript });
        } catch {
          saveState(persisted);
          try {
            rmSync(stagingDir, { recursive: true, force: true });
          } catch {
            // Silent.
          }
          return { skipped: "install_failed" };
        }

        persisted[`baseline:${packageName}`] = {
          version: latest,
          tarballSha512: scan.candidate.tarballSha512,
          installScripts: scan.candidate.installScripts,
          declaredDependencies: scan.candidate.declaredDependencies,
          files: scan.candidate.files,
          fileHashes: scan.candidate.fileHashes,
        };
        saveState(persisted);
        onUpdated?.({
          label,
          bareCommand,
          from: installed,
          to: latest,
          channel,
          tarballSha512: scan.candidate.tarballSha512,
        });
        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // Silent.
        }
        return {
          updated: true,
          from: installed,
          to: latest,
          channel,
          tarballSha512: scan.candidate.tarballSha512,
          firstInstall: scan.verdict === "no_baseline",
        };
      } catch {
        // Pack/scan failure — fail closed. Don't update.
        saveState(persisted);
        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // Silent.
        }
        return { skipped: "scan_error" };
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
