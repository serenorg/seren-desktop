// ABOUTME: Regression tests for host-owned, cross-turn Gmail sender confirmation.
// ABOUTME: Proves model-visible selectors cannot authorize a send by themselves.

import { beforeEach, describe, expect, it } from "vitest";
import {
  hasConfirmedGmailSenderForTurn,
  markGmailSenderConfirmed,
  noteGmailSenderProfileVerified,
  resetGmailSenderConfirmationsForTests,
} from "@/stores/gmail-send-confirmation.store";

describe("Gmail sender confirmation checkpoints (#3589)", () => {
  beforeEach(() => resetGmailSenderConfirmationsForTests());

  it("rejects a copied selector until a later human turn", () => {
    noteGmailSenderProfileVerified("thread-1", "conn-primary", "turn-1");

    expect(
      hasConfirmedGmailSenderForTurn(
        "thread-1",
        "conn-primary",
        "turn-1",
      ),
    ).toBe(false);
    expect(
      hasConfirmedGmailSenderForTurn(
        "thread-1",
        "conn-primary",
        "turn-2",
      ),
    ).toBe(true);
  });

  it("binds the send to the account most recently verified after the reply", () => {
    noteGmailSenderProfileVerified("thread-1", "conn-primary", "turn-1");
    noteGmailSenderProfileVerified("thread-1", "conn-secondary", "turn-2");

    expect(
      hasConfirmedGmailSenderForTurn(
        "thread-1",
        "conn-primary",
        "turn-2",
      ),
    ).toBe(false);
    expect(
      hasConfirmedGmailSenderForTurn(
        "thread-1",
        "conn-secondary",
        "turn-2",
      ),
    ).toBe(true);
  });

  it("keeps the successful sender active and re-checkpoints a changed account", () => {
    noteGmailSenderProfileVerified("thread-1", "conn-primary", "turn-1");
    markGmailSenderConfirmed("thread-1", "conn-primary");

    expect(
      hasConfirmedGmailSenderForTurn(
        "thread-1",
        "conn-primary",
        "turn-1",
      ),
    ).toBe(true);
    expect(
      hasConfirmedGmailSenderForTurn(
        "thread-1",
        "conn-secondary",
        "turn-2",
      ),
    ).toBe(false);

    noteGmailSenderProfileVerified("thread-1", "conn-secondary", "turn-2");
    expect(
      hasConfirmedGmailSenderForTurn(
        "thread-1",
        "conn-secondary",
        "turn-2",
      ),
    ).toBe(false);
    expect(
      hasConfirmedGmailSenderForTurn(
        "thread-1",
        "conn-secondary",
        "turn-3",
      ),
    ).toBe(true);
  });
});
