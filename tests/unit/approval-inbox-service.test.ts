// ABOUTME: Tests the unified approval inbox service request/response shaping.
// ABOUTME: Mocks the generated SDK functions so we assert their call args, not the raw client.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, decideMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  decideMock: vi.fn(),
}));

vi.mock("@/api/seren-cloud", () => ({
  serenCloudApprovalInboxList: listMock,
  serenCloudApprovalInboxDecide: decideMock,
}));

import {
  approvalInbox,
  ApprovalInboxNotImplementedError,
} from "@/services/approval-inbox";

const ORG = "00000000-0000-0000-0000-000000000010";

beforeEach(() => {
  listMock.mockReset();
  decideMock.mockReset();
});

describe("approvalInbox.list", () => {
  it("calls serenCloudApprovalInboxList with organization header", async () => {
    listMock.mockResolvedValueOnce({
      data: {
        data: { entries: [], next_cursor: null },
      },
      error: undefined,
    });

    const out = await approvalInbox.list(ORG, { limit: 25 });

    expect(listMock).toHaveBeenCalledTimes(1);
    const args = listMock.mock.calls[0][0];
    expect(args.query).toEqual({ limit: 25 });
    expect(args.headers["x-organization-id"]).toBe(ORG);
    expect(args.throwOnError).toBe(false);
    expect(out).toEqual({ entries: [], next_cursor: null });
  });

  it("forwards the cursor query when supplied", async () => {
    listMock.mockResolvedValueOnce({
      data: { data: { entries: [], next_cursor: "page-2" } },
      error: undefined,
    });

    const out = await approvalInbox.list(ORG, {
      limit: 10,
      cursor: "opaque-cursor",
    });

    const args = listMock.mock.calls[0][0];
    expect(args.query).toEqual({ limit: 10, cursor: "opaque-cursor" });
    expect(out.next_cursor).toBe("page-2");
  });

  it("omits cursor when an empty string is supplied", async () => {
    listMock.mockResolvedValueOnce({
      data: { data: { entries: [] } },
      error: undefined,
    });

    await approvalInbox.list(ORG, { cursor: "" });

    const args = listMock.mock.calls[0][0];
    expect(args.query).not.toHaveProperty("cursor");
  });

  it("surfaces backend errors via formatApiError", async () => {
    listMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "bad gateway" },
      response: { status: 502 } as Response,
    });

    await expect(approvalInbox.list(ORG)).rejects.toThrow(
      /Failed to list approval inbox: bad gateway/,
    );
  });
});

describe("approvalInbox.decide", () => {
  it("calls serenCloudApprovalInboxDecide with path, body, and headers", async () => {
    decideMock.mockResolvedValueOnce({
      data: {
        data: { entry_id: "tool:xyz:call_1", decision_state: "approved" },
      },
      error: undefined,
    });

    const out = await approvalInbox.decide(ORG, "tool:xyz:call_1", {
      decision: "approve",
      comment: "looks fine",
    });

    expect(decideMock).toHaveBeenCalledTimes(1);
    const args = decideMock.mock.calls[0][0];
    expect(args.path).toEqual({ entry_id: "tool:xyz:call_1" });
    expect(args.body).toEqual({ decision: "approve", comment: "looks fine" });
    expect(args.headers["x-organization-id"]).toBe(ORG);
    expect(args.throwOnError).toBe(false);
    expect(out).toEqual({
      entry_id: "tool:xyz:call_1",
      decision_state: "approved",
    });
  });

  it("omits an empty comment from the body", async () => {
    decideMock.mockResolvedValueOnce({
      data: {
        data: { entry_id: "egress:abc", decision_state: "denied" },
      },
      error: undefined,
    });

    await approvalInbox.decide(ORG, "egress:abc", { decision: "deny" });

    const args = decideMock.mock.calls[0][0];
    expect(args.body).toEqual({ decision: "deny" });
    expect(args.body).not.toHaveProperty("comment");
  });

  it("throws ApprovalInboxNotImplementedError on 501", async () => {
    decideMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "not implemented" },
      response: { status: 501 } as Response,
    });

    await expect(
      approvalInbox.decide(ORG, "egress:abc", { decision: "approve" }),
    ).rejects.toBeInstanceOf(ApprovalInboxNotImplementedError);
  });

  it("surfaces generic errors via formatApiError", async () => {
    decideMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "conflict" },
      response: { status: 409 } as Response,
    });

    await expect(
      approvalInbox.decide(ORG, "tool:xyz:call_1", { decision: "deny" }),
    ).rejects.toThrow(/Failed to record decision: conflict/);
  });
});
