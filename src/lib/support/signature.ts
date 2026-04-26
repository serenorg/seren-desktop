import type { SupportReportErrorInfo } from "./types";

function normalizeFrame(frame: string): string {
  return frame
    .replace(/file:\/\/\/[^\s)]+/g, "file:///$PATH")
    .replace(/(?:\/Users|\/home)\/[^/\s)]+/g, "$HOME")
    .replace(/[A-Z]:\\Users\\[^\\\s)]+/gi, "$HOME")
    .replace(/:\d+:\d+/g, ":N:N")
    .trim();
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
): Promise<string> {
  const topFrames = error.stack.slice(0, 3).map(normalizeFrame).join("\n");
  return sha256Hex(`${error.kind}\n${topFrames}`);
}
