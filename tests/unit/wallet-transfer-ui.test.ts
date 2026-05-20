// ABOUTME: Static UI contract tests for wallet transfer controls.
// ABOUTME: Guards retry idempotency and pending invite affordances.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markLatestReceivedTransferSeen,
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
  const transfer: LatestReceivedTransfer = {
    id: "transfer-1",
    amount_usd: "$5.00",
    sender_display_name: "Sender",
    sender_email: "sender@example.com",
    received_at: "2026-05-20T00:00:00Z",
  };

  let storage = new Map<string, string>();

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("primes historical transfers without notifying on first launch", () => {
    expect(markLatestReceivedTransferSeen("wallet-a", transfer)).toBe(false);
    expect(storage.get("seren:last-received-transfer:wallet-a")).toBe(
      "transfer-1",
    );
  });

  it("primes an account with no transfer history so the first later transfer notifies", () => {
    expect(markLatestReceivedTransferSeen("wallet-a", null)).toBe(false);
    expect(storage.get("seren:last-received-transfer:wallet-a")).toBe("none");

    expect(markLatestReceivedTransferSeen("wallet-a", transfer)).toBe(true);
    expect(storage.get("seren:last-received-transfer:wallet-a")).toBe(
      "transfer-1",
    );
  });

  it("deduplicates repeated polls for the same transfer", () => {
    storage.set("seren:last-received-transfer:wallet-a", "transfer-1");

    expect(markLatestReceivedTransferSeen("wallet-a", transfer)).toBe(false);
  });

  it("tracks users independently by wallet address", () => {
    storage.set("seren:last-received-transfer:wallet-a", "transfer-1");

    expect(markLatestReceivedTransferSeen("wallet-b", transfer)).toBe(false);
    expect(storage.get("seren:last-received-transfer:wallet-b")).toBe(
      "transfer-1",
    );
  });
});
