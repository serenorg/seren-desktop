// ABOUTME: Regression coverage for #3664: cancelling an Antigravity turn must
// ABOUTME: persist one cancellation entry, not one per terminal event.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// A real executable standing in for the Antigravity CLI: it answers the
// version and model probes, then blocks so the turn can be cancelled while
// it is still running. No runtime behavior is stubbed.
const binDir = mkdtempSync(path.join(tmpdir(), "seren-agy-test-"));
const stubBinary = path.join(binDir, "agy-stub.mjs");
writeFileSync(
  stubBinary,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.1.10"); process.exit(0); }
if (args[0] === "models") { console.log("gemini-3.1-pro-high"); process.exit(0); }
setInterval(() => {}, 1000);
`,
);
chmodSync(stubBinary, 0o755);

vi.mock("../../bin/browser-local/antigravity-binary.mjs", async () => {
  const actual = await vi.importActual<
    typeof import("../../bin/browser-local/antigravity-binary.mjs")
  >("../../bin/browser-local/antigravity-binary.mjs");
  return { ...actual, resolveAntigravityBinary: () => stubBinary };
});

// @ts-expect-error — browser-local runtime is plain ESM without declarations.
const { createGeminiRuntime } = await import(
  "../../bin/browser-local/gemini-runtime.mjs"
);

describe("Antigravity cancellation (#3664)", () => {
  it("emits one error for a cancelled turn even after the killed child closes", async () => {
    const events: { name: string; payload: { error?: string } }[] = [];
    const runtime = createGeminiRuntime({
      emit: (name: string, payload: { error?: string }) =>
        events.push({ name, payload }),
    });

    const session = await runtime.spawnSession({
      localSessionId: "session-1",
      cwd: binDir,
    });

    const prompt = runtime.sendPrompt({
      sessionId: session.id,
      prompt: "long running work",
    });
    await vi.waitFor(() => expect(events.some((e) => e.name === "provider://session-status")).toBe(true));

    await runtime.cancelPrompt({ sessionId: session.id });
    // The killed child's close lands after cancel and drives sendPrompt into
    // its catch carrying the same "Task cancelled" message.
    await expect(prompt).rejects.toThrow(/Task cancelled/);

    const cancellations = events.filter(
      (event) =>
        event.name === "provider://error" &&
        event.payload.error === "Task cancelled",
    );
    expect(cancellations).toHaveLength(1);
  });
});
