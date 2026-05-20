// ABOUTME: Static UI contract tests for wallet transfer controls.
// ABOUTME: Guards retry idempotency and pending invite affordances.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markLatestReceivedTransferSeen,
  resetWalletState,
  type LatestReceivedTransfer,
} from "../../src/stores/wallet.store";

const sendTransferModal = readFileSync(
  resolve("src/components/wallet/SendTransferModal.tsx"),
  "utf-8",
);
const settingsPanel = readFileSync(
  resolve("src/components/settings/SettingsPanel.tsx"),
  "utf-8",
);

describe("Wallet transfer UI", () => {
  it("keeps send transfer controls in wallet settings behind a portal modal", () => {
    expect(settingsPanel).toContain("Send SerenBucks");
    expect(settingsPanel).toContain("setShowSendTransferModal(true)");
    expect(sendTransferModal).toContain("<Portal>");
    expect(sendTransferModal).toContain("items-center justify-center");
    expect(sendTransferModal).toContain('aria-modal="true"');
  });

  it("uses a stable idempotency key for failed send retries", () => {
    expect(sendTransferModal).toContain(
      "const [idempotencyKey, setIdempotencyKey] = createSignal<string | null>(null);",
    );
    expect(sendTransferModal).toContain(
      "const currentIdempotencyKey = idempotencyKey() ?? transferKey();",
    );
    expect(sendTransferModal).toContain(
      "setIdempotencyKey(currentIdempotencyKey);",
    );
    expect(sendTransferModal).toContain("currentIdempotencyKey,");
    expect(sendTransferModal).toContain("setIdempotencyKey(transferKey());");
    expect(sendTransferModal).not.toContain("transferKey(),\n        memo()");
  });

  it("shows pending invite loading, failure, and recall-in-progress states", () => {
    expect(sendTransferModal).toContain("Loading pending invites...");
    expect(sendTransferModal).toContain("Pending invites could not be loaded.");
    expect(sendTransferModal).toContain("recallingTransferId");
    expect(sendTransferModal).toContain("Recalling...");
  });
});

describe("received transfer notification sentinel", () => {
  const nowMs = Date.parse("2026-05-20T22:30:00Z");
  const recentTransfer: LatestReceivedTransfer = {
    notification_id: "notification-1",
    transfer_id: "transfer-1",
    amount_atomic: 5_000_000,
    amount_usd: "$5.00",
    sender_display_name: "Sender",
    sender_email: "sender@example.com",
    received_at: "2026-05-20T22:29:00Z",
  };
  const oldTransfer: LatestReceivedTransfer = {
    notification_id: "notification-1",
    transfer_id: "transfer-1",
    amount_atomic: 5_000_000,
    amount_usd: "$5.00",
    sender_display_name: "Sender",
    sender_email: "sender@example.com",
    received_at: "2026-05-18T00:00:00Z",
  };
  const olderTransfer: LatestReceivedTransfer = {
    ...oldTransfer,
    notification_id: "notification-2",
    transfer_id: "transfer-2",
    received_at: "2026-05-17T00:00:00Z",
  };
  const secondRecentTransfer: LatestReceivedTransfer = {
    ...recentTransfer,
    notification_id: "notification-2",
    transfer_id: "transfer-2",
    received_at: "2026-05-20T22:28:00Z",
  };

  let storage = new Map<string, string>();
  const storedSentinel = (walletAddress: string) =>
    JSON.parse(
      storage.get(`seren:last-received-transfer:${walletAddress}`) ?? "{}",
    ) as { latestTransferId?: string | null; initializedAtMs?: number };

  beforeEach(() => {
    storage = new Map();
    resetWalletState();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    });
  });

  afterEach(() => {
    resetWalletState();
    vi.unstubAllGlobals();
  });

  it("notifies for recent transfers first seen at login", () => {
    expect(
      markLatestReceivedTransferSeen("wallet-a", recentTransfer, nowMs),
    ).toBe(true);
    expect(storedSentinel("wallet-a").latestTransferId).toBe("transfer-1");
  });

  it("primes stale historical transfers without notifying on first launch", () => {
    expect(markLatestReceivedTransferSeen("wallet-a", oldTransfer, nowMs)).toBe(
      false,
    );
    expect(storedSentinel("wallet-a").latestTransferId).toBe("transfer-1");
  });

  it("suppresses stale unread backlog after first login", () => {
    expect(markLatestReceivedTransferSeen("wallet-a", oldTransfer, nowMs)).toBe(
      false,
    );
    expect(
      markLatestReceivedTransferSeen("wallet-a", olderTransfer, nowMs),
    ).toBe(false);
    expect(storedSentinel("wallet-a").latestTransferId).toBe("transfer-2");
  });

  it("notifies recent unread backlog after first login", () => {
    expect(
      markLatestReceivedTransferSeen("wallet-a", recentTransfer, nowMs),
    ).toBe(true);
    expect(
      markLatestReceivedTransferSeen("wallet-a", secondRecentTransfer, nowMs),
    ).toBe(true);
  });

  it("primes an account with no transfer history so the first later transfer notifies", () => {
    expect(markLatestReceivedTransferSeen("wallet-a", null)).toBe(false);
    expect(storedSentinel("wallet-a").latestTransferId).toBeNull();

    const laterTransfer = {
      ...recentTransfer,
      received_at: "2026-05-20T22:31:00Z",
    };
    expect(markLatestReceivedTransferSeen("wallet-a", laterTransfer, nowMs)).toBe(
      true,
    );
    expect(storedSentinel("wallet-a").latestTransferId).toBe("transfer-1");
  });

  it("deduplicates repeated polls for the same transfer", () => {
    storage.set(
      "seren:last-received-transfer:wallet-a",
      JSON.stringify({
        version: 1,
        latestTransferId: "transfer-1",
        initializedAtMs: nowMs,
      }),
    );

    expect(
      markLatestReceivedTransferSeen("wallet-a", recentTransfer, nowMs),
    ).toBe(false);
  });

  it("tracks users independently by wallet address", () => {
    storage.set(
      "seren:last-received-transfer:wallet-a",
      JSON.stringify({
        version: 1,
        latestTransferId: "transfer-1",
        initializedAtMs: nowMs,
      }),
    );

    expect(
      markLatestReceivedTransferSeen("wallet-b", oldTransfer, nowMs),
    ).toBe(false);
    expect(storedSentinel("wallet-b").latestTransferId).toBe("transfer-1");
  });

  it("keeps legacy id sentinels from replaying old unread transfers", () => {
    storage.set("seren:last-received-transfer:wallet-a", "transfer-1");

    expect(
      markLatestReceivedTransferSeen("wallet-a", olderTransfer, nowMs),
    ).toBe(false);
    expect(storedSentinel("wallet-a").latestTransferId).toBe("transfer-2");
  });

  it("deduplicates in memory when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    });

    expect(
      markLatestReceivedTransferSeen("wallet-a", recentTransfer, nowMs),
    ).toBe(true);
    expect(
      markLatestReceivedTransferSeen("wallet-a", recentTransfer, nowMs),
    ).toBe(false);
  });

  it("clears the in-memory notification sentinel on wallet reset", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    });

    expect(
      markLatestReceivedTransferSeen("wallet-a", recentTransfer, nowMs),
    ).toBe(true);
    resetWalletState();
    expect(
      markLatestReceivedTransferSeen("wallet-a", recentTransfer, nowMs),
    ).toBe(true);
  });
});
