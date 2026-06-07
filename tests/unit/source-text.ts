// ABOUTME: Shared reader for source-contract tests that assert code structure.
// ABOUTME: Normalizes CRLF checkouts to LF so tests pin contracts, not Git line endings.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function normalizeSourceText(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

export function readSource(relativePath: string): string {
  return normalizeSourceText(readFileSync(resolve(relativePath), "utf-8"));
}
