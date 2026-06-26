// ABOUTME: Tests employee runtime startup retry behavior.
// ABOUTME: Keeps cold runtime starts from surfacing as immediate chat errors.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  serenCloudCreateInteractiveSession,
  serenCloudGetInteractiveSession,
  serenCloudPostInteractiveSessionMessage,
  serenCloudRun,
} from "@/api/seren-cloud";
import { runEmployeeMessage } from "@/services/employees-runtime";

vi.mock("@/api/seren-cloud", () => ({
  serenCloudCreateInteractiveSession: vi.fn(),
  serenCloudDeploymentRun: vi.fn(),
  serenCloudDeploymentRunCancel: vi.fn(),
  serenCloudDeploymentRunStream: vi.fn(),
  serenCloudGetInteractiveSession: vi.fn(),
  serenCloudPostInteractiveSessionMessage: vi.fn(),
  serenCloudRun: vi.fn(),
}));

function futureIso() {
  return new Date(Date.now() + 60_000).toISOString();
}

function pastIso() {
  return new Date(Date.now() - 60_000).toISOString();
}

describe("runEmployeeMessage startup retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries while the employee runtime is still starting", async () => {
    vi.mocked(serenCloudRun)
      .mockResolvedValueOnce({
        data: undefined,
        error: {
          message: "Deployment is still starting. Try again in a moment.",
        },
        response: new Response(null, { status: 400 }),
      } as never)
      .mockResolvedValueOnce({
        data: {
          data: {
            result: { text: "Ready now." },
            run_id: null,
            status: "completed",
          },
        },
        error: undefined,
        response: new Response(null, { status: 200 }),
      } as never);
    const onStartupWait = vi.fn();

    const result = await runEmployeeMessage("dep_1", "hello", {
      onStartupWait,
      startupRetryDelayMs: 0,
      startupRetryTimeoutMs: 5_000,
    });

    expect(result.text).toBe("Ready now.");
    expect(serenCloudRun).toHaveBeenCalledTimes(2);
    expect(onStartupWait).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        message: "Deployment is still starting. Try again in a moment.",
      }),
    );
  });

  it("fails fast when the run trigger returns a non-startup error", async () => {
    vi.mocked(serenCloudRun).mockResolvedValueOnce({
      data: undefined,
      error: { message: "Bad request: missing message" },
      response: new Response(null, { status: 400 }),
    } as never);
    const onStartupWait = vi.fn();

    await expect(
      runEmployeeMessage("dep_1", "hello", {
        onStartupWait,
        startupRetryDelayMs: 0,
        startupRetryTimeoutMs: 5_000,
      }),
    ).rejects.toThrow("Failed to start employee run: Bad request");

    expect(serenCloudRun).toHaveBeenCalledTimes(1);
    expect(onStartupWait).not.toHaveBeenCalled();
  });

  it("does not retry the failed-deployment readiness error", async () => {
    vi.mocked(serenCloudRun).mockResolvedValueOnce({
      data: undefined,
      error: {
        message:
          "Deployment is not ready to accept requests. Check agent logs and restart it.",
      },
      response: new Response(null, { status: 400 }),
    } as never);
    const onStartupWait = vi.fn();

    await expect(
      runEmployeeMessage("dep_1", "hello", {
        onStartupWait,
        startupRetryDelayMs: 0,
        startupRetryTimeoutMs: 5_000,
      }),
    ).rejects.toThrow("Failed to start employee run: Deployment is not ready");

    expect(serenCloudRun).toHaveBeenCalledTimes(1);
    expect(onStartupWait).not.toHaveBeenCalled();
  });

  it("falls back to one-shot runs when a desktop UUID is not a cloud session", async () => {
    vi.mocked(serenCloudGetInteractiveSession).mockResolvedValueOnce({
      data: undefined,
      error: { message: "not found" },
      response: new Response(null, { status: 404 }),
    } as never);
    vi.mocked(serenCloudRun).mockResolvedValueOnce({
      data: {
        data: {
          result: { text: "Desktop thread reply." },
          run_id: null,
          status: "completed",
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);

    const result = await runEmployeeMessage("dep_1", "hello", {
      conversationId: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
    });

    expect(result.text).toBe("Desktop thread reply.");
    expect(serenCloudPostInteractiveSessionMessage).not.toHaveBeenCalled();
    expect(serenCloudCreateInteractiveSession).not.toHaveBeenCalled();
    expect(serenCloudRun).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          conversation_id: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
          message: "hello",
        }),
      }),
    );
  });

  it("posts to the session endpoint when the conversation resolves to a cloud session", async () => {
    vi.mocked(serenCloudGetInteractiveSession).mockResolvedValueOnce({
      data: {
        data: {
          messages: [],
          message_pagination: {
            count: 0,
            has_more: false,
            limit: 1,
            offset: 0,
            total: 0,
          },
          session: {
            closed_at: null,
            created_at: "2026-06-26T00:00:00Z",
            deployment_id: "dep_1",
            idle_expires_at: futureIso(),
            organization_id: "org_1",
            session_id: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
            status: "open",
            updated_at: "2026-06-26T00:00:00Z",
            user_id: "user_1",
            stream_url: "",
            ws_url: "",
          },
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    vi.mocked(serenCloudPostInteractiveSessionMessage).mockResolvedValueOnce({
      data: {
        data: {
          client_message_id: "client_1",
          duplicate: false,
          message_id: "message_1",
          run: {
            result: { text: "Session reply." },
            run_id: null,
            status: "completed",
          },
          session_id: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
          stream_url: "",
        },
      },
      error: undefined,
      response: new Response(null, { status: 202 }),
    } as never);

    const result = await runEmployeeMessage("dep_1", "hello", {
      conversationId: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
    });

    expect(result.text).toBe("Session reply.");
    expect(result.sessionId).toBe("0a5a4cb1-dade-467f-9f98-3a934ff25414");
    expect(serenCloudRun).not.toHaveBeenCalled();
    expect(serenCloudPostInteractiveSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {
          id: "dep_1",
          session_id: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
        },
        body: expect.objectContaining({ content: "hello" }),
      }),
    );
  });

  it("falls back to one-shot runs when the resolved cloud session is closed", async () => {
    vi.mocked(serenCloudGetInteractiveSession).mockResolvedValueOnce({
      data: {
        data: {
          messages: [],
          message_pagination: {
            count: 0,
            has_more: false,
            limit: 1,
            offset: 0,
            total: 0,
          },
          session: {
            closed_at: "2026-06-26T00:30:00Z",
            close_reason: "idle_timeout",
            created_at: "2026-06-26T00:00:00Z",
            deployment_id: "dep_1",
            idle_expires_at: futureIso(),
            organization_id: "org_1",
            session_id: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
            status: "closed",
            updated_at: "2026-06-26T00:30:00Z",
            user_id: "user_1",
            stream_url: "",
            ws_url: "",
          },
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    vi.mocked(serenCloudRun).mockResolvedValueOnce({
      data: {
        data: {
          result: { text: "Closed session fallback." },
          run_id: null,
          status: "completed",
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);

    const result = await runEmployeeMessage("dep_1", "hello", {
      conversationId: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
    });

    expect(result.text).toBe("Closed session fallback.");
    expect(serenCloudPostInteractiveSessionMessage).not.toHaveBeenCalled();
    expect(serenCloudRun).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          conversation_id: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
          message: "hello",
        }),
      }),
    );
  });

  it("falls back to one-shot runs when the resolved cloud session is idle-expired", async () => {
    vi.mocked(serenCloudGetInteractiveSession).mockResolvedValueOnce({
      data: {
        data: {
          messages: [],
          message_pagination: {
            count: 0,
            has_more: false,
            limit: 1,
            offset: 0,
            total: 0,
          },
          session: {
            closed_at: null,
            created_at: "2026-06-26T00:00:00Z",
            deployment_id: "dep_1",
            idle_expires_at: pastIso(),
            organization_id: "org_1",
            session_id: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
            status: "open",
            updated_at: "2026-06-26T00:30:00Z",
            user_id: "user_1",
            stream_url: "",
            ws_url: "",
          },
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    vi.mocked(serenCloudRun).mockResolvedValueOnce({
      data: {
        data: {
          result: { text: "Expired session fallback." },
          run_id: null,
          status: "completed",
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);

    const result = await runEmployeeMessage("dep_1", "hello", {
      conversationId: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
    });

    expect(result.text).toBe("Expired session fallback.");
    expect(serenCloudPostInteractiveSessionMessage).not.toHaveBeenCalled();
    expect(serenCloudRun).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          conversation_id: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
          message: "hello",
        }),
      }),
    );
  });

  it("does not fall back when cloud session resolution returns a transient error", async () => {
    vi.mocked(serenCloudGetInteractiveSession).mockResolvedValueOnce({
      data: undefined,
      error: { message: "backend unavailable" },
      response: new Response(null, { status: 503 }),
    } as never);

    await expect(
      runEmployeeMessage("dep_1", "hello", {
        conversationId: "0a5a4cb1-dade-467f-9f98-3a934ff25414",
      }),
    ).rejects.toThrow("backend unavailable");

    expect(serenCloudPostInteractiveSessionMessage).not.toHaveBeenCalled();
    expect(serenCloudRun).not.toHaveBeenCalled();
  });
});
