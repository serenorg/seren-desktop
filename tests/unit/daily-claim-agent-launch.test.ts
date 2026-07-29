// ABOUTME: Verifies the daily SerenBucks claim popup re-surfaces on agent launch.
// ABOUTME: Protects the un-dismiss-when-still-claimable gate and its error safety.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dailyClaimMocks = vi.hoisted(() => ({
  fetchDailyEligibility: vi.fn(),
  claimDailyCredits: vi.fn(),
}));

const mockAuthState = vi.hoisted(() => ({ isAuthenticated: true }));

vi.mock("@/services/dailyClaim", () => ({
  fetchDailyEligibility: dailyClaimMocks.fetchDailyEligibility,
  claimDailyCredits: dailyClaimMocks.claimDailyCredits,
}));

vi.mock("@/stores/auth.store", () => ({
  authStore: mockAuthState,
}));

vi.mock("@/services/notifications", () => ({
  postNotification: vi.fn(),
}));

vi.mock("@/services/wallet", () => ({
  fetchBalance: vi.fn(),
  markWalletNotificationRead: vi.fn(),
}));

import {
  dismissDailyClaim,
  resetWalletState,
  surfaceDailyClaimIfEligible,
  walletState,
} from "@/stores/wallet.store";

// Fresh objects per call — Solid's store proxies wrap values in place, so a
// shared reference reused across setState calls/tests leaks reactive state.
function eligibility(canClaim: boolean) {
  return {
    can_claim: canClaim,
    claims_remaining_this_month: canClaim ? 5 : 4,
    reason: canClaim ? null : "Already claimed today",
    resets_in_seconds: 3600,
  };
}

describe("daily claim on agent launch", () => {
  beforeEach(() => {
    dailyClaimMocks.fetchDailyEligibility.mockReset();
    mockAuthState.isAuthenticated = true;
    resetWalletState();
  });

  afterEach(() => {
    resetWalletState();
  });

  it("re-surfaces a dismissed but still-claimable reward when an agent launches", async () => {
    dailyClaimMocks.fetchDailyEligibility.mockResolvedValue(eligibility(true));
    dismissDailyClaim();
    expect(walletState.dailyClaimDismissed).toBe(true);

    await surfaceDailyClaimIfEligible();

    // The popup gate (can_claim && !dismissed) is satisfied again.
    expect(walletState.dailyClaim?.can_claim).toBe(true);
    expect(walletState.dailyClaimDismissed).toBe(false);
  });

  it("does not re-surface once the reward is already claimed", async () => {
    dailyClaimMocks.fetchDailyEligibility.mockResolvedValue(eligibility(false));
    dismissDailyClaim();

    await surfaceDailyClaimIfEligible();

    // can_claim is false, so the popup stays hidden regardless of the flag,
    // and we do not spuriously clear the dismiss flag.
    expect(walletState.dailyClaim?.can_claim).toBe(false);
    expect(walletState.dailyClaimDismissed).toBe(true);
  });

  it("leaves existing eligibility untouched on a transient fetch failure", async () => {
    // Simulate a known-eligible-but-dismissed state, then fail the refresh.
    dailyClaimMocks.fetchDailyEligibility.mockResolvedValueOnce(eligibility(true));
    await surfaceDailyClaimIfEligible();
    dismissDailyClaim();

    dailyClaimMocks.fetchDailyEligibility.mockRejectedValueOnce(
      new Error("network down"),
    );
    await surfaceDailyClaimIfEligible();

    // State is preserved (not nulled, not blocked): the launch is never gated
    // on eligibility, and we do not un-dismiss on an unconfirmed reward.
    expect(walletState.dailyClaim?.can_claim).toBe(true);
    expect(walletState.dailyClaimDismissed).toBe(true);
  });

  it("skips the eligibility fetch entirely when signed out (#3451)", async () => {
    mockAuthState.isAuthenticated = false;
    dismissDailyClaim();

    await surfaceDailyClaimIfEligible();

    // No Gateway call — a signed-out probe is a guaranteed 401 that only
    // produces console noise and captureHttpFailure diagnostics entries.
    expect(dailyClaimMocks.fetchDailyEligibility).not.toHaveBeenCalled();
    expect(walletState.dailyClaim).toBeNull();
    expect(walletState.dailyClaimDismissed).toBe(true);
  });
});
