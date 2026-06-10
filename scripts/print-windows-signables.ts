// ABOUTME: CLI entrypoint that prints the Windows signable set (one absolute path per line) for the release signer.
// ABOUTME: Always executes — never imported — so there is no fragile entrypoint detection to misfire on Windows (#2284).

import process from "node:process";

import { collectSignables } from "./windows-signables";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: print-windows-signables.ts <root> [<root> ...]");
  process.exit(2);
}

const files = collectSignables(roots);
process.stdout.write(files.join("\n") + (files.length ? "\n" : ""));
