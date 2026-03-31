// ABOUTME: Tests for session type parsing and serialization.
// ABOUTME: Verifies parseRuntimeSession and parseSessionEvent handle all edge cases.

import { describe, expect, it } from "vitest";
import {
  parseRuntimeSession,
  parseSessionEvent,
  type RawRuntimeSession,
  type RawSessionEvent,
} from "@/types/session";

describe("parseRuntimeSession", () => {
  it("parses a complete session with context and policy", () => {
    const raw: RawRuntimeSession = {
      id: "sess-1",
      title: "Test Session",
      status: "running",
      environment: "browser",
      context: JSON.stringify({
        url: "https://example.com",
        page_title: "Example",
        active_tools: ["navigate", "click"],
      }),
      policy: JSON.stringify({
        auto_approve: ["navigate"],
        require_approval: ["click"],
        max_actions_per_minute: 10,
      }),
      thread_id: "thread-1",
      project_root: "/home/user/project",
      created_at: 1711900000000,
      updated_at: 1711900060000,
      resumed_at: 1711900030000,
    };

    const session = parseRuntimeSession(raw);

    expect(session.id).toBe("sess-1");
    expect(session.title).toBe("Test Session");
    expect(session.status).toBe("running");
    expect(session.environment).toBe("browser");
    expect(session.context).toEqual({
      url: "https://example.com",
      page_title: "Example",
      active_tools: ["navigate", "click"],
    });
    expect(session.policy).toEqual({
      auto_approve: ["navigate"],
      require_approval: ["click"],
      max_actions_per_minute: 10,
    });
    expect(session.thread_id).toBe("thread-1");
    expect(session.project_root).toBe("/home/user/project");
    expect(session.resumed_at).toBe(1711900030000);
  });

  it("parses a session with null context and policy", () => {
    const raw: RawRuntimeSession = {
      id: "sess-2",
      title: "Minimal Session",
      status: "idle",
      environment: "file",
      context: null,
      policy: null,
      thread_id: null,
      project_root: null,
      created_at: 1711900000000,
      updated_at: 1711900000000,
      resumed_at: null,
    };

    const session = parseRuntimeSession(raw);

    expect(session.context).toBeNull();
    expect(session.policy).toBeNull();
    expect(session.thread_id).toBeNull();
    expect(session.resumed_at).toBeNull();
  });

  it("handles invalid JSON in context gracefully", () => {
    const raw: RawRuntimeSession = {
      id: "sess-3",
      title: "Bad Context",
      status: "error",
      environment: "desktop",
      context: "not valid json{",
      policy: null,
      thread_id: null,
      project_root: null,
      created_at: 1711900000000,
      updated_at: 1711900000000,
      resumed_at: null,
    };

    const session = parseRuntimeSession(raw);

    expect(session.context).toBeNull();
    expect(session.status).toBe("error");
  });

  it("handles invalid JSON in policy gracefully", () => {
    const raw: RawRuntimeSession = {
      id: "sess-4",
      title: "Bad Policy",
      status: "idle",
      environment: "browser",
      context: null,
      policy: "{broken",
      thread_id: null,
      project_root: null,
      created_at: 1711900000000,
      updated_at: 1711900000000,
      resumed_at: null,
    };

    const session = parseRuntimeSession(raw);

    expect(session.policy).toBeNull();
  });

  it("preserves all session status values", () => {
    const statuses = [
      "idle",
      "running",
      "waiting_approval",
      "completed",
      "error",
      "paused",
    ] as const;

    for (const status of statuses) {
      const raw: RawRuntimeSession = {
        id: `sess-${status}`,
        title: status,
        status,
        environment: "browser",
        context: null,
        policy: null,
        thread_id: null,
        project_root: null,
        created_at: 1711900000000,
        updated_at: 1711900000000,
        resumed_at: null,
      };

      expect(parseRuntimeSession(raw).status).toBe(status);
    }
  });
});

describe("parseSessionEvent", () => {
  it("parses a complete event with metadata", () => {
    const raw: RawSessionEvent = {
      id: "evt-1",
      session_id: "sess-1",
      event_type: "navigation",
      title: "Navigated to Example",
      content: "Page loaded successfully",
      metadata: JSON.stringify({
        url: "https://example.com",
        duration_ms: 350,
      }),
      status: "completed",
      created_at: 1711900010000,
    };

    const event = parseSessionEvent(raw);

    expect(event.id).toBe("evt-1");
    expect(event.session_id).toBe("sess-1");
    expect(event.event_type).toBe("navigation");
    expect(event.title).toBe("Navigated to Example");
    expect(event.content).toBe("Page loaded successfully");
    expect(event.metadata).toEqual({
      url: "https://example.com",
      duration_ms: 350,
    });
    expect(event.status).toBe("completed");
  });

  it("parses an approval event with pending status", () => {
    const raw: RawSessionEvent = {
      id: "evt-2",
      session_id: "sess-1",
      event_type: "approval",
      title: "Click button",
      content: null,
      metadata: JSON.stringify({
        tool_name: "click",
        approval_id: "approval-123",
      }),
      status: "pending",
      created_at: 1711900020000,
    };

    const event = parseSessionEvent(raw);

    expect(event.event_type).toBe("approval");
    expect(event.status).toBe("pending");
    expect(event.metadata?.tool_name).toBe("click");
    expect(event.metadata?.approval_id).toBe("approval-123");
    expect(event.content).toBeNull();
  });

  it("parses an error event", () => {
    const raw: RawSessionEvent = {
      id: "evt-3",
      session_id: "sess-1",
      event_type: "error",
      title: "Navigation failed",
      content: null,
      metadata: JSON.stringify({
        error_message: "Page not found",
        url: "https://example.com/404",
      }),
      status: "error",
      created_at: 1711900030000,
    };

    const event = parseSessionEvent(raw);

    expect(event.event_type).toBe("error");
    expect(event.status).toBe("error");
    expect(event.metadata?.error_message).toBe("Page not found");
  });

  it("handles null metadata", () => {
    const raw: RawSessionEvent = {
      id: "evt-4",
      session_id: "sess-1",
      event_type: "status_change",
      title: "Session started",
      content: null,
      metadata: null,
      status: "completed",
      created_at: 1711900040000,
    };

    const event = parseSessionEvent(raw);

    expect(event.metadata).toBeNull();
  });

  it("handles invalid metadata JSON gracefully", () => {
    const raw: RawSessionEvent = {
      id: "evt-5",
      session_id: "sess-1",
      event_type: "action",
      title: "Some action",
      content: null,
      metadata: "broken{json",
      status: "completed",
      created_at: 1711900050000,
    };

    const event = parseSessionEvent(raw);

    expect(event.metadata).toBeNull();
    expect(event.title).toBe("Some action");
  });

  it("preserves all event types", () => {
    const types = [
      "navigation",
      "action",
      "screenshot",
      "approval",
      "content",
      "command",
      "error",
      "status_change",
    ] as const;

    for (const eventType of types) {
      const raw: RawSessionEvent = {
        id: `evt-${eventType}`,
        session_id: "sess-1",
        event_type: eventType,
        title: eventType,
        content: null,
        metadata: null,
        status: "completed",
        created_at: 1711900000000,
      };

      expect(parseSessionEvent(raw).event_type).toBe(eventType);
    }
  });
});
