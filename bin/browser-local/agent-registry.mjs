// ABOUTME: Browser-local agent registry for install/login/availability behaviors.
// ABOUTME: Keeps provider metadata and per-agent setup logic separate from session runtime handling.

import { execFile, execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  backgroundUpdateCli,
  CLI_MIN_VERSION_BASELINE,
  isBelowBaseline,
  loadState,
  runInstalledVersion,
  saveState,
} from "./cli-updater.mjs";
import {
  checkAntigravityAuthenticated,
  clearAntigravityAuthCache,
  ensureAntigravityCli,
  resolveAntigravityBinary,
} from "./antigravity-binary.mjs";
import { resolveGrokBinary } from "./grok-binary.mjs";
import { managedCliBinary, managedCliPrefix } from "./cli-paths.mjs";

// LM Studio support is loaded lazily so a missing LM Studio dependency (e.g.
// @lmstudio/sdk) never crashes the registry, which every agent relies on for
// install/login/availability metadata (#2457). It is imported on demand only
// when the LM Studio agent is queried.
function loadLmStudioRuntime() {
  return import("./lmstudio-runtime.mjs");
}

/**
 * Map a binary file's CPU architecture to Node's `process.arch` taxonomy.
 *
 * Reads Mach-O (macOS), ELF (Linux), and PE/COFF (Windows) headers without
 * executing the file. Returns `"universal"` for fat Mach-O binaries (every
 * slice is shipped, kernel picks the matching one). Returns `null` when the
 * file isn't a recognized native binary — scripts and unknown formats fall
 * through to the spawn site, which surfaces a real OS error instead of us
 * silently rejecting something we can't classify.
 *
 * Exists for #1862: a wrong-arch claude binary at `~/.local/bin/claude`
 * shadowed our working npm-installed arm64 build and spawned with
 * `Bad CPU type in executable` (-86 / EBADARCH).
 */
function readBinaryArch(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const head = Buffer.alloc(64);
    const headBytes = readSync(fd, head, 0, 64, 0);
    if (headBytes < 8) return null;

    // Mach-O 64-bit, little-endian. magic = MH_MAGIC_64 (0xFEEDFACF on disk).
    if (head.readUInt32LE(0) === 0xfeedfacf) {
      const cputype = head.readUInt32LE(4);
      if (cputype === 0x0100000c) return "arm64"; // CPU_TYPE_ARM | ABI64
      if (cputype === 0x01000007) return "x64";   // CPU_TYPE_X86 | ABI64
      return null;
    }

    // Universal Mach-O (fat). Both BE and LE variants exist. Either way the
    // kernel picks the right slice — treat as runnable on any host.
    const beMagic = head.readUInt32BE(0);
    if (beMagic === 0xcafebabe || beMagic === 0xcafebabf) {
      return "universal";
    }

    // ELF: 7F 'E' 'L' 'F'. e_machine at offset 18 (2 bytes, endianness from EI_DATA).
    if (head.readUInt32LE(0) === 0x464c457f) {
      const isLE = head.readUInt8(5) === 1;
      const machine = isLE ? head.readUInt16LE(18) : head.readUInt16BE(18);
      if (machine === 0x3e) return "x64";    // EM_X86_64
      if (machine === 0xb7) return "arm64";  // EM_AARCH64
      if (machine === 0x28) return "arm";    // EM_ARM
      if (machine === 0x03) return "ia32";   // EM_386
      return null;
    }

    // PE/COFF: "MZ" DOS header, 32-bit PE offset at 0x3C, then "PE\0\0" +
    // IMAGE_FILE_HEADER. Machine is the first 2 bytes after the signature.
    if (head.readUInt16LE(0) === 0x5a4d) {
      const peOffset = head.readUInt32LE(0x3c);
      if (peOffset < 0 || peOffset > 0x10000) return null;
      const peBuf = Buffer.alloc(8);
      const peBytes = readSync(fd, peBuf, 0, 8, peOffset);
      if (peBytes < 8) return null;
      if (peBuf.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
      const machine = peBuf.readUInt16LE(4);
      if (machine === 0x8664) return "x64";    // IMAGE_FILE_MACHINE_AMD64
      if (machine === 0xaa64) return "arm64";  // IMAGE_FILE_MACHINE_ARM64
      if (machine === 0x14c) return "ia32";    // IMAGE_FILE_MACHINE_I386
      return null;
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

/**
 * Returns true when the binary at `filePath` can be executed on the current
 * host. Universal Mach-O and unrecognized formats (scripts, missing files)
 * are treated as runnable so callers don't silently skip legitimate install
 * shapes — only positively-identified arch mismatches are rejected.
 *
 * Use this to filter resolver candidates so a lingering wrong-arch binary
 * stops shadowing a working install at a lower-priority path.
 */
export function binaryRunsOnHost(filePath) {
  const fileArch = readBinaryArch(filePath);
  if (fileArch === null || fileArch === "universal") {
    return true;
  }
  return fileArch === process.arch;
}

/**
 * True when `candidate` exists and the current process has execute permission.
 * Mirrors the spawn-time gate in claude-runtime.mjs so login and spawn agree
 * on which candidates are viable. On Windows X_OK collapses to existence —
 * which is the right semantic there (no separate exec bit). #1735, #1878.
 */
function isExecutableCandidate(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the shell command string that the platform terminal will execute.
 * The resolved binary may be an absolute path that contains spaces (e.g.
 * `/Users/Some User/.local/bin/claude`) or a single apostrophe. Naive
 * interpolation breaks on both; previously this was unquoted and would
 * silently fail or get re-parsed as multiple shell words.
 *
 * A path that's just the bare command name ("claude", "codex") passes
 * through unquoted — the call site uses the sentinel when the resolver
 * couldn't find an install, in which case we want the user's shell PATH
 * to resolve the command. #1878.
 */
function buildLoginShellCommand(command) {
  // No path separator and no whitespace → bare command, pass through.
  // `path.sep` is `/` on POSIX and `\\` on Windows; check both since this
  // function is platform-neutral.
  const isBare = !/[\s/\\]/.test(command);
  if (isBare) {
    return `${command} login`;
  }
  // POSIX single-quote escape: close the quote, escape with backslash,
  // reopen. AppleScript and POSIX shells both honor this idiom.
  const quoted = `'${command.replace(/'/g, "'\\''")}'`;
  return `${quoted} login`;
}

function buildInteractiveShellCommand(command) {
  const isBare = !/[\s/\\]/.test(command);
  if (isBare) return command;
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function launchTerminalCommand(command, args, shellCommand) {
  if (process.platform === "darwin") {
    const escapedForAppleScript = shellCommand
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    spawn(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script "${escapedForAppleScript}"`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", command, ...args], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  spawn("x-terminal-emulator", ["-e", command, ...args], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/**
 * Launch `<command> login` in a new terminal window.
 *
 * Accepts either a bare command name (resolved by the user's shell PATH)
 * or an absolute path returned by `resolveInstalled*Binary`. The latter
 * guarantees that login targets the same binary `spawnSession` would have
 * picked, preventing the auth/spawn split-brain in #1876.
 *
 * Exported for #1878 test coverage of shell-quoting behavior.
 */
export function launchLoginCommand(command) {
  launchTerminalCommand(command, ["login"], buildLoginShellCommand(command));
}

/** Launch a CLI's interactive first-run flow without inventing a login subcommand. */
export function launchInteractiveCommand(command) {
  launchTerminalCommand(command, [], buildInteractiveShellCommand(command));
}

function execText(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(stderr || error.message));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

async function isCommandAvailable(command) {
  const whichCommand = process.platform === "win32" ? "where" : "which";
  try {
    await execText(whichCommand, [command]);
    return true;
  } catch {
    return false;
  }
}

function hasAnyCredentialPath(paths) {
  return paths.some((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function isClaudeBedrockConfigured() {
  const value = process.env.CLAUDE_CODE_USE_BEDROCK;
  if (value == null) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function hasClaudeCredentials() {
  // Bedrock authenticates the Claude Code CLI through the AWS credential chain
  // (instance role / AWS_* env), not a login file. When CLAUDE_CODE_USE_BEDROCK
  // is set, treat Claude as authenticated rather than looking for a profile.
  if (isClaudeBedrockConfigured()) {
    return true;
  }
  // A direct or custom-endpoint API key authenticates the CLI too: a raw
  // Anthropic key (ANTHROPIC_API_KEY) or an Anthropic-compatible proxy/gateway
  // token (ANTHROPIC_AUTH_TOKEN, e.g. OpenRouter). Both are used directly by
  // claude-code and need no login file. Empty strings do not count.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  const home = os.homedir();
  const appData = process.env.APPDATA;
  return hasAnyCredentialPath([
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude.json"),
    ...(appData
      ? [
          path.join(appData, "Claude", ".credentials.json"),
          path.join(appData, "Claude", "credentials.json"),
        ]
      : []),
  ]);
}

function hasCodexCredentials() {
  const home = os.homedir();
  const appData = process.env.APPDATA;
  return Boolean(process.env.OPENAI_API_KEY) || hasAnyCredentialPath([
    path.join(home, ".codex", "auth.json"),
    path.join(home, ".codex", "credentials.json"),
    ...(appData
      ? [
          path.join(appData, "Codex", "auth.json"),
          path.join(appData, "OpenAI", "Codex", "auth.json"),
        ]
      : []),
  ]);
}

function hasGrokCredentials() {
  return (
    Boolean(process.env.XAI_API_KEY) ||
    hasAnyCredentialPath([path.join(os.homedir(), ".grok", "auth.json")])
  );
}

function isAgentAuthenticated(agentType) {
  switch (agentType) {
    case "claude-code":
      return hasClaudeCredentials();
    case "codex":
      return hasCodexCredentials();
    case "gemini":
      return false;
    case "grok":
      return hasGrokCredentials();
    case "lmstudio":
      return false;
    case "claude-codex":
      return hasClaudeCredentials() && hasCodexCredentials();
    default:
      return false;
  }
}

/**
 * Resolve the path to npm-cli.js relative to the running Node.js binary.
 * This bypasses shell wrapper shims that break execFile() on macOS/Linux
 * after Tauri bundling replaces symlinks with shell scripts.
 *
 * Layout:
 *   macOS/Linux: <prefix>/bin/node  → <prefix>/lib/node_modules/npm/bin/npm-cli.js
 *   Windows:     <prefix>/node.exe  → <prefix>/node_modules/npm/bin/npm-cli.js
 */
function resolveNpmCliScript() {
  const nodeDir = path.dirname(process.execPath);

  if (process.platform === "win32") {
    // Windows: node.exe sits at the prefix root
    const candidate = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) {
      return candidate;
    }
  } else {
    // macOS/Linux: node sits in <prefix>/bin/
    const prefix = path.dirname(nodeDir);
    const candidate = path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const AGENT_CLI_PROVISIONING = Object.freeze({
  codex: { kind: "npm", target: "codex" },
  "claude-code": { kind: "npm", target: "claude" },
  "claude-codex": {
    kind: "derived",
    dependencies: ["claude-code", "codex"],
  },
  gemini: { kind: "verified-artifact", target: "antigravity" },
  grok: { kind: "npm", target: "grok" },
  lmstudio: { kind: "external-app", target: "lmstudio" },
});

function assertAgentCliProvisioningComplete(definitions, provisioning) {
  const definitionTypes = Object.keys(definitions).sort();
  const provisioningTypes = Object.keys(provisioning).sort();
  if (JSON.stringify(definitionTypes) !== JSON.stringify(provisioningTypes)) {
    throw new Error(
      `Agent CLI provisioning is incomplete: registry=${definitionTypes.join(",")} ` +
        `provisioning=${provisioningTypes.join(",")}`,
    );
  }
  for (const [agentType, entry] of Object.entries(provisioning)) {
    if (
      entry.kind === "derived" &&
      entry.dependencies.some((dependency) => !definitions[dependency])
    ) {
      throw new Error(
        `Agent CLI provisioning for ${agentType} references an unknown dependency.`,
      );
    }
  }
}

/**
 * Block spawn until the resolved CLI meets its CLI_MIN_VERSION_BASELINE,
 * force-updating through the verified updater when it does not. Shared by
 * the Codex (#2904) and Claude Code (#3443) spawn paths so both degrade
 * identically: an at-or-above-baseline install returns immediately with no
 * network access; a below-baseline install triggers a blocking verified
 * update and fails closed without asking the user to manage installations
 * when the update cannot be confirmed (offline, scan rejection, stale shim).
 *
 * `_runInstalledVersion` / `_backgroundUpdateCli` are test seams; production
 * callers leave them undefined so the real probe and updater run. Mirrors
 * the `_versionOverrides` / `_scannerOverrides` seams in cli-updater.mjs.
 */
async function ensureCliBaselineViaUpdater(
  emit,
  {
    label,
    bareCommand,
    packageName,
    resolveBinary,
    allowUnprobeableInstall = false,
    _runInstalledVersion = runInstalledVersion,
    _backgroundUpdateCli = backgroundUpdateCli,
  },
) {
  const baseline = CLI_MIN_VERSION_BASELINE[packageName];
  let resolved = resolveBinary();
  const installed = await _runInstalledVersion(resolved, bareCommand);
  if (!installed) {
    if (allowUnprobeableInstall && resolved !== bareCommand) {
      // A resolved install whose version probe fails is usable, not missing:
      // on an IO-starved machine every `--version` spawn can time out
      // (5s × 3 attempts), and failing closed here turns a slow disk into
      // "not installed" for a healthy CLI — the v3.75.0 release gate hit
      // exactly this (#3471). Spawn permissively; baseline enforcement
      // resumes on the next probe that succeeds.
      console.warn(
        `[agent-registry] ${label} version probe failed at ${resolved}; ` +
          `spawning without the baseline check`,
      );
      return resolved;
    }
    emit("provider://cli-install-progress", {
      stage: "installing",
      message: `Installing ${label} CLI automatically...`,
    });
    const outcome = await _backgroundUpdateCli({
      label,
      bareCommand,
      packageName,
      resolvedPath: bareCommand,
      npmCliScript: resolveNpmCliScript(),
      force: true,
      installIfMissing: true,
      installPrefix: managedCliPrefix(),
      resolveInstalledPath: resolveBinary,
      onUpdated: ({ label: updatedLabel, from, to }) =>
        emit?.("provider://cli-updated", {
          label: updatedLabel,
          from,
          to,
        }),
      onScanRejected: (event) =>
        emit?.("provider://cli-scan-rejected", event),
      onActionRequired: (event) =>
        emit?.("provider://cli-update-action-required", event),
    });
    resolved = resolveBinary();
    const installedAfterProvision = await _runInstalledVersion(
      resolved,
      bareCommand,
    );
    if (
      installedAfterProvision &&
      !isBelowBaseline(installedAfterProvision, baseline)
    ) {
      emit("provider://cli-install-progress", {
        stage: "complete",
        message: `${label} CLI installed successfully`,
      });
      return resolved;
    }
    throw new Error(
      `Seren could not install ${label} automatically. Seren will retry ` +
        `automatically. (${outcome.outcome})`,
    );
  }
  if (!isBelowBaseline(installed, baseline)) {
    return resolved;
  }

  emit("provider://cli-install-progress", {
    stage: "installing",
    message: `Updating ${label} CLI to ${baseline} or newer...`,
  });

  const outcome = await _backgroundUpdateCli({
    label,
    bareCommand,
    resolvedPath: resolved,
    packageName,
    npmCliScript: resolveNpmCliScript(),
    force: true,
    installPrefix: managedCliPrefix(),
    resolveInstalledPath: resolveBinary,
    onUpdated: ({ label, from, to }) =>
      emit?.("provider://cli-updated", { label, from, to }),
    onScanRejected: (event) =>
      emit?.("provider://cli-scan-rejected", event),
    onActionRequired: (event) =>
      emit?.("provider://cli-update-action-required", event),
  });

  resolved = resolveBinary();
  const updated = await _runInstalledVersion(resolved, bareCommand);
  if (
    outcome.outcome !== "success" ||
    !updated ||
    isBelowBaseline(updated, baseline)
  ) {
    throw new Error(
      `${label} CLI is still ${updated ?? "unknown"}; Seren requires ${baseline} ` +
        `or newer and will retry the verified update automatically. ` +
        `(${outcome.outcome})`,
    );
  }

  emit("provider://cli-install-progress", {
    stage: "complete",
    message: `${label} CLI updated successfully`,
  });

  return resolved;
}

async function ensureCodexCliViaUpdater(emit) {
  return ensureCliBaselineViaUpdater(emit, {
    label: "Codex",
    bareCommand: "codex",
    packageName: "@openai/codex",
    resolveBinary: resolveInstalledCodexBinary,
  });
}

async function ensureClaudeCodeCli(emit) {
  // Check well-known install paths first (bare `which`/`where` can find stale wrappers)
  const existing = resolveInstalledClaudeBinary();
  if (existing !== "claude") {
    // Known install location — enforce the shared version baseline before
    // spawn, exactly like Codex (#3443). Without this gate, the first spawn
    // after an app update hands a below-baseline CLI the default model id,
    // which it hard-rejects; the background updater only heals it later.
    return ensureCliBaselineViaUpdater(emit, {
      label: "Claude Code",
      bareCommand: "claude",
      packageName: "@anthropic-ai/claude-code",
      resolveBinary: resolveInstalledClaudeBinary,
      // Unlike Codex (a small native binary that answers --version
      // instantly), this CLI is a large JS package whose cold start can
      // outlive the probe timeout on a slow machine. An unprobeable version
      // at a known install location spawns permissively (#3471), matching
      // the custom-PATH branch below.
      allowUnprobeableInstall: true,
    });
  }

  // `which`/`where` may resolve to a path not covered by resolveInstalledClaudeBinary
  // (a custom user PATH location). Arch-check the resolved path so a wrong-arch
  // binary on PATH doesn't get spawned and fail with EBADARCH (#1862).
  if (await isCommandAvailable("claude")) {
    let resolvedPath = "";
    try {
      const whichCommand = process.platform === "win32" ? "where" : "which";
      resolvedPath = (await execText(whichCommand, ["claude"]))
        .split(/\r?\n/)[0]
        .trim();
    } catch {
      // which/where failed — fall through to the manual install handoff.
    }
    if (
      resolvedPath &&
      existsSync(resolvedPath) &&
      binaryRunsOnHost(resolvedPath)
    ) {
      // Custom PATH installs are outside every channel the updater manages.
      // If one is determinately stale, provision Seren's verified managed
      // copy rather than pushing an update decision back to the user.
      const baseline = CLI_MIN_VERSION_BASELINE["@anthropic-ai/claude-code"];
      const installed = await runInstalledVersion(resolvedPath, "claude");
      if (isBelowBaseline(installed, baseline)) {
        return ensureCliBaselineViaUpdater(emit, {
          label: "Claude Code",
          bareCommand: "claude",
          packageName: "@anthropic-ai/claude-code",
          resolveBinary: resolveInstalledClaudeBinary,
          allowUnprobeableInstall: true,
        });
      }
      return "claude";
    }
  }

  return ensureCliBaselineViaUpdater(emit, {
    label: "Claude Code",
    bareCommand: "claude",
    packageName: "@anthropic-ai/claude-code",
    resolveBinary: resolveInstalledClaudeBinary,
    allowUnprobeableInstall: true,
  });
}

async function ensureGrokCliViaUpdater(emit) {
  const resolved = resolveGrokBinary();
  if (resolved !== "grok") return resolved;
  if (await isCommandAvailable("grok")) return "grok";
  return ensureCliBaselineViaUpdater(emit, {
    label: "Grok",
    bareCommand: "grok",
    packageName: "@xai-official/grok",
    resolveBinary: resolveGrokBinary,
    allowUnprobeableInstall: true,
  });
}

/**
 * Resolve the installed Claude Code binary path.
 * GUI apps don't inherit shell PATH updates made by installers, so check
 * well-known install locations before falling back to bare command name.
 *
 * Candidates are filtered through `binaryRunsOnHost` so a leftover wrong-arch
 * binary at one path (e.g. ~/.local/bin/claude dropped by a Rosetta'd install
 * run) cannot shadow a working arch-matched install at a lower-priority path.
 * See #1862.
 */
export function resolveInstalledClaudeBinary() {
  if (process.platform === "win32") {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";
    const nodeDir = path.dirname(process.execPath);
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const candidates = [
      // Seren's verified copy must outrank a stale user-managed install.
      managedCliBinary("claude"),
      // Native installer location (install.ps1 puts it here)
      path.join(home, ".local", "bin", "claude.exe"),
      // Older native installer location
      path.join(home, ".claude", "bin", "claude.exe"),
      // Legacy / alternate location
      ...(appData ? [path.join(appData, "Claude", "claude.exe")] : []),
      // npm global install via system npm
      ...(appData ? [path.join(appData, "npm", "claude.cmd")] : []),
      // npm global install via embedded runtime's npm (prefix = node dir on Windows)
      path.join(nodeDir, "claude.cmd"),
      path.join(nodeDir, "claude"),
      // System-wide Node MSI install (default before npm prefix moved to APPDATA). #1665
      path.join(programFiles, "nodejs", "claude.cmd"),
      path.join(programFilesX86, "nodejs", "claude.cmd"),
      // Explicit user prefix. #1665
      path.join(home, ".npm-global", "claude.cmd"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate) && binaryRunsOnHost(candidate)) {
        return candidate;
      }
    }
  } else {
    const home = os.homedir();
    const nodeDir = path.dirname(process.execPath);
    const prefix = path.dirname(nodeDir);
    const candidates = [
      // Seren's verified copy must outrank a stale user-managed install.
      managedCliBinary("claude"),
      path.join(home, ".claude", "bin", "claude"),
      path.join(home, ".local", "bin", "claude"),
      // npm global install via embedded runtime's npm
      path.join(prefix, "bin", "claude"),
      // System npm prefix /usr/local. #1665
      "/usr/local/bin/claude",
      // Homebrew on Apple Silicon. #1665
      "/opt/homebrew/bin/claude",
      // Distro package managers. #1665
      "/usr/bin/claude",
    ];
    // Parity with claude-runtime's spawn-time gate (#1735): existsSync alone
    // passes broken symlinks and non-executable files, both of which fail
    // spawn at runtime. Login and spawn must agree, so use the same gate.
    for (const candidate of candidates) {
      if (
        existsSync(candidate) &&
        isExecutableCandidate(candidate) &&
        binaryRunsOnHost(candidate)
      ) {
        return candidate;
      }
    }
  }
  return resolveViaNpmGlobalPrefix("claude.cmd", "claude") ?? "claude";
}

// The dynamic npm global prefix, queried once via the embedded npm. Covers
// installs under a custom / version-manager prefix (nvm, fnm, volta, portable
// Node, or an explicit `npm config set prefix`) that the static candidate lists
// do not enumerate, so a CLI on a non-default prefix still resolves. #3377.
let cachedNpmGlobalPrefix;
function npmGlobalPrefixDir() {
  if (cachedNpmGlobalPrefix !== undefined) return cachedNpmGlobalPrefix;
  cachedNpmGlobalPrefix = null;
  try {
    const npmCliScript = resolveNpmCliScript();
    const output = npmCliScript
      ? execFileSync(process.execPath, [npmCliScript, "prefix", "-g"], {
          timeout: 5000,
          encoding: "utf8",
        })
      : execFileSync(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["prefix", "-g"],
          { timeout: 5000, encoding: "utf8", shell: process.platform === "win32" },
        );
    const trimmed = output.trim();
    if (trimmed) cachedNpmGlobalPrefix = trimmed;
  } catch {
    // No reachable npm / no global prefix; callers fall back to the bare command.
  }
  return cachedNpmGlobalPrefix;
}

// Resolve a CLI under the dynamic npm global prefix. On Windows a global bin
// sits directly at <prefix>\<name>.cmd; on Unix at <prefix>/bin/<name>. #3377.
function resolveViaNpmGlobalPrefix(windowsBin, unixBin) {
  const prefix = npmGlobalPrefixDir();
  if (!prefix) return null;
  const candidate =
    process.platform === "win32"
      ? path.join(prefix, windowsBin)
      : path.join(prefix, "bin", unixBin);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the absolute path of the installed Codex CLI binary.
 *
 * Mirrors `resolveInstalledClaudeBinary()`. Seren previously resolved Codex
 * by bare command name, which burned us on Windows (#876, #928) when GUI
 * apps don't inherit shell PATH and `.cmd` wrappers race with npm symlinks.
 * Prefer known install locations; fall back to bare "codex" only when
 * nothing resolves. Returning an absolute path lets the updater run the
 * binary directly without trusting PATH.
 */
export function resolveInstalledCodexBinary() {
  if (process.platform === "win32") {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";
    const nodeDir = path.dirname(process.execPath);
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const candidates = [
      // Seren-managed verified npm install.
      managedCliBinary("codex"),
      ...(appData ? [path.join(appData, "npm", "codex.cmd")] : []),
      ...(appData ? [path.join(appData, "npm", "codex.ps1")] : []),
      path.join(nodeDir, "codex.cmd"),
      path.join(nodeDir, "codex"),
      // System-wide Node MSI install. #1665
      path.join(programFiles, "nodejs", "codex.cmd"),
      path.join(programFilesX86, "nodejs", "codex.cmd"),
      // Explicit user prefix. #1665
      path.join(home, ".npm-global", "codex.cmd"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } else {
    const home = os.homedir();
    const nodeDir = path.dirname(process.execPath);
    const prefix = path.dirname(nodeDir);
    const candidates = [
      // Seren-managed verified npm install.
      managedCliBinary("codex"),
      path.join(prefix, "bin", "codex"),
      path.join(home, ".local", "bin", "codex"),
      // System npm prefix /usr/local — Intel macOS + most Linux distros. The
      // verified miss in #1665 (taariq's codex was here, resolver failed).
      "/usr/local/bin/codex",
      // Homebrew on Apple Silicon. #1665
      "/opt/homebrew/bin/codex",
      // Distro package managers. #1665
      "/usr/bin/codex",
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return resolveViaNpmGlobalPrefix("codex.cmd", "codex") ?? "codex";
}

export function createBrowserLocalAgentRegistry({ emit }) {
  const definitions = {
    codex: {
      type: "codex",
      name: "Codex",
      description: "OpenAI Codex via direct App Server integration",
      command: "codex",
      async getAvailability() {
        const installed = resolveInstalledCodexBinary() !== "codex";
        return {
          type: "codex",
          name: "Codex",
          description: "OpenAI Codex via direct App Server integration",
          command: "codex",
          available: true,
          authenticated: isAgentAuthenticated("codex"),
          ...(installed
            ? {}
            : {
                unavailableReason:
                  "Seren is preparing the Codex CLI automatically.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        return ensureCodexCliViaUpdater(emit);
      },
      launchLogin() {
        // Login MUST target the same binary that providers.spawnCodex
        // resolves (providers.mjs:130). Otherwise the OAuth flow writes
        // credentials to one codex install while Seren spawns a different
        // one. Mirrors the Gemini fix below (#1476) and Claude (#1878).
        const resolved = resolveInstalledCodexBinary();
        launchLoginCommand(resolved !== "codex" ? resolved : "codex");
      },
    },
    "claude-code": {
      type: "claude-code",
      name: "Claude Code",
      description: "Anthropic Claude Code via direct provider runtime",
      command: "claude",
      async getAvailability() {
        const installed = resolveInstalledClaudeBinary() !== "claude";
        return {
          type: "claude-code",
          name: "Claude Code",
          description: "Anthropic Claude Code via direct provider runtime",
          command: "claude",
          available: true,
          authenticated: isAgentAuthenticated("claude-code"),
          ...(installed
            ? {}
            : {
                unavailableReason:
                  "Seren is preparing the Claude Code CLI automatically.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        return ensureClaudeCodeCli(emit);
      },
      launchLogin() {
        // Login MUST target the same binary that claude-runtime resolves
        // for spawnSession. When they diverge — or when both point at the
        // same binary but `~/.claude/.credentials.json` was migrated from
        // another machine — the OAuth flow writes a fresh token to one
        // backend while the spawned claude reads from another and 401s on
        // first prompt (#1876). Mirrors the Gemini fix (#1476).
        const resolved = resolveInstalledClaudeBinary();
        launchLoginCommand(resolved !== "claude" ? resolved : "claude");
      },
    },
    "claude-codex": {
      type: "claude-codex",
      name: "Claude + Codex",
      description: "Paired workflow — Claude plans and reviews, Codex executes",
      command: "claude",
      async getAvailability() {
        const claudeInstalled = resolveInstalledClaudeBinary() !== "claude";
        const codexInstalled = resolveInstalledCodexBinary() !== "codex";
        const missing = [
          ...(claudeInstalled ? [] : ["Claude Code"]),
          ...(codexInstalled ? [] : ["Codex"]),
        ];
        return {
          type: "claude-codex",
          name: "Claude + Codex",
          description:
            "Paired workflow — Claude plans and reviews, Codex executes",
          command: "claude",
          available: true,
          authenticated: isAgentAuthenticated("claude-codex"),
          ...(missing.length === 0
            ? {}
            : {
                unavailableReason: `Seren is preparing the ${missing.join(" and ")} CLI${missing.length > 1 ? "s" : ""} automatically.`,
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        // Both CLIs back the paired workflow; ensure each before spawn.
        const claudeBin = await definitions["claude-code"].ensureCli();
        await definitions.codex.ensureCli();
        return claudeBin;
      },
      launchLogin() {
        // The paired runtime forwards login-required events with the INNER
        // agent type, so automatic login targets the right CLI. A manual
        // paired login starts with the planner; the executor's own
        // login-required event follows if Codex also needs auth.
        definitions["claude-code"].launchLogin();
      },
    },
    gemini: {
      type: "gemini",
      name: "Antigravity",
      description: "Google Antigravity coding agent",
      command: "agy",
      async getAvailability() {
        const resolved = resolveAntigravityBinary();
        const installed = resolved !== "agy";
        return {
          type: "gemini",
          name: "Antigravity",
          description: "Google Antigravity coding agent",
          command: "agy",
          available: true,
          authenticated: installed
            ? await checkAntigravityAuthenticated(resolved)
            : false,
          ...(installed
            ? {}
            : {
                unavailableReason:
                  "Seren is preparing the Antigravity CLI automatically.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        try {
          return await ensureAntigravityCli({ emit });
        } catch (error) {
          // Installation remains Seren-owned. Report a retryable preparation
          // failure without handing a download decision to the user. #3680
          emit?.("provider://cli-install-progress", {
            stage: "action_required",
            message:
              "Seren could not prepare Antigravity yet and will retry automatically.",
          });
          throw error;
        }
      },
      launchLogin() {
        const resolved = resolveAntigravityBinary();
        // Sign-in changes the verdict the cached probe recorded, so drop it
        // and let the next query observe the new state immediately. #3663
        clearAntigravityAuthCache();
        launchInteractiveCommand(resolved !== "agy" ? resolved : "agy");
      },
      async checkAuthenticated() {
        return checkAntigravityAuthenticated(resolveAntigravityBinary());
      },
    },
    grok: {
      type: "grok",
      name: "Grok",
      description: "xAI Grok Build via Agent Client Protocol",
      command: "grok",
      async getAvailability() {
        const resolved = resolveGrokBinary();
        const installed = resolved !== "grok";
        return {
          type: "grok",
          name: "Grok",
          description: "xAI Grok Build via Agent Client Protocol",
          command: "grok",
          available: true,
          authenticated: isAgentAuthenticated("grok"),
          ...(installed
            ? {}
            : {
                unavailableReason:
                  "Seren is preparing the Grok CLI automatically.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        return ensureGrokCliViaUpdater(emit);
      },
      launchLogin() {
        const resolved = resolveGrokBinary();
        launchLoginCommand(resolved !== "grok" ? resolved : "grok");
      },
    },
    lmstudio: {
      type: "lmstudio",
      name: "LM Studio",
      description: "Local LM Studio server via OpenAI-compatible HTTP",
      command: "lms",
      async getAvailability() {
        let lmStudio;
        try {
          lmStudio = await loadLmStudioRuntime();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return {
            type: "lmstudio",
            name: "LM Studio",
            description: "Local LM Studio server via OpenAI-compatible HTTP",
            command: "lms",
            available: false,
            authenticated: false,
            unavailableReason: `LM Studio support failed to load: ${reason}`,
          };
        }
        const serverReady = await lmStudio.checkLmStudioAuthenticated();
        const canStart = await lmStudio.checkLmStudioAvailable();
        return {
          type: "lmstudio",
          name: "LM Studio",
          description: "Local LM Studio server via OpenAI-compatible HTTP",
          command: "lms",
          available: true,
          authenticated: serverReady || canStart,
          ...(canStart
            ? {}
            : {
                unavailableReason:
                  "LM Studio is not running and the lms CLI was not found. Install LM Studio from https://lmstudio.ai/download.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async checkAuthenticated() {
        const lmStudio = await loadLmStudioRuntime();
        return lmStudio.checkLmStudioAuthenticated();
      },
      async ensureCli() {
        const lmStudio = await loadLmStudioRuntime();
        return lmStudio.ensureLmStudioCli();
      },
      async launchLogin() {
        const lmStudio = await loadLmStudioRuntime();
        lmStudio.launchLmStudioDownload();
      },
    },
  };
  assertAgentCliProvisioningComplete(definitions, AGENT_CLI_PROVISIONING);

  function getDefinition(agentType) {
    const definition = definitions[agentType];
    if (!definition) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }
    return definition;
  }

  // Fire-and-forget automatic provisioning and background update checks for
  // every Seren-managed CLI. Installed CLIs remain TTL-gated; missing CLIs
  // bypass the TTL and install into Seren's writable per-user prefix. Do not
  // await here — registry init must not block on downloads.
  const npmCliScript = resolveNpmCliScript();
  const persistedUpdaterState = loadState();
  const managedNpmTargets = Object.values(AGENT_CLI_PROVISIONING)
    .filter((entry) => entry.kind === "npm")
    .map((entry) => entry.target);
  let removedStaleInstallAction = false;
  const persistedActions = managedNpmTargets.map((target) => {
    const key = `pendingAction:${target}`;
    const action = persistedUpdaterState[key];
    if (action?.reason === "installation_required") {
      persistedUpdaterState[key] = null;
      removedStaleInstallAction = true;
      return null;
    }
    return action;
  });
  if (removedStaleInstallAction) saveState(persistedUpdaterState);
  let pendingCliUpdateAction = persistedActions
    .filter(Boolean)
    .sort((left, right) => (right.at ?? 0) - (left.at ?? 0))[0] ?? null;
  const onUpdated = async ({ label, bareCommand, from, to }) => {
    if (pendingCliUpdateAction?.bareCommand === bareCommand) {
      pendingCliUpdateAction = null;
    }
    emit?.("provider://cli-updated", { label, from, to });
    // #1713 §4.7 schema-drift gate: after a Claude CLI auto-update, run
    // the synthetic-transcript builder against a known-good fixture and
    // emit a drift event if the splice invariants no longer hold. The
    // event is read by the TS layer which forces compactSyntheticTranscript
    // off until the schema is reconciled.
    if (label === "Claude Code") {
      try {
        const { runSyntheticTranscriptSelfCheck } = await import(
          "./synthetic-transcript.mjs"
        );
        const result = runSyntheticTranscriptSelfCheck();
        if (!result.ok) {
          emit?.("provider://synthetic-transcript-schema-drift", {
            label,
            from,
            to,
            reason: result.reason,
          });
          console.warn(
            `[compact.synthetic.schema_drift] Claude CLI ${from} → ${to}: ${result.reason}`,
          );
        }
      } catch (err) {
        console.warn(
          `[compact.synthetic.schema_drift] self-check threw: ${err?.message ?? String(err)}`,
        );
      }
    }
  };
  // Default-on UI surface for scan rejections per #1646. The TS layer
  // subscribes and shows a system notification + records the rejection
  // in agent.store for the diagnostics panel. Silent rejection is worse
  // UX than no scanner at all.
  const onScanRejected = ({ label, packageName, from, to, flags }) => {
    emit?.("provider://cli-scan-rejected", {
      label,
      packageName,
      from,
      to,
      flags,
    });
  };
  const onActionRequired = (event) => {
    pendingCliUpdateAction = event;
    emit?.("provider://cli-update-action-required", event);
  };
  const cliUpdateConfigs = {
    codex: {
      label: "Codex",
      bareCommand: "codex",
      packageName: "@openai/codex",
      resolvePath: resolveInstalledCodexBinary,
    },
    claude: {
      label: "Claude Code",
      bareCommand: "claude",
      packageName: "@anthropic-ai/claude-code",
      resolvePath: resolveInstalledClaudeBinary,
    },
    grok: {
      label: "Grok",
      bareCommand: "grok",
      packageName: "@xai-official/grok",
      resolvePath: resolveGrokBinary,
    },
  };
  for (const target of new Set(managedNpmTargets)) {
    if (!cliUpdateConfigs[target]) {
      throw new Error(`Missing managed npm CLI provisioner for ${target}.`);
    }
  }
  const runCliUpdate = async (bareCommand, { force = false } = {}) => {
    const config = cliUpdateConfigs[bareCommand];
    if (!config) {
      throw new Error(`Unsupported CLI update target: ${bareCommand}`);
    }
    const result = await backgroundUpdateCli({
      label: config.label,
      bareCommand: config.bareCommand,
      resolvedPath: config.resolvePath(),
      packageName: config.packageName,
      npmCliScript,
      force,
      installIfMissing: true,
      installPrefix: managedCliPrefix(),
      resolveInstalledPath: config.resolvePath,
      onUpdated,
      onScanRejected,
      onActionRequired,
    });
    if (result.actionRequired) {
      pendingCliUpdateAction = result.actionRequired;
    } else if (
      pendingCliUpdateAction?.bareCommand === bareCommand &&
      (result.outcome === "success" || result.outcome === "skipped:up_to_date")
    ) {
      pendingCliUpdateAction = null;
    }
    return result;
  };
  for (const target of new Set(managedNpmTargets)) {
    void runCliUpdate(target);
  }
  const verifiedArtifactProvisioners = {
    antigravity: () => ensureAntigravityCli({ emit }),
  };
  const verifiedArtifactTargets = Object.values(AGENT_CLI_PROVISIONING)
    .filter((entry) => entry.kind === "verified-artifact")
    .map((entry) => entry.target);
  for (const target of new Set(verifiedArtifactTargets)) {
    const provision = verifiedArtifactProvisioners[target];
    if (!provision) {
      throw new Error(`Missing verified artifact CLI provisioner for ${target}.`);
    }
    void provision().catch((error) => {
      console.warn(
        `[agent-registry] ${target} automatic provisioning will retry: ${error?.message ?? String(error)}`,
      );
    });
  }

  return {
    async getAvailableAgents() {
      return Promise.all(
        Object.values(definitions).map((definition) =>
          definition.getAvailability(),
        ),
      );
    },

    async checkAgentAvailable(agentType) {
      return getDefinition(agentType).canSpawn();
    },

    async checkAgentAuthenticated(agentType) {
      const definition = getDefinition(agentType);
      if (definition.checkAuthenticated) {
        return definition.checkAuthenticated();
      }
      return isAgentAuthenticated(agentType);
    },

    async ensureAgentCli(agentType) {
      return getDefinition(agentType).ensureCli();
    },

    async retryCliUpdate(bareCommand) {
      const result = await runCliUpdate(bareCommand, { force: true });
      if (
        result.outcome === "success" ||
        result.outcome === "skipped:up_to_date"
      ) {
        pendingCliUpdateAction = null;
      }
      return result;
    },

    getPendingCliUpdateAction() {
      return pendingCliUpdateAction;
    },

    launchLogin(agentType) {
      getDefinition(agentType).launchLogin();
    },
  };
}

// Exported for regression tests of the spawn-path baseline gate (#2904,
// #3443). Production callers go through ensureCodexCliViaUpdater /
// ensureClaudeCodeCli.
export { ensureCliBaselineViaUpdater as _ensureCliBaselineViaUpdater };
// Exported for a completeness guard: every locally enumerated agent must state
// whether Seren provisions it, derives it, or depends on an external app.
export { AGENT_CLI_PROVISIONING as _AGENT_CLI_PROVISIONING };
export {
  assertAgentCliProvisioningComplete as _assertAgentCliProvisioningComplete,
};
