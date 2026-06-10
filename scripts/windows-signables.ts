// ABOUTME: Cross-platform discovery of Windows PE files that must be EV-signed before release.
// ABOUTME: Single source of truth for the embedded-runtime signable set; bounds signtool volume to stay under SSL.com's rate limit (#2282).

import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Authenticode-signable PE extensions. .pyd/.node are ordinary DLLs that
// signtool signs in place by content.
export const SIGNABLE_EXTENSIONS = new Set([".exe", ".dll", ".node", ".pyd"]);

export interface CollectOptions {
  /** Override the set of signable extensions (lower-case, leading dot). */
  signableExtensions?: Set<string>;
  /** Skip any path whose POSIX-normalized form matches one of these patterns. */
  exclude?: RegExp[];
}

function walk(dir: string, exts: Set<string>, exclude: RegExp[], out: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Missing or unreadable root — skip (mirrors the signer's "Skipping missing root").
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const posix = full.split(path.sep).join("/");
    if (exclude.some((re) => re.test(posix))) continue;
    // Use real directory entries only; do not follow symlinked dirs (avoids loops).
    if (entry.isDirectory()) {
      walk(full, exts, exclude, out);
    } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
      out.add(full);
    }
  }
}

/**
 * Recursively collect every signable PE file under the given roots.
 * Deduplicates across overlapping roots and returns a sorted, deterministic list.
 */
export function collectSignables(roots: string[], opts: CollectOptions = {}): string[] {
  const exts = opts.signableExtensions ?? SIGNABLE_EXTENSIONS;
  const exclude = opts.exclude ?? [];
  const out = new Set<string>();
  for (const root of roots) {
    walk(root, exts, exclude, out);
  }
  return [...out].sort();
}

// CLI: `tsx scripts/windows-signables.ts <root> [<root> ...]`
// Prints one absolute path per line for the release signer to consume via -ListFile.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace(/^file:\/\//, ""));
if (isMain) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error("usage: windows-signables.ts <root> [<root> ...]");
    process.exit(2);
  }
  const files = collectSignables(roots);
  process.stdout.write(files.join("\n") + (files.length ? "\n" : ""));
}
