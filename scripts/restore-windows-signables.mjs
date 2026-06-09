// ABOUTME: Copies batch-signed files from the staging output dir back to their original locations via the manifest (#2235).
// ABOUTME: Fails loud and atomically if the signer dropped any file, so a half-signed payload can never ship (the #2223 shape).

import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const [, , signedDir, manifestPath] = process.argv;

if (!signedDir || !manifestPath) {
  console.error("Usage: restore-windows-signables.mjs <signed-dir> <manifest.json>");
  process.exit(2);
}

let manifest;
try {
  statSync(manifestPath);
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`[restore] Cannot read manifest ${manifestPath}: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}

if (!Array.isArray(manifest)) {
  console.error("[restore] Manifest is not an array.");
  process.exit(2);
}

// Validate the full set first. The signer either covered everything or it
// failed — never restore a partial set, or unsigned binaries reach users.
const missing = manifest.filter((entry) => !existsSync(join(signedDir, entry.flat)));
if (missing.length > 0) {
  console.error(
    `[restore] Signer did not produce ${missing.length} of ${manifest.length} expected file(s):`,
  );
  for (const entry of missing) {
    console.error(`  missing: ${entry.flat}  (for ${entry.original})`);
  }
  console.error("[restore] Refusing to restore a partially-signed payload.");
  process.exit(1);
}

for (const entry of manifest) {
  copyFileSync(join(signedDir, entry.flat), entry.original);
}

console.log(`[restore] Restored ${manifest.length} signed file(s) to original locations.`);
process.exit(0);
