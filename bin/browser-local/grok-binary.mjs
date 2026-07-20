// ABOUTME: Resolves the Grok CLI across Seren's embedded npm prefix and official install paths.
// ABOUTME: Keeps registry availability, login, installation, and runtime spawn on the same executable.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveGrokBinary() {
  const home = os.homedir();
  const nodeDir = path.dirname(process.execPath);

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    const candidates = [
      path.join(nodeDir, "grok.cmd"),
      path.join(nodeDir, "grok.exe"),
      path.join(nodeDir, "grok"),
      path.join(home, ".grok", "bin", "grok.exe"),
      ...(appData ? [path.join(appData, "npm", "grok.cmd")] : []),
      path.join(home, ".local", "bin", "grok.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return "grok";
  }

  const prefix = path.dirname(nodeDir);
  const candidates = [
    path.join(prefix, "bin", "grok"),
    path.join(home, ".grok", "bin", "grok"),
    path.join(home, ".local", "bin", "grok"),
    "/usr/local/bin/grok",
    "/opt/homebrew/bin/grok",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "grok";
}
