// ABOUTME: Resolves and installs Google's native Antigravity CLI binary.
// ABOUTME: Verifies the official platform manifest and SHA-512 before activation.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const ANTIGRAVITY_MIN_VERSION = "1.1.8";
export const ANTIGRAVITY_INSTALL_URL =
  "https://antigravity.google/docs/cli/getting-started";

const MANIFEST_ORIGIN =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const ARTIFACT_ORIGIN = "https://storage.googleapis.com";
const ARTIFACT_PATH_PREFIX = "/antigravity-public/antigravity-cli/";

function isExecutable(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates() {
  const executable = process.platform === "win32" ? "agy.exe" : "agy";
  const home = os.homedir();
  const pathEntries = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.join(entry, executable));

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    return [
      ...(localAppData
        ? [path.join(localAppData, "agy", "bin", "agy.exe")]
        : []),
      path.join(home, ".local", "bin", "agy.exe"),
      ...pathEntries,
    ];
  }

  return [
    path.join(home, ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "/usr/bin/agy",
    ...pathEntries,
  ];
}

export function resolveAntigravityBinary() {
  for (const candidate of new Set(pathCandidates())) {
    if (existsSync(candidate) && isExecutable(candidate)) {
      return candidate;
    }
  }
  return "agy";
}

function parseVersion(value) {
  const match = String(value ?? "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isAntigravityVersionSupported(version) {
  const actual = parseVersion(version);
  const minimum = parseVersion(ANTIGRAVITY_MIN_VERSION);
  if (!actual || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function execFileText(command, args, timeout = 10_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      command,
      args,
      {
        timeout,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          AGY_CLI_HIDE_ACCOUNT_INFO: "1",
          CI: "1",
          BROWSER: "false",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(String(stderr || stdout || error.message).trim()));
          return;
        }
        resolvePromise(String(stdout).trim());
      },
    );
    child.stdin?.end();
  });
}

export async function readAntigravityVersion(binary = resolveAntigravityBinary()) {
  if (binary === "agy") return null;
  try {
    const output = await execFileText(binary, ["--version"]);
    return output.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function checkAntigravityAuthenticated(
  binary = resolveAntigravityBinary(),
) {
  if (binary === "agy") return false;
  try {
    await execFileText(binary, ["models"], 8_000);
    return true;
  } catch {
    return false;
  }
}

function linuxUsesMusl() {
  if (process.platform !== "linux") return false;
  if (
    existsSync("/lib/libc.musl-x86_64.so.1") ||
    existsSync("/lib/libc.musl-aarch64.so.1")
  ) {
    return true;
  }
  return !process.report?.getReport?.().header?.glibcVersionRuntime;
}

export function antigravityPlatformId() {
  const arch =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
        ? "arm64"
        : null;
  if (!arch) {
    throw new Error(`Antigravity does not support ${process.arch}.`);
  }
  if (process.platform === "darwin") return `darwin_${arch}`;
  if (process.platform === "win32") return `windows_${arch}`;
  if (process.platform === "linux") {
    return `linux_${arch}${linuxUsesMusl() ? "_musl" : ""}`;
  }
  throw new Error(`Antigravity does not support ${process.platform}.`);
}

function validateManifest(manifest) {
  if (
    !manifest ||
    typeof manifest.version !== "string" ||
    typeof manifest.url !== "string" ||
    typeof manifest.sha512 !== "string" ||
    !/^[a-f0-9]{128}$/i.test(manifest.sha512)
  ) {
    throw new Error("The Antigravity release manifest is invalid.");
  }
  if (!isAntigravityVersionSupported(manifest.version)) {
    throw new Error(
      `The official Antigravity release ${manifest.version} is below Seren's ${ANTIGRAVITY_MIN_VERSION} minimum.`,
    );
  }
  const artifactUrl = new URL(manifest.url);
  if (
    artifactUrl.protocol !== "https:" ||
    artifactUrl.origin !== ARTIFACT_ORIGIN ||
    !artifactUrl.pathname.startsWith(ARTIFACT_PATH_PREFIX)
  ) {
    throw new Error("The Antigravity manifest selected an untrusted artifact URL.");
  }
  return { ...manifest, artifactUrl };
}

async function fetchOk(fetchImpl, url, description) {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Failed to download ${description}: HTTP ${response.status}.`,
    );
  }
  return response;
}

async function extractArchive(archivePath, stagingDir) {
  await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "tar",
      ["-xzf", archivePath, "-C", stagingDir, "antigravity"],
      { windowsHide: true, shell: false },
      (error, _stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(
              `Failed to extract the Antigravity release: ${String(stderr || error.message).trim()}`,
            ),
          );
          return;
        }
        resolvePromise();
      },
    );
  });
  return path.join(stagingDir, "antigravity");
}

function installTarget() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is required to install Antigravity on Windows.");
    }
    return path.join(localAppData, "agy", "bin", "agy.exe");
  }
  return path.join(os.homedir(), ".local", "bin", "agy");
}

export async function installAntigravity({
  emit,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This runtime cannot download Antigravity.");
  }

  emit?.("provider://cli-install-progress", {
    stage: "installing",
    message: "Installing Antigravity CLI from Google's verified release...",
  });

  const platform = antigravityPlatformId();
  const manifestUrl = `${MANIFEST_ORIGIN}/manifests/${platform}.json`;
  const manifestResponse = await fetchOk(
    fetchImpl,
    manifestUrl,
    "the Antigravity release manifest",
  );
  if (new URL(manifestResponse.url).origin !== MANIFEST_ORIGIN) {
    throw new Error("The Antigravity manifest request left Google's updater.");
  }
  const manifest = validateManifest(await manifestResponse.json());
  const artifactResponse = await fetchOk(
    fetchImpl,
    manifest.artifactUrl,
    "Antigravity CLI",
  );
  const finalArtifactUrl = new URL(artifactResponse.url);
  if (
    finalArtifactUrl.origin !== ARTIFACT_ORIGIN ||
    !finalArtifactUrl.pathname.startsWith(ARTIFACT_PATH_PREFIX)
  ) {
    throw new Error("The Antigravity artifact request left Google's storage path.");
  }

  const payload = Buffer.from(await artifactResponse.arrayBuffer());
  const actualHash = createHash("sha512").update(payload).digest("hex");
  if (actualHash.toLowerCase() !== manifest.sha512.toLowerCase()) {
    throw new Error(
      "Security halt: Antigravity CLI checksum verification failed.",
    );
  }

  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "seren-agy-"));
  const target = installTarget();
  const stagedTarget = `${target}.seren-new`;
  try {
    const isArchive = manifest.artifactUrl.pathname.endsWith(".tar.gz");
    const payloadPath = path.join(
      stagingDir,
      isArchive ? "antigravity.tar.gz" : "agy.exe",
    );
    await writeFile(payloadPath, payload, { mode: 0o600 });
    const extracted = isArchive
      ? await extractArchive(payloadPath, stagingDir)
      : payloadPath;

    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(extracted, stagedTarget);
    if (process.platform !== "win32") {
      await chmod(stagedTarget, 0o755);
    }
    try {
      await rename(stagedTarget, target);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await copyFile(stagedTarget, target);
      await rm(stagedTarget, { force: true });
    }
  } finally {
    await rm(stagedTarget, { force: true }).catch(() => {});
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  const installedVersion = await readAntigravityVersion(target);
  if (!isAntigravityVersionSupported(installedVersion)) {
    throw new Error(
      `Antigravity installed but reported ${installedVersion ?? "an unknown version"}; Seren requires ${ANTIGRAVITY_MIN_VERSION} or newer.`,
    );
  }

  emit?.("provider://cli-install-progress", {
    stage: "complete",
    message: `Antigravity CLI ${installedVersion} installed successfully`,
  });
  return target;
}

// Every Antigravity spawn calls through here, so two concurrent first-run
// spawns would otherwise run two installs against the same staged path and
// one would fail on a vanished rename. Share a single install instead. #3665
let installInFlight = null;

export async function ensureAntigravityCli({ emit } = {}) {
  const resolved = resolveAntigravityBinary();
  const installedVersion = await readAntigravityVersion(resolved);
  if (isAntigravityVersionSupported(installedVersion)) {
    return resolved;
  }
  if (installedVersion === null && resolved !== "agy") {
    // A resolved install whose version probe fails is usable, not missing:
    // on an IO-starved machine the probe can time out for a healthy binary,
    // and failing closed here forces a full re-download — or fails the spawn
    // outright when offline. Matches the Claude policy from #3471.
    console.warn(
      `[antigravity] version probe failed at ${resolved}; spawning without the baseline check`,
    );
    return resolved;
  }

  if (!installInFlight) {
    installInFlight = installAntigravity({ emit }).finally(() => {
      installInFlight = null;
    });
  }
  return installInFlight;
}

export const _validateAntigravityManifest = validateManifest;
