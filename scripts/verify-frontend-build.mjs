import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const DIST_DIR = resolve(process.env.SEREN_BUILD_DIST_DIR ?? "dist");
const MANIFEST_PATH = join(DIST_DIR, "build-manifest.json");
const SEARCHABLE_EXTENSIONS = new Set([".html", ".js"]);

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function resolveExpectedCommit() {
  const envCommit =
    process.env.SEREN_BUILD_EXPECTED_COMMIT?.trim() ||
    process.env.GITHUB_SHA?.trim();
  if (envCommit) {
    return envCommit;
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function collectCommitHits(dirPath, expectedCommit, matches = []) {
  for (const entry of readdirSync(dirPath)) {
    const entryPath = join(dirPath, entry);
    const entryStat = statSync(entryPath);
    if (entryStat.isDirectory()) {
      collectCommitHits(entryPath, expectedCommit, matches);
      continue;
    }

    if (!SEARCHABLE_EXTENSIONS.has(extname(entryPath))) {
      continue;
    }

    const content = readFileSync(entryPath, "utf8");
    if (content.includes(expectedCommit)) {
      matches.push(relative(DIST_DIR, entryPath));
    }
  }

  return matches;
}

const expectedCommit = resolveExpectedCommit();
if (!expectedCommit) {
  fail("could not determine expected git commit for this build");
}

if (!existsSync(DIST_DIR)) {
  fail(`dist directory is missing at ${DIST_DIR}`);
}

if (!existsSync(MANIFEST_PATH)) {
  fail(`build manifest missing at ${MANIFEST_PATH}`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (error) {
  fail(
    `build manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (manifest.commit !== expectedCommit) {
  fail(
    `build manifest commit ${JSON.stringify(manifest.commit)} does not match HEAD ${expectedCommit}`,
  );
}

if (typeof manifest.builtAt !== "string" || manifest.builtAt.trim() === "") {
  fail("build manifest is missing a non-empty builtAt timestamp");
}

const commitHits = collectCommitHits(DIST_DIR, expectedCommit);
if (commitHits.length === 0) {
  fail(
    `no built frontend asset embeds commit ${expectedCommit}; dist may be stale or partially rebuilt`,
  );
}

console.log(
  `Verified frontend build for ${expectedCommit} in ${commitHits.length} asset(s): ${commitHits.join(", ")}`,
);
