// ABOUTME: Flattens every Authenticode-signable file under the given roots into one staging dir for a single batch-sign (#2235).
// ABOUTME: SSL.com batch_sign is non-recursive and TOTP-throttled per file, so one flat dir + manifest beats per-directory signing.

import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import process from "node:process";

// Extensions Windows Authenticode can sign and that Smart App Control evaluates
// when loaded: native executables, libraries, Node addons, and Python extension
// modules (.pyd are DLLs). Anything else (.cmd, .json, .txt, .py) is left alone.
const SIGNABLE = new Set([".exe", ".dll", ".node", ".pyd"]);

// SSL.com CodeSignTool dispatches on the file extension against a fixed allowlist
// and rejects .pyd/.node with "Unsupported file format for signing", even though
// both are ordinary PE DLLs. Stage those under a .dll name so the signer accepts
// them; the Authenticode signature lives in the PE Certificate Table, so restoring
// the signed bytes to the original .pyd/.node path leaves it validly signed.
const SIGN_AS_DLL = new Set([".node", ".pyd"]);

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && SIGNABLE.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

const [, , stagingDir, manifestPath, ...roots] = process.argv;

if (!stagingDir || !manifestPath || roots.length === 0) {
  console.error(
    "Usage: flatten-windows-signables.mjs <staging-dir> <manifest-path> <root-dir>...",
  );
  process.exit(2);
}

const found = [];
for (const root of roots) {
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    console.warn(`[flatten] Skipping missing root: ${root}`);
    continue;
  }
  walk(root, found);
}

// Sort for deterministic flat names across runs.
found.sort();

mkdirSync(stagingDir, { recursive: true });

const manifest = [];
found.forEach((original, index) => {
  // Zero-padded index prefix keeps flat names unique even when basenames
  // collide (Git for Windows ships many same-named DLLs). The extension drives
  // how the signer dispatches: keep it as-is for .exe/.dll, but rewrite the ones
  // the signer rejects by extension (.pyd/.node) to .dll. Restore copies by the
  // original path, so the signed bytes land back on the real .pyd/.node file.
  const ext = extname(original).toLowerCase();
  const flatBase = SIGN_AS_DLL.has(ext)
    ? `${basename(original, ext)}.dll`
    : basename(original);
  const flat = `${String(index + 1).padStart(5, "0")}__${flatBase}`;
  copyFileSync(original, join(stagingDir, flat));
  manifest.push({ flat, original });
});

// The manifest is written OUTSIDE the staging dir so the staging dir holds only
// signable binaries — SSL.com batch_sign signs every file in its input dir and
// would choke on a non-PE manifest.json.
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[flatten] Flattened ${manifest.length} signable file(s) to ${stagingDir} (manifest: ${manifestPath})`,
);
process.exit(0);
