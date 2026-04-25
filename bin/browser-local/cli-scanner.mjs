// ABOUTME: Local-only supply-chain scanner for the CLI auto-updater (#1647).
// ABOUTME: Diffs an npm pack against the last-known-good baseline + runs static heuristics.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NPM_PACK_TIMEOUT_MS = 120_000;
const TAR_TIMEOUT_MS = 60_000;

/**
 * Files we expect to see touched on a normal release (allowed-change list).
 * Anything outside this set being added or content-changed across a patch
 * version is flagged as suspicious by the diff. Conservative: missing
 * entries here just mean "more flags" (false positives), not skipped checks.
 */
const ENTRY_POINT_DIRS = new Set(["dist", "lib", "build", "src", "bin"]);

/**
 * Static-check thresholds. Tuned to be loose enough that legitimate updates
 * pass on common CLIs, tight enough to flag axios/chalk/Shai-Hulud-style
 * additions of obfuscated payloads.
 */
const ENTROPY_FLAG_THRESHOLD = 7.5; // bits/byte for .js files
const BASE64_LITERAL_FLAG_BYTES = 2 * 1024;
const ENTRY_POINT_SIZE_GROWTH_RATIO = 1.5;

const BASE64_LITERAL_RE = /["'`]([A-Za-z0-9+/=]{2730,}|[A-Za-z0-9+/=]{2048,}={0,2})["'`]/g;
const EVAL_INVOCATION_RE = /\beval\s*\(/g;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/g;
const DYNAMIC_REQUIRE_RE = /\brequire\s*\(\s*[^"'`)\s][^)]*\)/g;
const HOSTNAME_RE = /(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,})/gi;

export function computeSha512(absPath) {
  const hash = createHash("sha512");
  hash.update(readFileSync(absPath));
  return hash.digest("hex");
}

/**
 * Run `npm pack <pkg>@<version> --pack-destination=<dir>`. Returns the
 * absolute path of the downloaded tarball. npm pack does NOT execute
 * install scripts — that only happens during `npm install`. So this
 * leaves the bits inert on disk, ready for inspection.
 */
export async function npmPackToDirectory({
  packageName,
  version,
  destinationDir,
  npmCliScript,
}) {
  mkdirSync(destinationDir, { recursive: true });
  const args = npmCliScript
    ? [
        npmCliScript,
        "pack",
        `${packageName}@${version}`,
        "--pack-destination",
        destinationDir,
      ]
    : ["pack", `${packageName}@${version}`, "--pack-destination", destinationDir];
  const exec = npmCliScript
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const { stdout } = await execFileAsync(exec, args, {
    timeout: NPM_PACK_TIMEOUT_MS,
  });
  // npm pack prints the tarball filename on the last non-empty stdout line.
  const filename = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!filename) {
    throw new Error("npm pack did not report a filename");
  }
  const absolute = path.join(destinationDir, filename);
  if (!existsSync(absolute)) {
    throw new Error(`npm pack output not found on disk: ${absolute}`);
  }
  return absolute;
}

/**
 * Extract a .tgz into destinationDir. Uses the system `tar` (built-in on
 * macOS/Linux, present in Windows 10+).
 */
export async function extractTarball({ tarballPath, destinationDir }) {
  mkdirSync(destinationDir, { recursive: true });
  await execFileAsync(
    "tar",
    ["-xzf", tarballPath, "-C", destinationDir],
    { timeout: TAR_TIMEOUT_MS },
  );
  // npm tarballs always extract into a top-level "package" directory.
  const root = path.join(destinationDir, "package");
  if (!existsSync(root)) {
    throw new Error(`Extracted tarball missing 'package' root at ${root}`);
  }
  return root;
}

/** List files under root, relative paths, depth-first. Skips symlinks. */
export function walkFiles(root) {
  const out = [];
  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile()) {
        out.push(path.relative(root, abs));
      }
    }
  }
  visit(root);
  return out.sort();
}

/**
 * Build a snapshot of the package: scripts, deps, file hashes, top-level
 * file list, declared install hooks. This snapshot becomes the baseline
 * stored after a successful install.
 */
export function buildPackageSnapshot(extractedRoot) {
  const pkgPath = path.join(extractedRoot, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    throw new Error(`package.json missing or invalid: ${err.message}`);
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const installScriptNames = ["preinstall", "install", "postinstall"];
  const installScripts = {};
  for (const key of installScriptNames) {
    if (typeof scripts[key] === "string" && scripts[key].length > 0) {
      installScripts[key] = scripts[key];
    }
  }
  const declaredDependencies = Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  }).sort();

  const files = walkFiles(extractedRoot);
  const fileHashes = {};
  for (const rel of files) {
    fileHashes[rel] = computeSha512(path.join(extractedRoot, rel));
  }

  return {
    version: typeof pkg.version === "string" ? pkg.version : null,
    installScripts,
    declaredDependencies,
    files,
    fileHashes,
  };
}

/**
 * Diff a candidate snapshot against the last-known-good baseline.
 * Returns a list of human-readable flag strings; empty array means clean.
 * Flags that would later require manual investigation include enough
 * detail (filenames, depnames) to triage without re-running the scan.
 */
export function diffSnapshots(baseline, candidate) {
  const flags = [];

  // Install scripts: any new install hook is the axios pattern.
  const baselineHooks = baseline?.installScripts ?? {};
  const candidateHooks = candidate.installScripts ?? {};
  for (const hook of ["preinstall", "install", "postinstall"]) {
    const had = typeof baselineHooks[hook] === "string";
    const has = typeof candidateHooks[hook] === "string";
    if (!had && has) {
      flags.push(`new_install_script:${hook}`);
    } else if (had && has && baselineHooks[hook] !== candidateHooks[hook]) {
      flags.push(`changed_install_script:${hook}`);
    }
  }

  // Dependency additions: new runtime deps are inherently suspicious on a
  // patch/minor bump. Don't flag removals — that's just cleanup.
  const baselineDeps = new Set(baseline?.declaredDependencies ?? []);
  for (const dep of candidate.declaredDependencies ?? []) {
    if (!baselineDeps.has(dep)) {
      flags.push(`new_dependency:${dep}`);
    }
  }

  // New top-level files (depth 1) that didn't exist before.
  const baselineFiles = new Set(baseline?.files ?? []);
  for (const file of candidate.files ?? []) {
    if (!baselineFiles.has(file)) {
      const depth = file.split("/").length;
      const topLevel = depth === 1;
      const inEntryDir = depth > 1 && ENTRY_POINT_DIRS.has(file.split("/")[0]);
      if (topLevel || inEntryDir) {
        flags.push(`new_file:${file}`);
      }
    }
  }

  // File-content hash changes for files that should be invariant across
  // a patch release (LICENSE, README) — these usually only change on
  // minor/major bumps, and a patch-version change here is suspicious.
  const baselineHashes = baseline?.fileHashes ?? {};
  for (const file of candidate.files ?? []) {
    const candidateHash = candidate.fileHashes?.[file];
    const baselineHash = baselineHashes[file];
    if (!baselineHash || !candidateHash) continue;
    if (candidateHash !== baselineHash) {
      const lower = file.toLowerCase();
      if (lower === "license" || lower === "license.md" || lower === "readme.md") {
        flags.push(`changed_invariant:${file}`);
      }
    }
  }

  return flags;
}

function shannonEntropy(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of buffer) counts[byte]++;
  let entropy = 0;
  const len = buffer.length;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Run static heuristics on the extracted package contents. Operates on
 * .js / .mjs / .cjs files only. Returns flag strings; empty = clean.
 */
export function runStaticChecks(
  extractedRoot,
  { hostnameAllowlist = [], baseline = null } = {},
) {
  const flags = [];
  const allowed = new Set(hostnameAllowlist.map((h) => h.toLowerCase()));
  const files = walkFiles(extractedRoot);

  for (const rel of files) {
    if (!/\.(c?js|mjs)$/.test(rel)) continue;
    const abs = path.join(extractedRoot, rel);
    let content;
    let buffer;
    try {
      buffer = readFileSync(abs);
      content = buffer.toString("utf8");
    } catch {
      continue;
    }

    if (EVAL_INVOCATION_RE.test(content)) {
      flags.push(`eval_call:${rel}`);
    }
    EVAL_INVOCATION_RE.lastIndex = 0;

    if (NEW_FUNCTION_RE.test(content)) {
      flags.push(`new_function:${rel}`);
    }
    NEW_FUNCTION_RE.lastIndex = 0;

    if (DYNAMIC_REQUIRE_RE.test(content)) {
      flags.push(`dynamic_require:${rel}`);
    }
    DYNAMIC_REQUIRE_RE.lastIndex = 0;

    // Newly-introduced child_process usage in a file that didn't have it.
    const usesChildProcess =
      content.includes('require("child_process")') ||
      content.includes("require('child_process')") ||
      content.includes('require("node:child_process")') ||
      content.includes("require('node:child_process')") ||
      content.includes('from "child_process"') ||
      content.includes("from 'child_process'") ||
      content.includes('from "node:child_process"') ||
      content.includes("from 'node:child_process'");
    if (usesChildProcess) {
      const baselineHash = baseline?.fileHashes?.[rel];
      const candidateHash = computeSha512(abs);
      if (!baselineHash) {
        flags.push(`child_process_in_new_file:${rel}`);
      } else if (baselineHash !== candidateHash) {
        flags.push(`child_process_in_changed_file:${rel}`);
      }
    }

    // Large base64-encoded literals at the top level rarely show up in
    // legitimate JS — usually they encode payloads or PII.
    let match;
    BASE64_LITERAL_RE.lastIndex = 0;
    while ((match = BASE64_LITERAL_RE.exec(content)) !== null) {
      if (match[1].length >= BASE64_LITERAL_FLAG_BYTES) {
        flags.push(
          `large_base64_literal:${rel}:${match[1].length}b`,
        );
        break;
      }
    }

    // Entropy on the raw file bytes — packed/obfuscated payloads usually
    // sit well above 7.5 bits/byte; readable JS is typically 4.5–5.5.
    const entropy = shannonEntropy(buffer);
    if (entropy >= ENTROPY_FLAG_THRESHOLD) {
      flags.push(`high_entropy:${rel}:${entropy.toFixed(2)}`);
    }

    // Hostname allowlist: if a non-allowlisted hostname appears in a file
    // that's growing, flag it. Per-CLI allowlists are passed in.
    if (allowed.size > 0) {
      const hostnames = new Set();
      let m;
      HOSTNAME_RE.lastIndex = 0;
      while ((m = HOSTNAME_RE.exec(content)) !== null) {
        const raw = m[0].toLowerCase();
        const host = raw.replace(/^https?:\/\//, "").split("/")[0];
        if (host.length > 0) hostnames.add(host);
      }
      for (const host of hostnames) {
        if (!allowed.has(host) && !isHostAllowed(host, allowed)) {
          flags.push(`unallowed_host:${rel}:${host}`);
        }
      }
    }

    // Entry-point file size growth check: only meaningful if we have a
    // baseline file size. We approximate via baseline file presence; a
    // real growth ratio would need explicit baseline file sizes, deferred.
    if (baseline?.fileSizes && baseline.fileSizes[rel] != null) {
      const baseSize = baseline.fileSizes[rel];
      if (baseSize > 0 && buffer.length / baseSize >= ENTRY_POINT_SIZE_GROWTH_RATIO) {
        flags.push(
          `entry_point_growth:${rel}:${baseSize}->${buffer.length}`,
        );
      }
    }
  }

  return flags;
}

function isHostAllowed(host, allowed) {
  // Allow exact-match and suffix-match (api.openai.com matches openai.com).
  for (const a of allowed) {
    if (host === a || host.endsWith(`.${a}`)) return true;
  }
  return false;
}

/**
 * Top-level scan entry point. Caller has already npm-packed the candidate
 * version to a tarball. We extract, snapshot, diff, and static-check.
 *
 * Verdict:
 *   - "pass" with empty flags: install the tarball, persist the new
 *     snapshot as the baseline.
 *   - "reject" with non-empty flags: skip install, surface flags via the
 *     #1646 outcome enum.
 *   - "no_baseline": first install of this CLI; nothing to diff against.
 *     Caller decides whether to seed-and-install or refuse.
 */
export async function scanTarball({
  tarballPath,
  baseline,
  workDir,
  hostnameAllowlist,
}) {
  const extractedRoot = await extractTarball({
    tarballPath,
    destinationDir: workDir,
  });
  const candidate = buildPackageSnapshot(extractedRoot);
  candidate.tarballSha512 = computeSha512(tarballPath);

  if (!baseline) {
    return {
      verdict: "no_baseline",
      flags: [],
      candidate,
      extractedRoot,
    };
  }

  const diffFlags = diffSnapshots(baseline, candidate);
  const staticFlags = runStaticChecks(extractedRoot, {
    hostnameAllowlist,
    baseline,
  });
  const allFlags = [...diffFlags, ...staticFlags];
  return {
    verdict: allFlags.length === 0 ? "pass" : "reject",
    flags: allFlags,
    candidate,
    extractedRoot,
  };
}
