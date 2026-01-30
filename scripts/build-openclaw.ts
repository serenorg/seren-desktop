import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_OPENCLAW_DIST_TAG = "latest";

function execText(cmd: string, args: string[], cwd?: string): string {
  const res = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${res.status}): ${res.stderr ?? ""}`.trim(),
    );
  }
  return (res.stdout ?? "").trim();
}

function run(cmd: string, args: string[], cwd?: string): void {
  const res = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
  }
}

function runAndTail(cmd: string, args: string[], cwd: string, tailLines: number): void {
  const res = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;

  const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd();
  if (combined) {
    const lines = combined.split(/\r?\n/);
    const tail = lines.slice(-tailLines).join("\n");
    if (tail) process.stdout.write(`${tail}\n`);
  }

  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
  }
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(fullPath);
    } else if (entry.isFile()) {
      total += statSync(fullPath).size;
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fixed = unitIndex === 0 ? `${Math.round(value)}` : value.toFixed(1);
  return `${fixed}${units[unitIndex]}`;
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const destDir = path.join(repoRoot, "src-tauri", "embedded-runtime");

  console.log(`[build-openclaw] Destination: ${destDir}`);

  // --- 2. Create openclaw directory in embedded-runtime ---
  const openclawRuntimeDir = path.join(destDir, "openclaw");
  const markerPath = path.join(openclawRuntimeDir, ".seren-openclaw-bundle.json");
  let npmRequestedSpec: string | undefined;
  let npmResolvedSpec: string | undefined;

  // Prefer an explicitly-provided local checkout (developer workflow).
  // Otherwise fetch the pinned npm package (CI/release workflow).
  const openclawDir = process.env.OPENCLAW_DIR?.trim();
  if (openclawDir) {
    const resolved = path.resolve(openclawDir);
    if (!existsSync(resolved)) {
      throw new Error(`OPENCLAW_DIR was set but does not exist: ${resolved}`);
    }

    console.log(`[build-openclaw] Source: ${resolved}`);

    rmSync(openclawRuntimeDir, { recursive: true, force: true });

    // --- 1. Build openclaw if dist/ is missing ---
    if (!existsSync(path.join(resolved, "dist"))) {
      console.log("[build-openclaw] Building openclaw...");
      run("pnpm", ["build"], resolved);
    }

    mkdirSync(openclawRuntimeDir, { recursive: true });

    console.log("[build-openclaw] Copying openclaw dist...");
    cpSync(path.join(resolved, "dist"), path.join(openclawRuntimeDir, "dist"), { recursive: true });
    copyFileSync(path.join(resolved, "openclaw.mjs"), path.join(openclawRuntimeDir, "openclaw.mjs"));
    copyFileSync(path.join(resolved, "package.json"), path.join(openclawRuntimeDir, "package.json"));

    // Copy skills and assets if they exist
    for (const dirName of ["skills", "assets", "extensions"]) {
      const srcDir = path.join(resolved, dirName);
      if (existsSync(srcDir)) {
        cpSync(srcDir, path.join(openclawRuntimeDir, dirName), { recursive: true });
      }
    }
  } else {
    const versionOverride = process.env.OPENCLAW_VERSION?.trim();
    const requestedRaw = versionOverride || DEFAULT_OPENCLAW_DIST_TAG;
    npmRequestedSpec = requestedRaw.startsWith("openclaw@")
      ? requestedRaw
      : `openclaw@${requestedRaw}`;

    let resolvedVersion: string;
    try {
      resolvedVersion = execText("npm", ["view", npmRequestedSpec, "version"]);
    } catch (err) {
      // If we're following `latest` and the registry is unavailable, allow offline builds
      // when a bundle is already present.
      if (!versionOverride) {
        if (existsSync(markerPath) && existsSync(path.join(openclawRuntimeDir, "node_modules"))) {
          console.warn(
            `[build-openclaw] Warning: failed to resolve ${npmRequestedSpec}; using existing bundle at ${openclawRuntimeDir}`,
          );
          return;
        }
      }
      throw err;
    }
    npmResolvedSpec = `openclaw@${resolvedVersion}`;
    console.log(`[build-openclaw] Source: npm:${npmRequestedSpec} (resolved ${npmResolvedSpec})`);

    // Fast path: already bundled + dependencies installed for the resolved version.
    if (existsSync(markerPath) && existsSync(path.join(openclawRuntimeDir, "node_modules"))) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        if (marker?.source === `npm:${npmResolvedSpec}`) {
          console.log("[build-openclaw] Already bundled; skipping.");
          return;
        }
      } catch {
        // ignore malformed marker; rebuild
      }
    }

    rmSync(openclawRuntimeDir, { recursive: true, force: true });

    const tmpDir = path.join(destDir, ".tmp-openclaw");
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });

    // Download tarball from the npm registry (no local checkout required).
    const packedFilename = execText("npm", ["pack", npmResolvedSpec, "--silent"], tmpDir);
    const tarPath = path.join(tmpDir, packedFilename);
    if (!existsSync(tarPath)) {
      throw new Error(`npm pack did not produce expected tarball at: ${tarPath}`);
    }

    // Extract and move into place (tarball contains a top-level "package/" directory).
    run("tar", ["-xzf", tarPath, "-C", tmpDir]);
    const extractedDir = path.join(tmpDir, "package");
    if (!existsSync(extractedDir)) {
      throw new Error(`Extracted package directory not found at: ${extractedDir}`);
    }

    renameSync(extractedDir, openclawRuntimeDir);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("[build-openclaw] Installing production dependencies...");
  // --shamefully-hoist flattens node_modules so nested deps are directly accessible
  // (pnpm's default nested structure causes ERR_MODULE_NOT_FOUND at runtime)
  runAndTail("pnpm", ["install", "--prod", "--shamefully-hoist"], openclawRuntimeDir, 5);

  if (!openclawDir) {
    if (!npmRequestedSpec || !npmResolvedSpec) {
      throw new Error("Internal error: npm spec resolution missing for OpenClaw bundle");
    }
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        source: `npm:${npmResolvedSpec}`,
        requested: `npm:${npmRequestedSpec}`,
        bundledAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
  }

  console.log(`[build-openclaw] Done. OpenClaw package at: ${openclawRuntimeDir}`);

  let sizeText = "";
  try {
    sizeText = execText("du", ["-sh", openclawRuntimeDir]).split(/\s+/)[0] ?? "";
  } catch {
    sizeText = formatBytes(dirSizeBytes(openclawRuntimeDir));
  }
  if (sizeText) console.log(`[build-openclaw] Total size: ${sizeText}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
