// ABOUTME: Browser-local agent registry for install/login/availability behaviors.
// ABOUTME: Keeps provider metadata and per-agent setup logic separate from session runtime handling.

import { execFile, spawn } from "node:child_process";
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
} from "./cli-updater.mjs";
import { resolveGrokBinary } from "./grok-binary.mjs";

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
  if (process.platform === "darwin") {
    const loginCommand = buildLoginShellCommand(command);
    // AppleScript string layer: escape backslashes first, then double
    // quotes. Without this, a path containing `"` would terminate the
    // do-script string early and inject AppleScript.
    const escapedForAppleScript = loginCommand
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
    // `start` syntax: `start [title] [command]`. When the first quoted arg
    // is present, `start` always treats it as the window title — so an
    // unquoted path with spaces breaks parsing, and a quoted path silently
    // becomes the title and never runs. Emit an explicit empty title to
    // pin the window-title slot regardless of what the path looks like.
    spawn(
      "cmd",
      ["/c", "start", "", command, "login"],
      { detached: true, stdio: "ignore" },
    ).unref();
    return;
  }

  // x-terminal-emulator argv form: spaces survive argv boundaries, so the
  // resolved absolute path needs no shell quoting.
  spawn("x-terminal-emulator", ["-e", command, "login"], {
    detached: true,
    stdio: "ignore",
  }).unref();
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

function hasGeminiCredentials() {
  const home = os.homedir();
  const appData = process.env.APPDATA;
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) ||
    hasAnyCredentialPath([
      path.join(home, ".gemini", "oauth_creds.json"),
      path.join(home, ".gemini", "credentials.json"),
      ...(appData
        ? [
            path.join(appData, "gemini", "oauth_creds.json"),
            path.join(appData, "Google", "Gemini", "oauth_creds.json"),
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
      return hasGeminiCredentials();
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

async function ensureGlobalNpmPackage({ emit, command, packageName, label }) {
  if (await isCommandAvailable(command)) {
    return command;
  }

  emit("provider://cli-install-progress", {
    stage: "installing",
    message: `Installing ${label} CLI...`,
  });

  // Invoke node with npm-cli.js directly to avoid shell wrapper shims that
  // break execFile() after Tauri replaces bin/npm symlinks with shell scripts.
  const npmCliScript = resolveNpmCliScript();
  if (npmCliScript) {
    await new Promise((resolvePromise, rejectPromise) => {
      execFile(
        process.execPath,
        [npmCliScript, "install", "-g", packageName],
        (error, stdout, stderr) => {
          if (error) {
            rejectPromise(new Error(stderr || error.message));
            return;
          }
          resolvePromise(stdout.trim());
        },
      );
    });
  } else {
    // Fallback: try npm directly (works in dev where symlinks are intact,
    // and on Windows where npm.cmd is a valid batch file).
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    await new Promise((resolvePromise, rejectPromise) => {
      execFile(
        npmCommand,
        ["install", "-g", packageName],
        (error, stdout, stderr) => {
          if (error) {
            rejectPromise(new Error(stderr || error.message));
            return;
          }
          resolvePromise(stdout.trim());
        },
      );
    });
  }

  emit("provider://cli-install-progress", {
    stage: "complete",
    message: `${label} CLI installed successfully`,
  });

  return command;
}

const CLI_INSTALL_INSTRUCTIONS = {
  "@anthropic-ai/claude-code":
    "https://code.claude.com/docs/en/installation",
  "@openai/codex": "https://developers.openai.com/codex/cli/",
  "@xai-official/grok": "https://docs.x.ai/build/overview",
};

function emitCliActionRequired(
  emit,
  { label, bareCommand, packageName, from = null, to = null, reason },
) {
  const officialInstructionsUrl = CLI_INSTALL_INSTRUCTIONS[packageName];
  emit?.("provider://cli-install-progress", {
    stage: "action_required",
    message: `${label} needs your attention before Seren can use it.`,
  });
  emit?.("provider://cli-update-action-required", {
    label,
    bareCommand,
    packageName,
    from,
    to,
    reason,
    actions: ["retry", "open_official_instructions"],
    officialInstructionsUrl,
  });
  return officialInstructionsUrl;
}

async function ensureCodexCliViaUpdater(emit) {
  const baseline = CLI_MIN_VERSION_BASELINE["@openai/codex"];
  let resolved = resolveInstalledCodexBinary();
  const installed = await runInstalledVersion(resolved, "codex");
  if (!installed) {
    const url = emitCliActionRequired(emit, {
      label: "Codex",
      bareCommand: "codex",
      packageName: "@openai/codex",
      reason: "installation_required",
    });
    throw new Error(
      `Codex CLI is not installed in a verifiable location. Install it from ${url}, then retry.`,
    );
  }
  if (!isBelowBaseline(installed, baseline)) {
    return resolved;
  }

  emit("provider://cli-install-progress", {
    stage: "installing",
    message: `Updating Codex CLI to ${baseline} or newer...`,
  });

  const outcome = await backgroundUpdateCli({
    label: "Codex",
    bareCommand: "codex",
    resolvedPath: resolved,
    packageName: "@openai/codex",
    npmCliScript: resolveNpmCliScript(),
    force: true,
    onUpdated: ({ label, from, to }) =>
      emit?.("provider://cli-updated", { label, from, to }),
    onScanRejected: (event) =>
      emit?.("provider://cli-scan-rejected", event),
    onActionRequired: (event) =>
      emit?.("provider://cli-update-action-required", event),
  });

  resolved = resolveInstalledCodexBinary();
  const updated = await runInstalledVersion(resolved, "codex");
  if (
    outcome.outcome !== "success" ||
    !updated ||
    isBelowBaseline(updated, baseline)
  ) {
    throw new Error(
      `Codex CLI is still ${updated ?? "unknown"}; Seren requires ${baseline} ` +
        `or newer. Update it from ${CLI_INSTALL_INSTRUCTIONS["@openai/codex"]}, ` +
        `then retry. (${outcome.outcome})`,
    );
  }

  emit("provider://cli-install-progress", {
    stage: "complete",
    message: "Codex CLI updated successfully",
  });

  return resolved;
}

async function ensureClaudeCodeCli(emit) {
  // Check well-known install paths first (bare `which`/`where` can find stale wrappers)
  const existing = resolveInstalledClaudeBinary();
  if (existing !== "claude") {
    return existing;
  }

  // `which`/`where` may resolve to a path not covered by resolveInstalledClaudeBinary
  // (a custom user PATH location). Arch-check the resolved path so a wrong-arch
  // binary on PATH doesn't get spawned and fail with EBADARCH (#1862).
  if (await isCommandAvailable("claude")) {
    try {
      const whichCommand = process.platform === "win32" ? "where" : "which";
      const resolvedPath = (await execText(whichCommand, ["claude"]))
        .split(/\r?\n/)[0]
        .trim();
      if (
        resolvedPath &&
        existsSync(resolvedPath) &&
        binaryRunsOnHost(resolvedPath)
      ) {
        return "claude";
      }
    } catch {
      // which/where failed — fall through to the manual install handoff.
    }
  }

  const url = emitCliActionRequired(emit, {
    label: "Claude Code",
    bareCommand: "claude",
    packageName: "@anthropic-ai/claude-code",
    reason: "installation_required",
  });
  throw new Error(
    `Claude Code CLI is not installed. Install it from ${url}, then retry.`,
  );
}

/**
 * Resolve the installed Gemini CLI binary path.
 *
 * Mirrors `resolveInstalledClaudeBinary()` below. Prefers the binary that
 * the embedded runtime's `npm install -g @google/gemini-cli` would have
 * placed at `<prefix>/bin/gemini` (Unix) or `<nodeDir>/gemini.cmd` (Windows)
 * over any system install (Homebrew, system npm, etc.).
 *
 * Why: Homebrew's gemini-cli formula skips the `node-gyp rebuild` postinstall
 * step that compiles `keytar.node`, so the Homebrew binary cannot read
 * stored credentials when launched as a child process from a GUI app and
 * fails immediately with "When using Gemini API, you must specify the
 * GEMINI_API_KEY environment variable" (#1476). Preferring the embedded
 * install ensures Seren controls the install path end-to-end and the
 * keychain integration actually works.
 *
 * Returns the bare "gemini" string if no install is found, so the caller
 * can trigger ensureCli() to install via the embedded runtime's npm.
 */
function resolveInstalledGeminiBinary() {
  // IMPORTANT: Gemini intentionally does NOT include /usr/local/bin,
  // /opt/homebrew/bin, /usr/bin (Unix), or C:\Program Files\nodejs\
  // (Windows MSI) in its candidate list — even though Codex and Claude
  // do post-#1665. The Homebrew gemini-cli formula (and other system
  // installs that don't run npm scripts) skip the keytar postinstall, so
  // a system-installed gemini binary cannot read its own keychain when
  // spawned from a GUI app and fails first-run auth with a misleading
  // "GEMINI_API_KEY environment variable" message (#1476).
  //
  // Mirroring the deliberate exclusion in `resolveGeminiBinary` at
  // bin/browser-local/gemini-runtime.mjs:30. If install-detection here
  // discovered a system Gemini, ensureCli() would return "available" and
  // skip the bundled-runtime install where keytar IS run correctly. The
  // spawn path (which intentionally still excludes the same locations)
  // would then fall through to bare "gemini", PATH would resolve the
  // broken system install, and auth would silently fail. Keep the
  // bundled+user-local-only restriction here too.
  //
  // The auto-updater (#1637) returning skipped:unresolved for Gemini in
  // this configuration is the intended outcome — we do not want to
  // auto-update a binary we can't safely spawn. See #1665 PR for the
  // full audit.
  if (process.platform === "win32") {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      // npm global install via embedded runtime's npm (prefix = node dir on Windows)
      path.join(nodeDir, "gemini.cmd"),
      path.join(nodeDir, "gemini"),
      // npm global install via system npm
      ...(appData ? [path.join(appData, "npm", "gemini.cmd")] : []),
      // Generic install fallbacks
      path.join(home, ".local", "bin", "gemini.exe"),
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
      // npm global install via embedded runtime's npm — check FIRST so a
      // broken Homebrew install doesn't shadow our working bundled one.
      path.join(prefix, "bin", "gemini"),
      // Generic user-local install fallbacks
      path.join(home, ".local", "bin", "gemini"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "gemini";
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
  return "claude";
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
  return "codex";
}

export function createBrowserLocalAgentRegistry({ emit }) {
  const definitions = {
    codex: {
      type: "codex",
      name: "Codex",
      description: "OpenAI Codex via direct App Server integration",
      command: "codex",
      async getAvailability() {
        const installed = await isCommandAvailable("codex");
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
                  "Codex CLI is not installed. Seren will open the official installation instructions when you start this agent.",
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
        const installed = await isCommandAvailable("claude");
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
                  "Claude Code CLI is not installed. Seren will open the official installation instructions when you start this agent.",
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
        const claudeInstalled = await isCommandAvailable("claude");
        const codexInstalled = await isCommandAvailable("codex");
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
                unavailableReason: `${missing.join(" and ")} CLI${missing.length > 1 ? "s are" : " is"} not installed. Seren will provide official installation instructions when you start this agent.`,
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
      name: "Gemini",
      description: "Google Gemini via gemini-cli (Agent Client Protocol)",
      command: "gemini",
      async getAvailability() {
        // Resolve via the embedded-install-aware path, NOT bare PATH lookup.
        // A Homebrew gemini-cli on PATH cannot read its own keychain when
        // spawned from a GUI app (#1476), so we report the agent as needing
        // install whenever our embedded npm install path is empty — even if
        // some other gemini is on PATH.
        const resolved = resolveInstalledGeminiBinary();
        const installed = resolved !== "gemini";
        return {
          type: "gemini",
          name: "Gemini",
          description: "Google Gemini via gemini-cli (Agent Client Protocol)",
          command: "gemini",
          available: true,
          authenticated: isAgentAuthenticated("gemini"),
          ...(installed
            ? {}
            : {
                unavailableReason:
                  "Gemini CLI is not installed yet. Seren can install it automatically on first launch.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        // Short-circuit if our embedded install already exists. This prevents
        // re-running npm on every spawn while still bypassing broken system
        // installs that might be on PATH.
        const resolved = resolveInstalledGeminiBinary();
        if (resolved !== "gemini") {
          return resolved;
        }
        return ensureGlobalNpmPackage({
          emit,
          command: "gemini",
          packageName: "@google/gemini-cli",
          label: "Gemini",
        });
      },
      launchLogin() {
        // Use the resolved embedded-install path so the user runs `gemini login`
        // with the WORKING binary (with compiled keytar), not the broken one.
        const resolved = resolveInstalledGeminiBinary();
        launchLoginCommand(resolved !== "gemini" ? resolved : "gemini");
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
                  "Grok CLI is not installed yet. Seren can install it automatically on first launch.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        const resolved = resolveGrokBinary();
        if (resolved !== "grok") {
          return resolved;
        }
        await ensureGlobalNpmPackage({
          emit,
          command: "grok",
          packageName: "@xai-official/grok",
          label: "Grok",
        });
        const installed = resolveGrokBinary();
        if (installed !== "grok") {
          return installed;
        }
        // A user-managed grok outside the paths resolveGrokBinary knows is
        // still spawnable, so PATH decides before we give up.
        if (await isCommandAvailable("grok")) {
          return "grok";
        }
        // Returning the bare command here spawned an ENOENT that surfaced as
        // "Grok agent stopped before request completed", which says nothing
        // about a missing install. Mirrors Claude/Codex. #3154
        const url = emitCliActionRequired(emit, {
          label: "Grok",
          bareCommand: "grok",
          packageName: "@xai-official/grok",
          reason: "installation_required",
        });
        throw new Error(
          `Grok CLI is not installed in a verifiable location. Install it from ${url}, then retry.`,
        );
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

  function getDefinition(agentType) {
    const definition = definitions[agentType];
    if (!definition) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }
    return definition;
  }

  // Fire-and-forget background update checks for bundled CLIs (#1637).
  // TTL-gated to 24h inside backgroundUpdateCli and same-channel only. Any
  // verification failure emits one deduplicated recovery event. Do not await
  // here — registry init must not block on npm.
  const npmCliScript = resolveNpmCliScript();
  const persistedUpdaterState = loadState();
  let pendingCliUpdateAction = [
    persistedUpdaterState["pendingAction:codex"],
    persistedUpdaterState["pendingAction:claude"],
  ]
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
  };
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
  void runCliUpdate("codex");
  void runCliUpdate("claude");

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

// Exported for regression tests. A package missing from this map makes its
// ensureCli failure interpolate `undefined` in place of the install URL,
// which is the unhelpful error #3154 was filed about.
export { CLI_INSTALL_INSTRUCTIONS as _CLI_INSTALL_INSTRUCTIONS };
