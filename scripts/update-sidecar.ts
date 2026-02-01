// ABOUTME: Updates sidecar revisions in package.json to latest commits
// ABOUTME: Fetches latest commit SHA from each sidecar's git repository

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

interface SidecarEntry {
  name: string;
  git: string;
  rev?: string;
  tag?: string;
  branch?: string;
  bin: string;
  dest: string;
  optional?: boolean;
}

interface PackageJson {
  sidecars?: Record<string, SidecarEntry>;
  [key: string]: unknown;
}

function usage(): void {
  console.log(`
Usage: pnpm sidecar:update [sidecar-key] [--dry-run]

Updates rev-pinned sidecars in package.json to the latest commit on the remote default branch (HEAD).
Sidecars pinned by tag/branch are left unchanged.

Arguments:
  sidecar-key  Optional. Update only this sidecar (e.g., "seren-acp-codex")
               If omitted, updates all sidecars.

Options:
  --dry-run    Show what would be updated without making changes
  --help, -h   Show this help message

Examples:
  pnpm sidecar:update                     # Update all sidecars
  pnpm sidecar:update seren-acp-codex     # Update only seren-acp-codex
  pnpm sidecar:update --dry-run           # Preview changes
`);
}

function execText(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, {
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

function getLatestCommit(gitUrl: string): string {
  // Use remote HEAD so we don't assume a default branch name (main/master/etc).
  // This avoids cloning and works well with GitHub.
  const output = execText("git", ["ls-remote", gitUrl, "HEAD"]);
  const sha = output.split(/\s+/)[0];
  if (!sha || sha.length !== 40) {
    throw new Error(`Failed to resolve remote HEAD for ${gitUrl}`);
  }
  return sha;
}

function parseArgs(argv: string[]): { sidecarKey?: string; dryRun: boolean } {
  let sidecarKey: string | undefined;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!sidecarKey) {
      sidecarKey = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { sidecarKey, dryRun };
}

function main(): void {
  const { sidecarKey, dryRun } = parseArgs(process.argv.slice(2));

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, "..");
  const packageJsonPath = path.join(rootDir, "package.json");

  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }

  const content = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(content) as PackageJson;

  if (!pkg.sidecars) {
    throw new Error('No "sidecars" section found in package.json');
  }

  const sidecarsToUpdate = sidecarKey
    ? { [sidecarKey]: pkg.sidecars[sidecarKey] }
    : pkg.sidecars;

  if (sidecarKey && !pkg.sidecars[sidecarKey]) {
    throw new Error(
      `Sidecar "${sidecarKey}" not found. Available: ${Object.keys(pkg.sidecars).join(", ")}`,
    );
  }

  console.log(dryRun ? "Dry run - checking for updates:\n" : "Updating sidecars:\n");

  let hasUpdates = false;

  for (const [key, entry] of Object.entries(sidecarsToUpdate)) {
    if (!entry) continue;

    console.log(`${entry.name} (${key}):`);
    console.log(`  Repository: ${entry.git}`);
    const pinValues = [entry.rev?.trim(), entry.tag?.trim(), entry.branch?.trim()].filter(Boolean);
    if (pinValues.length !== 1) {
      console.log(`  Error:      must specify exactly one of rev/tag/branch in package.json\n`);
      continue;
    }

    if (entry.rev) {
      console.log(`  Current:    rev ${entry.rev.slice(0, 12)}...`);
    } else if (entry.tag) {
      console.log(`  Current:    tag ${entry.tag}`);
    } else if (entry.branch) {
      console.log(`  Current:    branch ${entry.branch}`);
    } else {
      console.log(`  Current:    (missing pin)`);
    }

    try {
      if (!entry.rev) {
        console.log(`  Status:     Pinned (no update)\n`);
        continue;
      }

      const latestRev = getLatestCommit(entry.git);
      console.log(`  Latest:     rev ${latestRev.slice(0, 12)}...`);

      if (latestRev === entry.rev) {
        console.log(`  Status:     Already up to date\n`);
      } else {
        hasUpdates = true;
        if (dryRun) {
          console.log(`  Status:     Would update\n`);
        } else {
          pkg.sidecars[key].rev = latestRev;
          console.log(`  Status:     Updated\n`);
        }
      }
    } catch (err) {
      console.log(`  Error:      ${err instanceof Error ? err.message : err}\n`);
    }
  }

  if (!dryRun && hasUpdates) {
    // Preserve formatting by using 2-space indent
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    console.log("package.json updated.");
    console.log("\nNext steps:");
    console.log("  1. Review the changes: git diff package.json");
    console.log("  2. Rebuild sidecars:   pnpm build:sidecar");
    console.log("  3. Commit the update:  git add package.json && git commit");
  } else if (dryRun && hasUpdates) {
    console.log("Run without --dry-run to apply these updates.");
  } else if (!hasUpdates) {
    console.log("All sidecars are up to date.");
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  usage();
  process.exit(1);
}
