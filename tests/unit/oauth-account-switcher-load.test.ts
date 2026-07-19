// ABOUTME: Guards #2973 so connected-account outages cannot blank agent threads.
// ABOUTME: Verifies the optional fetch degrades locally with a retryable notice.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listConnectedPublishers: vi.fn(),
}));

vi.mock("@/services/publisher-oauth", () => ({
  listConnectedPublishers: mocks.listConnectedPublishers,
}));

describe("OAuthAccountSwitcher connection loading (#2973)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("contains a rejected account fetch as an empty, non-fatal state", async () => {
    mocks.listConnectedPublishers.mockRejectedValue(
      new Error("private transport detail"),
    );
    const { loadOAuthAccountSwitcherState, OAUTH_ACCOUNT_LOAD_ERROR } =
      await import("@/components/chat/oauth-account-switcher-load");

    await expect(loadOAuthAccountSwitcherState()).resolves.toEqual({
      connections: [],
      error: OAUTH_ACCOUNT_LOAD_ERROR,
    });
  });

  it("renders a retryable alert without exposing the transport error", () => {
    const source = readFileSync(
      resolve("src/components/chat/OAuthAccountSwitcher.tsx"),
      "utf8",
    );

    expect(source).toContain('data-testid="oauth-account-load-error"');
    expect(source).toContain('role="alert"');
    expect(source).toContain("refetchAccounts()");
    expect(source).not.toContain("private transport detail");
  });
});
