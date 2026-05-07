// ABOUTME: Critical regression tests for #1838 — wallet deposit errors must
// ABOUTME: surface server detail, HTTP signatures must not collapse session-wide.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api", () => ({
  createDeposit: vi.fn(),
}));

import { createDeposit } from "@/api";
import {
  __supportReportingTestHooks,
  captureSupportError,
} from "@/lib/support/hook";
import { supportSignature } from "@/lib/support/signature";
import { initiateTopUp } from "@/services/wallet";

if (!__supportReportingTestHooks) {
  throw new Error(
    "__supportReportingTestHooks unavailable; run tests with import.meta.env.DEV=true",
  );
}
const supportHooks = __supportReportingTestHooks;

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

describe("#1838 supportSignature differentiates HTTP failures by endpoint", () => {
  it("HTTP errors with empty stack but different endpoints produce different signatures", async () => {
    // Pre-fix every captureHttpFailure produced sha256("http_error\n"), so the
    // first 4xx of a session burned the dedupe slot for every later one (e.g.
    // a /wallet/balance 401 silenced every /wallet/deposit 4xx that followed).
    // Folding the request shape into the signature is the load-bearing fix.
    const depositSig = await supportSignature(
      {
        kind: "http_error",
        message: "POST https://api.serendb.com/wallet/deposit returned 400",
        stack: [],
      },
      {
        method: "POST",
        url: "https://api.serendb.com/wallet/deposit",
        status: 400,
      },
    );
    const balanceSig = await supportSignature(
      {
        kind: "http_error",
        message: "GET https://api.serendb.com/wallet/balance returned 401",
        stack: [],
      },
      {
        method: "GET",
        url: "https://api.serendb.com/wallet/balance",
        status: 401,
      },
    );

    expect(depositSig).toMatch(/^[a-f0-9]{64}$/);
    expect(balanceSig).toMatch(/^[a-f0-9]{64}$/);
    expect(depositSig).not.toBe(balanceSig);
  });
});

describe("#1838 captureSupportError leaves a trail when dedupe drops a capture", () => {
  beforeEach(() => {
    installBrowserGlobals();
    localStorage.setItem("seren_api_key", "seren_test_key");
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

  it("dedupe-dropped captures append a log_slice entry so the drop is visible in the next report", async () => {
    const input = {
      kind: "http_error",
      message: "POST /wallet/deposit returned 400",
      stack: [],
      http: {
        method: "POST",
        url: "https://api.serendb.com/wallet/deposit",
        status: 400,
      },
    };

    await captureSupportError(input);
    await flushSupportPipeline();
    const before = supportHooks.logSlice();

    // Same kind+stack+http → same signature → must dedupe-drop. Pre-fix this
    // returned silently with no log, no warn, no log_slice entry, leaving
    // operators with no way to correlate "I saw an error" with "no ticket".
    await captureSupportError(input);
    await flushSupportPipeline();

    const after = supportHooks.logSlice();
    expect(after.length).toBeGreaterThan(before.length);
    const tail = after.at(-1);
    expect(tail?.module).toBe("support-report");
    expect(tail?.message).toMatch(/dropped duplicate signature/);
  });
});

describe("#1838 initiateTopUp surfaces server status and message", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(createDeposit).mockReset();
  });

  it("throws an Error containing the HTTP status and the server-supplied message on 4xx", async () => {
    vi.mocked(createDeposit).mockResolvedValue({
      data: undefined,
      error: { message: "Amount exceeds per-purchase limit of $300" },
      response: new Response(null, { status: 400 }),
    } as unknown as Awaited<ReturnType<typeof createDeposit>>);

    // Pre-fix this threw a hardcoded "Failed to initiate top-up" with no
    // status, no body, no console.error — operators had nothing to grep.
    await expect(initiateTopUp(500)).rejects.toThrow(
      /400.*Amount exceeds per-purchase limit of \$300/,
    );
    expect(console.error).toHaveBeenCalled();
  });
});
