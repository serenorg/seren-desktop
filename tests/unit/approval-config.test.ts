// Unit tests for Gateway tool approval configuration

import { describe, expect, it } from "vitest";
import {
  getApprovalRequirement,
  requiresApproval,
} from "@/lib/tools/approval-config";

describe("approval-config", () => {
  describe("requiresApproval", () => {
    it("should require approval for Gmail delete operations", () => {
      expect(requiresApproval("gmail", "messages/123/delete")).toBe(true);
    });

    it("should require approval for Gmail trash operations", () => {
      expect(requiresApproval("gmail", "messages/456/trash")).toBe(true);
      expect(requiresApproval("gmail", "threads/789/trash")).toBe(true);
    });

    it("should require approval for Gmail modify operations", () => {
      expect(requiresApproval("gmail", "messages/123/modify")).toBe(true);
    });

    it("should require approval for label operations", () => {
      expect(requiresApproval("gmail", "labels")).toBe(true);
      expect(requiresApproval("gmail", "labels/123/delete")).toBe(true);
    });

    it("should require approval for sending emails", () => {
      expect(requiresApproval("gmail", "messages/send")).toBe(true);
      expect(requiresApproval("gmail", "drafts/123/send")).toBe(true);
    });

    it("should NOT require approval for read operations", () => {
      expect(requiresApproval("gmail", "messages")).toBe(false);
      expect(requiresApproval("gmail", "messages/123")).toBe(false);
      expect(requiresApproval("gmail", "threads")).toBe(false);
      expect(requiresApproval("gmail", "threads/456")).toBe(false);
      expect(requiresApproval("gmail", "labels/list")).toBe(false);
    });

    it("should NOT require approval for non-Gmail publishers", () => {
      expect(requiresApproval("other-publisher", "messages/123/delete")).toBe(
        false,
      );
    });
  });

  describe("getApprovalRequirement", () => {
    it("should return requirement for matching operations", () => {
      const req = getApprovalRequirement("gmail", "messages/123/delete");
      expect(req).not.toBeNull();
      expect(req?.publisherSlug).toBe("gmail");
      expect(req?.description).toBe("Permanently delete email");
      expect(req?.isDestructive).toBe(true);
    });

    it("should return null for non-matching operations", () => {
      const req = getApprovalRequirement("gmail", "messages");
      expect(req).toBeNull();
    });

    it("should match wildcard patterns correctly", () => {
      const req1 = getApprovalRequirement("gmail", "messages/abc123/trash");
      expect(req1?.description).toBe("Move email to trash");

      const req2 = getApprovalRequirement("gmail", "threads/xyz789/trash");
      expect(req2?.description).toBe("Move thread to trash");
    });
  });
});
