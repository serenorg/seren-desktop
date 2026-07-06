// ABOUTME: Guards #2875 — the ChatThinkingStatus TDZ that crashed the main surface.
// ABOUTME: showElapsedAfterMs must precede onMount, and solid-js must be deduped.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf-8");
}

describe("ChatThinkingStatus TDZ guard (#2875)", () => {
  const chatUi = source("packages/chat-ui/src/index.tsx");
  const fnStart = chatUi.indexOf("export function ChatThinkingStatus");
  const body = chatUi.slice(fnStart);

  it("declares showElapsedAfterMs before the onMount that reads it", () => {
    // A duplicate solid-js runtime (version skew + no dedupe) can run onMount
    // synchronously during render. If showElapsedAfterMs is declared after
    // onMount, that synchronous read lands in the temporal dead zone and throws
    // a ReferenceError that trips the main-surface recovery boundary.
    const declIndex = body.indexOf("const showElapsedAfterMs =");
    const onMountIndex = body.indexOf("onMount(");
    expect(fnStart).toBeGreaterThan(-1);
    expect(declIndex).toBeGreaterThan(-1);
    expect(onMountIndex).toBeGreaterThan(-1);
    expect(declIndex).toBeLessThan(onMountIndex);
  });
});

describe("solid-js dedupe guard (#2875)", () => {
  const viteConfig = source("vite.config.ts");

  it("forces a single solid-js runtime so onMount cannot run in an ownerless second copy", () => {
    expect(viteConfig).toMatch(/dedupe:\s*\[\s*["']solid-js["']/);
  });
});
