// ABOUTME: File system handlers for browser-local runtime.
// ABOUTME: Powers local workspace browsing and editor reads/writes over JSON-RPC.

import {
  access,
  mkdir,
  readFile as fsReadFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { resolve } from "node:path";

function resolvePath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new Error("A valid path is required.");
  }
  return resolve(inputPath);
}

export async function listDirectory({ path }) {
  const directoryPath = resolvePath(path);
  const entries = await readdir(directoryPath, { withFileTypes: true });

  return entries
    .map((entry) => ({
      name: entry.name,
      path: resolve(directoryPath, entry.name),
      is_directory: entry.isDirectory(),
    }))
    .sort((left, right) => {
      if (left.is_directory !== right.is_directory) {
        return left.is_directory ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

export async function readFile({ path }) {
  return fsReadFile(resolvePath(path), "utf8");
}

export async function readFileBase64({ path }) {
  const content = await fsReadFile(resolvePath(path));
  return Buffer.from(content).toString("base64");
}

export async function writeFile({ path, content }) {
  await fsWriteFile(resolvePath(path), content ?? "", "utf8");
}

export async function pathExists({ path }) {
  try {
    await access(resolvePath(path));
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory({ path }) {
  try {
    const info = await stat(resolvePath(path));
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function createFile({ path, content }) {
  await fsWriteFile(resolvePath(path), content ?? "", "utf8");
}

export async function createDirectory({ path }) {
  await mkdir(resolvePath(path), { recursive: true });
}

export async function deletePath({ path }) {
  await rm(resolvePath(path), { recursive: true, force: true });
}

export async function renamePath({ oldPath, newPath }) {
  await rename(resolvePath(oldPath), resolvePath(newPath));
}
