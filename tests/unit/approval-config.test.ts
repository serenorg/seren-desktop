// Unit tests for Gateway tool approval classification.
//
// Tool names below are the REAL operationIds the Gateway exposes (verified against
// the live publisher listing), not REST-path placeholders. The prior suite asserted
// against synthetic `messages/123/delete`-style inputs that never occur in production,
// which hid a classifier that matched nothing on the real names.

import { describe, expect, it } from "vitest";
import {
  classifyGatewayOperation,
  getApprovalRequirement,
  isHighRiskOperation,
  isReadOperation,
  requiresApproval,
} from "@/lib/tools/approval-config";

describe("approval-config", () => {
  describe("Gmail reads are silent (regression: they used to prompt)", () => {
    it("classifies real Gmail read operationIds as trusted-read", () => {
      for (const tool of [
        "get_messages",
        "get_messages_by_message_id",
        "get_threads",
        "get_threads_by_thread_id",
        "get_labels",
        "get_labels_by_label_id",
        "get_profile",
        "get_drafts",
        "get_health",
      ]) {
        expect(classifyGatewayOperation("gmail", tool)).toBe("trusted-read");
        expect(requiresApproval("gmail", tool)).toBe(false);
      }
    });
  });

  describe("Gmail high-risk mutations require one-shot approval", () => {
    it("escalates permanent deletes and outbound sends", () => {
      for (const tool of [
        "delete_messages_by_message_id",
        "delete_labels_by_label_id",
        "post_send",
        "post_messages_send",
        "post_drafts_by_draft_id_send",
      ]) {
        expect(classifyGatewayOperation("gmail", tool)).toBe("high-risk");
        expect(requiresApproval("gmail", tool)).toBe(true);
      }
    });
  });

  describe("Gmail reversible writes are session-grantable, not one-shot", () => {
    it("leaves trash/modify/create-label unclassified (approve once, then grant)", () => {
      for (const tool of [
        "post_messages_by_message_id_trash",
        "post_messages_by_message_id_modify",
        "post_threads_by_thread_id_trash",
        "post_labels",
      ]) {
        expect(classifyGatewayOperation("gmail", tool)).toBe("unclassified");
        expect(requiresApproval("gmail", tool)).toBe(false);
      }
    });
  });

  describe("structural classification is publisher-agnostic", () => {
    it("escalates monetary, trading, transfer, and destructive operations on any publisher", () => {
      expect(requiresApproval("alpaca", "post_orders")).toBe(true);
      expect(requiresApproval("some-dex", "post_swap")).toBe(true);
      expect(requiresApproval("some-wallet", "post_transfers")).toBe(true);
      expect(requiresApproval("some-bank", "post_withdrawals")).toBe(true);
      expect(requiresApproval("attio", "delete_records_by_id")).toBe(true);
    });

    it("treats an ordinary write on an unknown publisher as a session-grantable mutation", () => {
      expect(classifyGatewayOperation("attio", "post_notes")).toBe(
        "unclassified",
      );
      expect(requiresApproval("attio", "post_notes")).toBe(false);
    });

    it("does not auto-trust reads for an unknown publisher", () => {
      expect(classifyGatewayOperation("attio", "get_records")).toBe(
        "unclassified",
      );
    });
  });

  describe("read verbs gate the high-risk token scan", () => {
    it("never escalates a read even when its name contains a money-shaped noun", () => {
      expect(isReadOperation("get_transfers")).toBe(true);
      expect(requiresApproval("some-publisher", "get_transfers")).toBe(false);
      expect(requiresApproval("some-publisher", "list_orders")).toBe(false);
      expect(requiresApproval("some-publisher", "search_payments")).toBe(false);
    });
  });

  describe("isHighRiskOperation", () => {
    it("flags irreversible/monetary/outbound verbs and ignores reads and inspects", () => {
      expect(isHighRiskOperation("delete_record")).toBe(true);
      expect(isHighRiskOperation("post_transfers")).toBe(true);
      expect(isHighRiskOperation("execute_wallet_transfer")).toBe(true);
      expect(isHighRiskOperation("inspect_records")).toBe(false);
      expect(isHighRiskOperation("get_transfers")).toBe(false);
    });
  });

  describe("seren built-in reads stay trusted", () => {
    it("keeps the explicit built-in read allowlist", () => {
      expect(classifyGatewayOperation("seren", "list_projects")).toBe(
        "trusted-read",
      );
      expect(classifyGatewayOperation("new-publisher", "inspect_records")).toBe(
        "unclassified",
      );
    });
  });

  describe("getApprovalRequirement", () => {
    it("returns the description for a matching high-risk operationId", () => {
      const req = getApprovalRequirement("gmail", "delete_messages_by_message_id");
      expect(req).not.toBeNull();
      expect(req?.publisherSlug).toBe("gmail");
      expect(req?.description).toBe("Permanently delete email");
      expect(req?.isDestructive).toBe(true);
    });

    it("returns null for a read operation", () => {
      expect(getApprovalRequirement("gmail", "get_messages")).toBeNull();
    });
  });
});
