// ABOUTME: Background updates for bundled agent CLIs (Codex, Claude Code) per #1637.
// ABOUTME: Verifies candidate bytes and post-update health before reporting success.

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

import {
  evaluateFirstBaselinePolicy,
  npmPackToDirectory,
  scanTarball,
  verifyTarballIntegrity,
} from "./cli-scanner.mjs";

const execFileAsync = promisify(execFile);

/** 24h between update checks per CLI. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Timeouts kept tight so a hung subprocess can't freeze the background task. */
const VERSION_CMD_TIMEOUT_MS = 5_000;
const NPM_VIEW_TIMEOUT_MS = 15_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;

const SEMVER_EXACT_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SEMVER_EXTRACT_RE = /\d+\.\d+\.\d+[^\s]*/;

/**
 * Per-package minimum required version. When the resolved binary is below
 * the baseline we ignore the 24h TTL and force an update on the next launch.
 * This unsticks installs that were poisoned by an old `cli-tools/package.json`
 * caret pin (e.g. `^2.1.30`) or by a transient registry failure that the TTL
 * then masked for months. #1761 set this to 2.1.120 for the JS→native
 * migration boundary and the Opus 4.7 catalog; #2810 raises it so a stuck
 * install cannot spawn on the new Opus 4.8 default (the CLI rejects unknown
 * model ids), since the gate force-updates to `@latest`. 2.1.197 is verified
 * to ship the claude-opus-4-8 catalog. */
export const CLI_MIN_VERSION_BASELINE = {
  // 0.144.1 is verified to advertise the GPT-5.6 Codex catalog. 0.143.0
  // accepts those ids at thread/start but fails at turn/start with "requires
  // a newer version of Codex", breaking Seren's GPT-5.6 defaults. #2904.
  "@openai/codex": "0.144.1",
  "@anthropic-ai/claude-code": "2.1.197",
};

/** Returns true when `installed` is a clean semver below `baseline`. */
export function isBelowBaseline(installed, baseline) {
  if (typeof installed !== "string" || typeof baseline !== "string") {
    return false;
  }
  const a = installed.match(SEMVER_EXACT_RE);
  const b = baseline.match(SEMVER_EXACT_RE);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const ai = Number(a[i]);
    const bi = Number(b[i]);
    if (ai !== bi) return ai < bi;
  }
  return false;
}

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
  //
  // Merge with the latest on-disk snapshot before writing. Two concurrent
  // backgroundUpdateCli arms (Codex + Claude) each load → mutate → save
  // independently; without merging, the second saver clobbers the first
  // saver's per-CLI key. All callers in this file are additive (no key
  // deletion), so a merge-on-write is semantically safe and narrows the
  // race window from the full update lifecycle (seconds, including npm
  // round-trip) to a load+rename pair (sub-millisecond). See #1655.
  const target = statePath();
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(serenDataDir(), { recursive: true });
    const merged = { ...loadState(), ...state };
    writeFileSync(tmp, JSON.stringify(merged), "utf8");
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

const FIRST_BASELINE_POLICIES = {
  "@anthropic-ai/claude-code": {
    installScripts: { postinstall: "node install.cjs" },
    dependencyPatterns: [
      /^@anthropic-ai\/claude-code-(darwin|linux|win32)-(arm64|x64)(-musl)?$/,
    ],
    binEntries: { claude: "bin/claude.exe" },
    executableFiles: ["bin/claude.exe"],
    hostnameAllowlist: HOSTNAME_ALLOWLIST["@anthropic-ai/claude-code"],
  },
  "@openai/codex": {
    installScripts: {},
    dependencyPatterns: [
      /^@openai\/codex-(darwin|linux|win32)-(arm64|x64)$/,
    ],
    binEntries: { codex: "bin/codex.js" },
    executableFiles: ["bin/codex.js"],
    hostnameAllowlist: HOSTNAME_ALLOWLIST["@openai/codex"],
  },
};

const OFFICIAL_INSTRUCTIONS_URLS = {
  "@anthropic-ai/claude-code": "https://code.claude.com/docs/en/installation",
  "@openai/codex": "https://developers.openai.com/codex/cli/",
};

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

/** Basic post-update spawn check that does not require authentication. */
async function runCliHealthCheck(resolvedPath) {
  try {
    const onWindowsCmd =
      process.platform === "win32" && resolvedPath.toLowerCase().endsWith(".cmd");
    await execFileAsync(resolvedPath, ["--help"], {
      timeout: VERSION_CMD_TIMEOUT_MS,
      shell: onWindowsCmd,
    });
    return true;
  } catch {
    return false;
  }
}

/** Fetch the exact registry SRI for a version before accepting packed bytes. */
export async function runNpmViewIntegrity(
  packageName,
  version,
  { npmCliScript } = {},
) {
  try {
    const args = [
      ...(npmCliScript ? [npmCliScript] : []),
      "view",
      `${packageName}@${version}`,
      "dist.integrity",
      "--json",
    ];
    const command = npmCliScript
      ? process.execPath
      : process.platform === "win32"
        ? "npm.cmd"
        : "npm";
    const { stdout } = await execFileAsync(command, args, {
      timeout: NPM_VIEW_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" && parsed.startsWith("sha512-")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isVersionAtLeast(installed, expected) {
  if (typeof installed !== "string" || typeof expected !== "string") return false;
  const a = installed.match(SEMVER_EXACT_RE);
  const b = expected.match(SEMVER_EXACT_RE);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const ai = Number(a[i]);
    const bi = Number(b[i]);
    if (ai !== bi) return ai > bi;
  }
  return true;
}

/**
 * Format a single structured log line for an outcome. Default-on logging
 * per #1646 — every updater run produces exactly one of these, no flag,
 * no env var, no opt-in. Visible in the app log users include in support
 * bundles. Never print package contents or PII; only enum + version
 * transition + flag list (where applicable).
 */
function formatOutcomeLog({ packageName, outcome, details = {} }) {
  const parts = [
    `cli=${packageName}`,
    `outcome=${outcome}`,
  ];
  for (const key of ["from", "to", "tarballSha512", "version"]) {
    if (details[key] != null && details[key] !== "") {
      parts.push(`${key}=${details[key]}`);
    }
  }
  if (Array.isArray(details.flags) && details.flags.length > 0) {
    parts.push(`flags=${details.flags.join(",")}`);
  }
  return `[cli-updater] ${parts.join(" ")}`;
}

function emitOutcomeLog({ packageName, outcome, details, logger }) {
  const line = formatOutcomeLog({ packageName, outcome, details });
  // scan_rejected and scan_error are security/operational signals — warn
  // level so they stand out in the user-facing log. install_failed and
  // network are also worth attention. Other outcomes are info.
  const level =
    outcome === "skipped:scan_rejected" ||
    outcome === "skipped:scan_error" ||
    outcome === "skipped:integrity_failed" ||
    outcome === "skipped:self_update_failed" ||
    outcome === "skipped:verification_required" ||
    outcome === "skipped:install_failed"
      ? "warn"
      : "info";
  if (logger?.[level]) {
    logger[level](line);
    return;
  }
  // Fallback: plain console. Tauri's plugin-log webview target forwards
  // these to the same log file users share when filing bugs.
  if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

/**
 * Fire-and-forget update check for a single CLI. TTL-gated and same-channel
 * only. Verification failures emit a deduplicated recovery event. Called once
 * per app launch — two launches within 24h make zero additional npm calls.
 *
 * Returns a normalized outcome object: `{ outcome, packageName, ...details }`.
 * Every invocation emits exactly one log line + (for success or scan_rejected)
 * exactly one provider event. See #1646.
 */
export async function backgroundUpdateCli({
  label,
  bareCommand,
  resolvedPath,
  packageName,
  npmCliScript,
  now = Date.now(),
  state,
  force = false,
  onUpdated,
  onScanRejected,
  onActionRequired,
  logger,
  // Test seams — production callers leave these undefined and the real
  // scanner + version commands run against npm/disk.
  _scannerOverrides,
  _versionOverrides,
}) {
  const packFn = _scannerOverrides?.npmPackToDirectory ?? npmPackToDirectory;
  const scanFn = _scannerOverrides?.scanTarball ?? scanTarball;
  const installFromTarballFn =
    _scannerOverrides?.runNpmInstallFromTarball ?? runNpmInstallFromTarball;
  const verifyIntegrityFn =
    _scannerOverrides?.verifyTarballIntegrity ?? verifyTarballIntegrity;
  const firstBaselinePolicyFn =
    _scannerOverrides?.evaluateFirstBaselinePolicy ?? evaluateFirstBaselinePolicy;
  const installedVersionFn =
    _versionOverrides?.runInstalledVersion ?? runInstalledVersion;
  const npmViewFn = _versionOverrides?.runNpmView ?? runNpmView;
  const npmViewIntegrityFn =
    _versionOverrides?.runNpmViewIntegrity ?? runNpmViewIntegrity;
  const selfUpdateFn = _versionOverrides?.tryCliSelfUpdate ?? tryCliSelfUpdate;
  const healthCheckFn =
    _versionOverrides?.runCliHealthCheck ?? runCliHealthCheck;

  // Compatibility: production runs may not pass `state` (callers were
  // written before the test seam). When state is omitted we manage
  // persistence ourselves via load/save inside this function.
  const ownsPersistence = state === undefined;

  function report(outcome, details = {}) {
    emitOutcomeLog({ packageName, outcome, details, logger });
    return {
      outcome,
      packageName,
      bareCommand,
      label,
      ...details,
      // Backwards-compat field shapes — pre-#1646 callers and tests check
      // `skipped`, `updated`, `from`, `to`, etc. Keep those alongside the
      // new `outcome` until callers migrate.
      ...(outcome === "success"
        ? { updated: true }
        : { skipped: outcome.replace(/^skipped:/, "") }),
    };
  }
  try {
    const persisted = state ?? loadState();
    const key = `lastUpdateCheck:${bareCommand}`;
    const pendingActionKey = `pendingAction:${bareCommand}`;
    const lastCheck = persisted[key];

    const channel = classifyInstallChannel(resolvedPath, bareCommand);
    if (channel === "unresolved") {
      // Don't write state — we want to re-check next launch in case the
      // install completes between now and then.
      return report("skipped:unresolved");
    }

    // Read installed version up-front so the baseline gate can override TTL.
    // The npm view is still deferred until we decide whether to run.
    const installed = await installedVersionFn(resolvedPath, bareCommand);
    const baseline = CLI_MIN_VERSION_BASELINE[packageName];
    const belowBaseline =
      typeof baseline === "string" && isBelowBaseline(installed, baseline);

    if (
      !force &&
      !belowBaseline &&
      typeof lastCheck === "number" &&
      now - lastCheck < UPDATE_CHECK_TTL_MS
    ) {
      return report("skipped:ttl");
    }

    const latest = await npmViewFn(packageName, { npmCliScript });

    // Record the check timestamp even when we couldn't compare — offline
    // and rate-limited cases should not retry every launch.
    persisted[key] = now;

    // Network outcome: we have a working installed binary but registry
    // lookup failed. Distinct from up_to_date so #1646 callers can tell
    // "registry unreachable" apart from "no update needed."
    if (!latest) {
      if (ownsPersistence) saveState(persisted);
      return report("skipped:network", { installed });
    }

    function requireAction(reason, details = {}) {
      const actionKey = `lastActionRequired:${bareCommand}:${latest}`;
      const lastAction = persisted[actionKey];
      const actionRequired = {
        label,
        bareCommand,
        packageName,
        from: installed,
        to: latest,
        reason,
        actions: ["retry", "open_official_instructions"],
        officialInstructionsUrl: OFFICIAL_INSTRUCTIONS_URLS[packageName] ?? null,
        at: now,
        ...details,
      };
      persisted[pendingActionKey] = actionRequired;
      if (
        typeof lastAction !== "number" ||
        now - lastAction >= UPDATE_CHECK_TTL_MS
      ) {
        persisted[actionKey] = now;
        onActionRequired?.(actionRequired);
      }
      if (ownsPersistence) saveState(persisted);
      return report(`skipped:${reason}`, {
        from: installed,
        to: latest,
        actionRequired,
        ...details,
      });
    }

    if (installed && latest && isNewer(installed, latest)) {
      // Native-channel binaries and Codex's package-manager-aware updater must
      // verify the resulting bytes before success is surfaced. Never fall back
      // to a downloaded installer script when self-update fails.
      if (channel === "native" || packageName === "@openai/codex") {
        const selfOk = await selfUpdateFn(resolvedPath);
        if (!selfOk) {
          return requireAction("self_update_failed", { channel });
        }
        const verifiedVersion = await installedVersionFn(
          resolvedPath,
          bareCommand,
        );
        const healthy = await healthCheckFn(resolvedPath);
        if (!isVersionAtLeast(verifiedVersion, latest) || !healthy) {
          return requireAction("verification_required", {
            channel,
            verifiedVersion,
          });
        }
        persisted[pendingActionKey] = null;
        if (ownsPersistence) saveState(persisted);
        onUpdated?.({
          label,
          bareCommand,
          from: installed,
          to: latest,
          channel: "self",
          verifiedVersion,
        });
        return report("success", {
          from: installed,
          to: latest,
          channel: "self",
          verifiedVersion,
        });
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
      const cleanupStaging = () => {
        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // Silent.
        }
      };
      try {
        const expectedIntegrity = await npmViewIntegrityFn(
          packageName,
          latest,
          { npmCliScript },
        );
        if (!expectedIntegrity) {
          cleanupStaging();
          return requireAction("integrity_failed", { channel });
        }
        const tarballPath = await packFn({
          packageName,
          version: latest,
          destinationDir: stagingDir,
          npmCliScript,
        });
        if (!verifyIntegrityFn(tarballPath, expectedIntegrity)) {
          cleanupStaging();
          return requireAction("integrity_failed", { channel });
        }
        const baseline = persisted[`baseline:${packageName}`];
        let scan = await scanFn({
          tarballPath,
          baseline,
          workDir: path.join(stagingDir, "extracted"),
          hostnameAllowlist: HOSTNAME_ALLOWLIST[packageName] ?? [],
        });

        if (scan.verdict === "no_baseline") {
          const policyFlags = firstBaselinePolicyFn(
            scan.candidate,
            FIRST_BASELINE_POLICIES[packageName],
          );
          if (policyFlags.length > 0) {
            scan = { ...scan, verdict: "reject", flags: policyFlags };
          }
        }

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
          cleanupStaging();
          // UI surfacing: notify the registry / TS layer so a banner or
          // notification can fire. Default-on per #1646 — silent scan
          // rejections are worse UX than no scanner at all.
          onScanRejected?.({
            label,
            bareCommand,
            packageName,
            from: installed,
            to: latest,
            flags: scan.flags,
          });
          return report("skipped:scan_rejected", {
            from: installed,
            to: latest,
            flags: scan.flags,
          });
        }

        // verdict is "pass" or a policy-approved "no_baseline" — install the
        // exact integrity-verified tarball and seed the next diff baseline.
        try {
          await installFromTarballFn(tarballPath, { npmCliScript });
        } catch {
          saveState(persisted);
          cleanupStaging();
          return report("skipped:install_failed", {
            from: installed,
            to: latest,
            channel,
          });
        }

        const verifiedVersion = await installedVersionFn(
          resolvedPath,
          bareCommand,
        );
        const healthy = await healthCheckFn(resolvedPath);
        if (!isVersionAtLeast(verifiedVersion, latest) || !healthy) {
          cleanupStaging();
          return requireAction("verification_required", {
            channel,
            verifiedVersion,
          });
        }

        persisted[`baseline:${packageName}`] = {
          version: latest,
          tarballSha512: scan.candidate.tarballSha512,
          installScripts: scan.candidate.installScripts,
          declaredDependencies: scan.candidate.declaredDependencies,
          binEntries: scan.candidate.binEntries,
          executableFiles: scan.candidate.executableFiles,
          networkHosts: scan.candidate.networkHosts,
          files: scan.candidate.files,
          fileHashes: scan.candidate.fileHashes,
        };
        persisted[pendingActionKey] = null;
        saveState(persisted);
        onUpdated?.({
          label,
          bareCommand,
          from: installed,
          to: latest,
          channel,
          tarballSha512: scan.candidate.tarballSha512,
          verifiedVersion,
        });
        cleanupStaging();
        return report("success", {
          from: installed,
          to: latest,
          channel,
          tarballSha512: scan.candidate.tarballSha512,
          firstInstall: scan.verdict === "no_baseline",
          verifiedVersion,
        });
      } catch {
        // Pack/scan failure — fail closed. Don't update.
        saveState(persisted);
        cleanupStaging();
        return report("skipped:scan_error", { from: installed, to: latest });
      }
    }

    persisted[pendingActionKey] = null;
    saveState(persisted);
    return report("skipped:up_to_date", { installed, latest });
  } catch {
    // Outermost catch-all — never allow the updater to throw into the
    // registry init path.
    return report("skipped:error");
  }
}

export { formatOutcomeLog as _formatOutcomeLog };
