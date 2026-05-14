// ABOUTME: Tests the session-checkpoints service list/latest request/response shaping.
// ABOUTME: Guards SDK client.get payloads against accidental drift in url, path, query, and headers.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("@/api/seren-cloud", () => ({
  client: { get: getMock },
}));

import { sessionCheckpoints } from "@/services/session-checkpoints";

const ORG = "00000000-0000-0000-0000-000000000010";
const DEP = "dep_xyz";

beforeEach(() => {
  getMock.mockReset();
});

describe("sessionCheckpoints.list", () => {
  it("issues GET against /deployments/{id}/session-checkpoints with limit", async () => {
    getMock.mockResolvedValueOnce({
      data: { data: { entries: [], next_cursor: null } },
      error: undefined,
    });

    const out = await sessionCheckpoints.list(ORG, DEP, { limit: 25 });

    expect(getMock).toHaveBeenCalledTimes(1);
    const args = getMock.mock.calls[0][0];
    expect(args.url).toBe("/deployments/{id}/session-checkpoints");
    expect(args.path).toEqual({ id: DEP });
    expect(args.query).toEqual({ limit: 25 });
    expect(args.headers["x-organization-id"]).toBe(ORG);
    expect(args.throwOnError).toBe(false);
    expect(out).toEqual({ entries: [], next_cursor: null });
  });

  it("forwards cursor when supplied and non-empty", async () => {
    getMock.mockResolvedValueOnce({
      data: { data: { entries: [], next_cursor: "page-2" } },
      error: undefined,
    });

    await sessionCheckpoints.list(ORG, DEP, {
      limit: 10,
      cursor: "opaque-cursor",
    });

    const args = getMock.mock.calls[0][0];
    expect(args.query).toEqual({ limit: 10, cursor: "opaque-cursor" });
  });

  it("normalizes backend id into checkpoint_id", async () => {
    getMock.mockResolvedValueOnce({
      data: {
        data: {
          entries: [
            {
              id: "cp_1",
              organization_id: ORG,
              deployment_id: DEP,
              session_id: "sess_a",
              sequence_number: 3,
              reason: "iteration cap reached",
              iteration_count: 12,
              tool_call_state: { pending: [] },
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:01:00Z",
            },
          ],
        },
      },
      error: undefined,
    });

    const out = await sessionCheckpoints.list(ORG, DEP);

    expect(out.entries[0]).toMatchObject({
      checkpoint_id: "cp_1",
      id: "cp_1",
      organization_id: ORG,
      deployment_id: DEP,
      session_id: "sess_a",
      tool_call_state: { pending: [] },
    });
  });

  it("omits cursor when an empty string is supplied", async () => {
    getMock.mockResolvedValueOnce({
      data: { data: { entries: [] } },
      error: undefined,
    });

    await sessionCheckpoints.list(ORG, DEP, { cursor: "" });

    const args = getMock.mock.calls[0][0];
    expect(args.query).not.toHaveProperty("cursor");
  });

  it("throws when a row is missing both checkpoint_id and id", async () => {
    getMock.mockResolvedValueOnce({
      data: {
        data: {
          entries: [
            {
              organization_id: ORG,
              deployment_id: DEP,
              session_id: "sess_a",
              sequence_number: 1,
              reason: "missing id",
              iteration_count: 1,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
      error: undefined,
    });

    await expect(sessionCheckpoints.list(ORG, DEP)).rejects.toThrow(
      /Session checkpoint response did not include an id/,
    );
  });

  it("maps 404 to an operator-safe message", async () => {
    getMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "not found" },
      response: { status: 404 } as Response,
    });

    await expect(sessionCheckpoints.list(ORG, DEP)).rejects.toThrow(
      /Session checkpoints unavailable: deployment not found/,
    );
  });

  it("surfaces generic backend errors", async () => {
    getMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "bad gateway" },
      response: { status: 502 } as Response,
    });

    await expect(sessionCheckpoints.list(ORG, DEP)).rejects.toThrow(
      /Failed to list session checkpoints: bad gateway/,
    );
  });
});

describe("sessionCheckpoints.latest", () => {
  it("issues GET against /deployments/{id}/sessions/{session_id}/checkpoints/latest", async () => {
    const body = {
      id: "cp_1",
      organization_id: ORG,
      deployment_id: DEP,
      session_id: "sess_a",
      sequence_number: 3,
      reason: "iteration cap reached",
      iteration_count: 12,
      tool_call_state: { pending: ["call_1"] },
      conversation_state: { messages: [] },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:01:00Z",
    };
    getMock.mockResolvedValueOnce({
      data: { data: body },
      error: undefined,
    });

    const out = await sessionCheckpoints.latest(ORG, DEP, "sess_a");

    const args = getMock.mock.calls[0][0];
    expect(args.url).toBe(
      "/deployments/{id}/sessions/{session_id}/checkpoints/latest",
    );
    expect(args.path).toEqual({ id: DEP, session_id: "sess_a" });
    expect(args.headers["x-organization-id"]).toBe(ORG);
    expect(out).toMatchObject({
      checkpoint_id: "cp_1",
      id: "cp_1",
      conversation_state: { messages: [] },
      tool_call_state: { pending: ["call_1"] },
    });
  });

  it("returns null on 404 so callers can render empty state", async () => {
    getMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "not found" },
      response: { status: 404 } as Response,
    });

    const out = await sessionCheckpoints.latest(ORG, DEP, "sess_missing");
    expect(out).toBeNull();
  });

  it("surfaces non-404 errors", async () => {
    getMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "boom" },
      response: { status: 500 } as Response,
    });

    await expect(
      sessionCheckpoints.latest(ORG, DEP, "sess_a"),
    ).rejects.toThrow(/Failed to load latest checkpoint: boom/);
  });
});
