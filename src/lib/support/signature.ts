// ABOUTME: Signature builder for support reports — keys dedupe by error shape.
// ABOUTME: Folds HTTP request shape into the input when the stack is empty.

import type { SupportReportErrorInfo, SupportReportHttpInfo } from "./types";

function normalizeFrame(frame: string): string {
  return frame
    .replace(/file:\/\/\/[^\s)]+/g, "file:///$PATH")
    .replace(/(?:\/Users|\/home)\/[^/\s)]+/g, "$HOME")
    .replace(/[A-Z]:\\Users\\[^\\\s)]+/gi, "$HOME")
    .replace(/:\d+:\d+/g, ":N:N")
    .trim();
}

function normalizeUrlPath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  return pathname
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "/$ID",
    )
    .replace(/\/\d+/g, "/$N");
}

async function sha256Hex(input: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const encoded = new TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  throw new Error("crypto.subtle is unavailable");
}

export async function supportSignature(
  error: SupportReportErrorInfo,
  http?: SupportReportHttpInfo,
): Promise<string> {
  const topFrames = error.stack.slice(0, 3).map(normalizeFrame).join("\n");
  // When the stack is empty (e.g. captures from `captureHttpFailure`), keying
  // on `kind` alone collapses every distinct HTTP failure to one signature, so
  // a session's first 4xx burns the dedupe slot for every later one. Fold the
  // request shape — method, normalized path, status — into the input so HTTP
  // failures dedupe per endpoint rather than globally. Path normalization
  // strips query strings, UUIDs, and numeric IDs so /users/123 and /users/456
  // still collapse together.
  const httpKey =
    topFrames.length === 0 && http
      ? `\n${http.method} ${normalizeUrlPath(http.url)} ${http.status ?? "?"}`
      : "";
  return sha256Hex(`${error.kind}\n${topFrames}${httpKey}`);
}
