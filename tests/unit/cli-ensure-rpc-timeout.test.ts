// ABOUTME: Guards #3692 — CLI ensure/retry RPCs must outlive real first-install work.
// ABOUTME: Pins the extended timeout so the default 30s RPC deadline cannot race npm installs.

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/browser-local-runtime", () => ({
  isLocalProviderRuntime: () => true,
  onRuntimeEvent: vi.fn(),
  runtimeInvoke: vi.fn(async () => "/managed/bin/cli"),
}));
vi.mock("@/lib/runtime", () => ({ runtimeHasCapability: () => true }));
vi.mock("@/lib/tauri-bridge", () => ({ isTauriRuntime: () => false }));

import { runtimeInvoke } from "@/lib/browser-local-runtime";
import {
  ensureClaudeCli,
  ensureCodexCli,
  ensureGeminiCli,
  ensureGrokCli,
  ensurePairedCli,
  retryCliUpdate,
} from "@/services/providers";

const runtimeInvokeMock = vi.mocked(runtimeInvoke);

describe("#3692 CLI ensure/retry RPC timeout", () => {
  it("passes a ten-minute timeout for every install-bound ensure/retry RPC", async () => {
    await ensureClaudeCli();
    await ensureCodexCli();
    await ensureGeminiCli();
    await ensureGrokCli();
    await ensurePairedCli();
    await retryCliUpdate("claude");

    expect(runtimeInvokeMock).toHaveBeenCalledTimes(6);
    for (const [command, , options] of runtimeInvokeMock.mock.calls) {
      expect([
        "provider_ensure_agent_cli",
        "provider_retry_cli_update",
      ]).toContain(command);
      expect(options).toEqual({ timeoutMs: 600_000 });
    }
  });
});
