// ABOUTME: Unit tests for desktop support-report payload helpers.
// ABOUTME: Guards redaction, bundle caps, signatures, and agent-store wiring.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __supportReportingTestHooks,
  captureSupportError,
  installSupportReporting,
} from "@/lib/support/hook";
import {
  capSupportPayload,
  redactPrompt,
  redactString,
  redactSupportPayload,
  redactToolArgs,
  redactToolId,
  redactToolName,
} from "@/lib/support/redact";
import { supportSignature } from "@/lib/support/signature";
import type { SupportReportPayload } from "@/lib/support/types";

// `__supportReportingTestHooks` is gated behind `import.meta.env.DEV` so
// production bundles drop the closure. Vitest runs with DEV=true, but the
// public type is `... | undefined`; assert once and alias for the rest of
// the file to keep call sites tidy.
if (!__supportReportingTestHooks) {
  throw new Error(
    "__supportReportingTestHooks unavailable; run tests with import.meta.env.DEV=true",
  );
}
const supportHooks = __supportReportingTestHooks;

function payload(overrides: Partial<SupportReportPayload> = {}): SupportReportPayload {
  return {
    schema_version: 1,
    signature: "a".repeat(64),
    install_id: "b".repeat(16),
    session_id_hash: "c".repeat(16),
    app_version: "test",
    tauri_version: "test",
    os: "darwin",
    arch: "aarch64",
    timestamp: new Date(0).toISOString(),
    crash_recovery: false,
    truncated: false,
    error: {
      kind: "Error",
      message: "Bearer secret-token at /Users/alice/project",
      stack: ["at run (/Users/alice/project/file.ts:1:2)"],
    },
    log_slice: [],
    ...overrides,
  };
}

function signatureFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function installBrowserGlobals(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
}

async function flushSupportPipeline(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("support report redaction", () => {
  it("redacts credentials and normalizes local paths", () => {
    const input =
      "Bearer abc.def seren_abcdefghi test@example.com /Users/alice/project C:\\Users\\bob\\AppData";
    expect(redactString(input)).toBe(
      "Bearer [REDACTED] [REDACTED_SEREN_KEY] [REDACTED_EMAIL] $HOME/project $HOME\\AppData",
    );
  });

  it("redacts report fields before submission", () => {
    const redacted = redactSupportPayload(
      payload({
        http: {
          method: "POST",
          url: "https://api.serendb.com/x?key=seren_abcdefghi",
          status: 500,
          body: "xoxb-1234567890",
        },
        log_slice: [
          {
            ts: new Date(0).toISOString(),
            level: "ERROR",
            module: "/Users/alice/module",
            message: "ghp_abcdefghijklmnopqrstuvwxyz",
          },
        ],
      }),
    );

    expect(JSON.stringify(redacted)).not.toContain("alice");
    expect(JSON.stringify(redacted)).not.toContain("seren_abcdefghi");
    expect(JSON.stringify(redacted)).not.toContain("xoxb-1234567890");
    expect(JSON.stringify(redacted)).not.toContain("ghp_");
  });

  it("redacts prompt text and unsafe tool args", () => {
    expect(redactPrompt("please read /Users/alice/private.txt")).toBe(
      "<prompt len=36>",
    );
    expect(
      redactToolArgs({
        name: "read_file",
        path: "/Users/alice/private.txt",
        options: { token: "seren_abcdefghi" },
      }),
    ).toEqual({
      name: "read_file",
      path: "<redacted len=24>",
      options: "<redacted len=27>",
    });
  });

  it("only keeps safe tool names and ids", () => {
    const unsafeName = "/Users/alice/private.txt";
    const unsafeId = "call for /Users/alice/private.txt";

    expect(redactToolName("gateway__github__list_issues")).toBe(
      "gateway__github__list_issues",
    );
    expect(redactToolName(unsafeName)).toBe(
      `<redacted len=${unsafeName.length}>`,
    );
    expect(redactToolId("11111111-2222-3333-4444-555555555555")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(redactToolId(unsafeId)).toBe(`<redacted len=${unsafeId.length}>`);
  });

  it("redacts circular tool arg values without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(redactToolArgs({ payload: circular })).toEqual({
      payload: "<redacted len=circular>",
    });
  });

  it("redacts circular tool args wrapped in arrays without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // Array branch recurses into `redactToolArgs(item)`, which then enters
    // the object branch. The inner `self` value is non-string, non-allowlisted
    // and non-array, so it falls through to `safeJsonLength` and is stamped.
    expect(redactToolArgs([circular])).toEqual([
      { self: "<redacted len=circular>" },
    ]);
  });
});

describe("support report hook behavior", () => {
  beforeEach(() => {
    installBrowserGlobals();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 201 }))),
    );
  });

  afterEach(() => {
    supportHooks.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps seen signatures capped with FIFO eviction", () => {
    for (let i = 0; i < 256; i++) {
      expect(supportHooks.rememberSignature(signatureFor(i))).toBe(
        true,
      );
    }

    expect(supportHooks.seenSignatures()).toHaveLength(256);
    expect(supportHooks.rememberSignature(signatureFor(256))).toBe(
      true,
    );
    expect(supportHooks.seenSignatures()).toHaveLength(256);
    expect(supportHooks.seenSignatures()).not.toContain(
      signatureFor(0),
    );
    expect(supportHooks.seenSignatures()[0]).toBe(signatureFor(1));
    expect(supportHooks.rememberSignature(signatureFor(256))).toBe(
      false,
    );
  });

  it("does not report console.error calls without an Error-like value", async () => {
    installSupportReporting();
    console.error("provider unavailable", { code: "ECONNREFUSED" });

    await flushSupportPipeline();

    expect(supportHooks.seenSignatures()).toEqual([]);
  });

  it("reports console.error calls with Error-like values", async () => {
    installSupportReporting();
    console.error(new Error("terminal failure"));

    await flushSupportPipeline();

    expect(supportHooks.seenSignatures()).toHaveLength(1);
  });

  it("does not drop concurrent unrelated captures", async () => {
    await Promise.all([
      captureSupportError({
        kind: "concurrent_first",
        message: "first failure",
        stack: ["at first (/Users/alice/app/first.ts:1:1)"],
      }),
      captureSupportError({
        kind: "concurrent_second",
        message: "second failure",
        stack: ["at second (/Users/alice/app/second.ts:1:1)"],
      }),
    ]);

    await flushSupportPipeline();

    expect(supportHooks.seenSignatures()).toHaveLength(2);
  });

  it("logs submit failures through console.warn with the report signature without re-entering reporting (#1736)", async () => {
    localStorage.setItem("seren_api_key", "seren_test_key");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Bearer secret-token"))),
    );

    await captureSupportError({
      kind: "submit_failure_test",
      message: "submit failure test",
      stack: [],
    });
    await flushSupportPipeline();

    // The warn line shape is "[support-report] submit failed (signature=..., reason=...)".
    // Two regression guarantees we lock in:
    // 1. Redaction works — raw "Bearer secret-token" must not appear in the log
    //    (only the redacted "Bearer [REDACTED]" form does). #1736 keeps the
    //    redactString call from the original logSubmitFailure path.
    // 2. The line is loud (console.warn) so it lands in the support log slice
    //    rather than vanishing into console.debug — without this, silent
    //    submission failures like the 2026-04-29 cascade are invisible.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[support-report\] submit failed \(signature=[0-9a-f]{1,16}, reason=.*Bearer \[REDACTED\].*\)$/,
      ),
    );
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("secret-token"),
    );
  });
});

describe("support report payload sizing", () => {
  it("drops oldest log entries and marks truncated", () => {
    const capped = capSupportPayload(
      payload({
        log_slice: Array.from({ length: 16 }, (_, index) => ({
          ts: new Date(index).toISOString(),
          level: "ERROR",
          module: "test",
          message: "x".repeat(200),
        })),
      }),
      1200,
    );

    expect(capped.truncated).toBe(true);
    expect(capped.log_slice.length).toBeLessThan(16);
    expect(capped.log_slice[0]?.ts).not.toBe(new Date(0).toISOString());
  });

  it("truncates large http bodies when logs are already empty", () => {
    const capped = capSupportPayload(
      payload({
        http: {
          method: "POST",
          url: "https://api.serendb.com/test",
          status: 500,
          body: "x".repeat(5000),
        },
        log_slice: [],
      }),
      1400,
    );

    expect(capped.truncated).toBe(true);
    expect(capped.http?.body?.length).toBeLessThan(5000);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(
      1400,
    );
  });
});

describe("support report signatures", () => {
  it("are stable across local path and line-number changes", async () => {
    const first = await supportSignature({
      kind: "TypeError",
      message: "first",
      stack: ["at run (/Users/alice/app/file.ts:10:20)"],
    });
    const second = await supportSignature({
      kind: "TypeError",
      message: "second",
      stack: ["at run (/Users/bob/app/file.ts:99:7)"],
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });
});

describe("#1630 agent-store support reporting", () => {
  it("routes terminal turn errors through captureSupportError", () => {
    const source = readFileSync(resolve("src/stores/agent.store.ts"), "utf-8");
    expect(source).toContain('from "@/lib/support/hook"');
    expect(source).toContain("captureSupportError({");
    expect(source).toContain("tool_calls: toolCalls");
    expect(source).not.toContain("TODO(#1630)");
  });
});
