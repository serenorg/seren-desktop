// ABOUTME: Tests wallet balance polling integration for received-transfer notifications.
// ABOUTME: Verifies unread batches notify in chronological order and mark rows read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const walletMocks = vi.hoisted(() => ({
  fetchBalance: vi.fn(),
  markWalletNotificationRead: vi.fn(),
}));

const notificationMocks = vi.hoisted(() => ({
  postNotification: vi.fn(),
}));

vi.mock("@/services/dailyClaim", () => ({
  claimDailyCredits: vi.fn(),
  fetchDailyEligibility: vi.fn(),
}));

vi.mock("@/services/wallet", () => ({
  fetchBalance: walletMocks.fetchBalance,
  markWalletNotificationRead: walletMocks.markWalletNotificationRead,
}));

vi.mock("@/services/notifications", () => ({
  postNotification: notificationMocks.postNotification,
}));

import { refreshBalance, resetWalletState } from "@/stores/wallet.store";

describe("wallet received-transfer notification batches", () => {
  beforeEach(() => {
    walletMocks.fetchBalance.mockReset();
    walletMocks.markWalletNotificationRead.mockReset();
    walletMocks.markWalletNotificationRead.mockResolvedValue(undefined);
    notificationMocks.postNotification.mockReset();
    notificationMocks.postNotification.mockResolvedValue(undefined);
    resetWalletState();

    // Pin the clock inside the 24h notify window for the fixture timestamps below.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-20T22:33:00Z"));

    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    resetWalletState();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("notifies unread received transfers oldest-first and marks each read", async () => {
    walletMocks.fetchBalance.mockResolvedValue({
      wallet_address: "wallet-a",
      balance_atomic: 9_000_000,
      balance_usd: "$9.00",
      unread_received_transfers: [
        {
          notification_id: "notification-new",
          transfer_id: "transfer-new",
          amount_atomic: 3_000_000,
          amount_usd: "$3.00",
          sender_display_name: "New Sender",
          sender_email: "new@example.com",
          received_at: "2026-05-20T22:32:00Z",
        },
        {
          notification_id: "notification-mid",
          transfer_id: "transfer-mid",
          amount_atomic: 2_000_000,
          amount_usd: "$2.00",
          sender_display_name: "Mid Sender",
          sender_email: "mid@example.com",
          received_at: "2026-05-20T22:31:00Z",
        },
        {
          notification_id: "notification-old",
          transfer_id: "transfer-old",
          amount_atomic: 1_000_000,
          amount_usd: "$1.00",
          sender_display_name: "Old Sender",
          sender_email: "old@example.com",
          received_at: "2026-05-20T22:30:00Z",
        },
      ],
    });

    await refreshBalance();

    await vi.waitFor(() => {
      expect(walletMocks.markWalletNotificationRead).toHaveBeenCalledTimes(3);
      expect(notificationMocks.postNotification).toHaveBeenCalledTimes(3);
    });

    expect(walletMocks.markWalletNotificationRead.mock.calls.map(([id]) => id))
      .toEqual(["notification-old", "notification-mid", "notification-new"]);
    // Native path posts (title, body); assert both fire oldest-first.
    expect(
      notificationMocks.postNotification.mock.calls.map(([title]) => title),
    ).toEqual([
      "SerenBucks received",
      "SerenBucks received",
      "SerenBucks received",
    ]);
    expect(
      notificationMocks.postNotification.mock.calls.map(([, body]) => body),
    ).toEqual([
      "Old Sender sent $1.00",
      "Mid Sender sent $2.00",
      "New Sender sent $3.00",
    ]);
  });
});
