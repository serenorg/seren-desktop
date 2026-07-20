// ABOUTME: Resolves the Grok CLI across Seren's embedded npm prefix and official install paths.
// ABOUTME: Keeps registry availability, login, installation, and runtime spawn on the same executable.

import { existsSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isSymlink(candidate) {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

export function resolveGrokBinary({
  execPath = process.execPath,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  appData = process.env.APPDATA ?? "",
} = {}) {
  const nodeDir = path.dirname(execPath);
  const executableName = platform === "win32" ? "grok.exe" : "grok";
  const npmPrefix = platform === "win32" ? nodeDir : path.dirname(nodeDir);
  const embeddedNative = path.join(
    npmPrefix,
    platform === "win32" ? "node_modules" : "lib/node_modules",
    "@xai-official",
    "grok",
    "node_modules",
    "@xai-official",
    `grok-${platform}-${arch}`,
    "bin",
    executableName,
  );

  if (platform === "win32") {
    const candidates = [
      // Prefer the package-owned native binary. Unlike npm's command shim it
      // remains executable after Tauri relocates embedded resources. #3088.
      embeddedNative,
      path.join(home, ".grok", "bin", "grok.exe"),
      path.join(nodeDir, "grok.cmd"),
      path.join(nodeDir, "grok.exe"),
      path.join(nodeDir, "grok"),
      ...(appData ? [path.join(appData, "npm", "grok.cmd")] : []),
      path.join(home, ".local", "bin", "grok.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return "grok";
  }

  const embeddedShim = path.join(npmPrefix, "bin", "grok");
  const candidates = [
    // Tauri dereferences npm bin symlinks while staging resources. Executing
    // the relocated CommonJS trampoline from node/bin makes Node classify it
    // as ESM under Seren's package root. Use the official native payload (or
    // canonical postinstall binary) instead; accept the npm shim only while it
    // is still a symlink to its package-owned location. #3088.
    embeddedNative,
    path.join(home, ".grok", "bin", "grok"),
    ...(isSymlink(embeddedShim) ? [embeddedShim] : []),
    path.join(home, ".local", "bin", "grok"),
    "/usr/local/bin/grok",
    "/opt/homebrew/bin/grok",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "grok";
}
