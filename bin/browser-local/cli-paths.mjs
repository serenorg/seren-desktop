// ABOUTME: Defines Seren's writable per-user install prefix for managed agent CLIs.
// ABOUTME: Keeps installer and runtime resolvers on one durable path across every desktop OS.

import os from "node:os";
import path from "node:path";

export function serenDataDir({
  platform = process.platform,
  home = os.homedir(),
  appData = process.env.APPDATA ?? "",
} = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    return platformPath.join(appData || home, "Seren");
  }
  return platformPath.join(home, ".seren");
}

export function managedCliPrefix({ platform = process.platform, ...options } = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(
    serenDataDir({ platform, ...options }),
    "cli-tools",
  );
}

export function managedCliBinary(
  command,
  {
    platform = process.platform,
    prefix = managedCliPrefix({ platform }),
  } = {},
) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32"
    ? platformPath.join(prefix, `${command}.cmd`)
    : platformPath.join(prefix, "bin", command);
}
