import { describe, expect, it, vi } from "vitest";
import {
  createEmployeeRunManager,
  employeeErrorTextFromCode,
  employeeCapabilityGuidanceForError,
  employeeErrorCodeFromConversationMessage,
  employeeToolGroupSummaries,
  employeeTextFromConversationMessage,
  errorTextFromOutputEvents,
  type EmployeeOutputEventEnvelope,
  type EmployeeRunEventLike,
  type EmployeeRuntimeApi,
  runLiveStateLabel,
  sanitizeEmployeeErrorText,
} from "@seren/employees-core";

function runEvent(
  status: string,
  outputEvents?: EmployeeOutputEventEnvelope[],
  options: {
    output?: string | null;
    statusMessage?: string | null;
  } = {},
): EmployeeRunEventLike {
  return {
    id: "run_1",
    deployment_id: "dep_1",
    invocation_payload: {},
    ...(outputEvents ? { output_events: outputEvents } : {}),
    output: options.output ?? null,
    run_name: null,
    started_at: "2026-06-27T00:00:00Z",
    completed_at: status === "completed" ? "2026-06-27T00:00:01Z" : null,
    updated_at: "2026-06-27T00:00:01Z",
    status,
    status_message: options.statusMessage ?? null,
  };
}

// Sequenced-stream frames: a `run.event` carries one durable envelope; control
// frames (`end`, `timeout`, `error`, `replay_complete`) steer the loop.
function ev(envelope: EmployeeOutputEventEnvelope): {
  event: string;
  data: unknown;
} {
  return { event: "run.event", data: envelope };
}

function control(
  event: string,
  data: unknown = {},
): { event: string; data: unknown } {
  return { event, data };
}

async function* streamOf(frames: unknown[]): AsyncGenerator<unknown> {
  for (const frame of frames) {
    yield frame;
  }
}

function runtimeApi(frames: unknown[], terminal: EmployeeRunEventLike) {
  const getRun = vi.fn(async () => terminal);
  const api: EmployeeRuntimeApi = {
    createRun: vi.fn(async () => ({
      run_id: "run_1",
      status: "running",
    })),
    getRun,
    streamRun: vi.fn(async () => streamOf(frames)),
    cancelRun: vi.fn(async () => {}),
  };
  return { api, getRun };
}

describe("employees-core sequenced run stream", () => {
  it("selects assistant conversation text from typed events before raw content", () => {
    const text = employeeTextFromConversationMessage({
      role: "assistant",
      content: JSON.stringify({
        iterations: 1,
        output_events: [{ type: "text", text: "raw envelope text" }],
        response: "raw envelope response",
        workflow: { status: "completed" },
      }),
      events: [{ type: "text", text: "Rendered assistant text." }],
      run_summary: {
        status: "completed",
      },
    });

    expect(text).toBe("Rendered assistant text.");
  });

  it("selects assistant error event text for failed conversation messages", () => {
    const text = employeeTextFromConversationMessage({
      role: "assistant",
      content: JSON.stringify({
        partial_response: JSON.stringify({ data: { publishers: [] } }),
        workflow: { status: "failed" },
      }),
      events: [
        {
          type: "text",
          text: JSON.stringify({ data: { publishers: [] } }),
        },
        {
          type: "error",
          message: "The employee hit an error while responding.",
        },
      ],
      run_summary: {
        status: "failed",
      },
    });

    expect(text).toBe("The employee hit an error while responding.");
  });

  it("sanitizes nested model-provider tool response errors for display", () => {
    const rawError =
      'LLM error: LLM publisher returned 400: Provider returned error - {"error":{"code":400,"message":"Provider returned error","metadata":{"previous_errors":[{"provider_name":"OpenAI","raw":"{\\n \\"error\\": {\\n \\"message\\": \\"No tool call found for function call output with call_id call_123.\\",\\n \\"type\\": \\"invalid_request_error\\"\\n }\\n}"}],"provider_name":"Azure"}}}';

    expect(sanitizeEmployeeErrorText(rawError)).toBe(
      "The configured model route could not process the tool response. Change this employee to a tool-capable model route in employee settings.",
    );

    expect(
      employeeTextFromConversationMessage({
        role: "assistant",
        events: [{ type: "error", message: rawError }],
        run_summary: {
          status: "failed",
        },
      }),
    ).toBe(
      "The configured model route could not process the tool response. Change this employee to a tool-capable model route in employee settings.",
    );
  });

  it("prefers structured run error codes over raw messages", () => {
    expect(employeeErrorTextFromCode("model_tool_response_rejected")).toBe(
      "The configured model route could not process the tool response. Change this employee to a tool-capable model route in employee settings.",
    );

    expect(
      employeeTextFromConversationMessage({
        role: "assistant",
        events: [
          {
            type: "error",
            code: "tool_missing_credential",
            message:
              "Raw provider payload should not be needed when a code exists.",
          },
        ],
        run_summary: {
          status: "failed",
        },
      }),
    ).toBe(
      "This employee needs a connected account or credential before it can use the required tool. Update employee settings.",
    );
  });

  it("extracts structured run error codes for capability guidance", () => {
    const message = {
      role: "assistant",
      events: [
        {
          type: "error",
          code: "tool_not_configured",
          message: "raw message",
        },
      ],
      run_summary: {
        status: "failed",
      },
    } as const;

    expect(employeeErrorCodeFromConversationMessage(message)).toBe(
      "tool_not_configured",
    );
    expect(
      employeeCapabilityGuidanceForError("tool_not_configured", {
        toolPresets: [],
        resolvedTools: [],
      }),
    ).toBe(
      "No tool groups are enabled for this employee. Enable Live data for web research, Publisher actions for connected tools, or SerenDB queries for database access.",
    );
  });

  it("summarizes employee tool groups for compact capability panels", () => {
    expect(
      employeeToolGroupSummaries([
        {
          id: "live_data",
          label: "Live data",
          description: "Read external data.",
          tool_count: 4,
          tool_names: [
            "seren_publishers_suggest",
            "seren_publishers_get",
            "seren_mcp_read_resource",
            "seren_mcp_list_tools",
          ],
          side_effecting: false,
          approval_type: "none",
        },
        {
          id: "publisher_actions",
          label: "Publisher actions",
          description: "Call connected tools.",
          tool_count: 1,
          tool_names: ["seren_publisher_request"],
          side_effecting: true,
          approval_type: "required",
        },
      ]),
    ).toEqual([
      {
        id: "live_data",
        label: "Live data",
        description: "Read external data.",
        toolCount: 4,
        toolPreview:
          "publishers suggest, publishers get, mcp read resource + 1 more",
        modeLabel: "Read-only",
        approvalLabel: "No approval",
        tone: "success",
      },
      {
        id: "publisher_actions",
        label: "Publisher actions",
        description: "Call connected tools.",
        toolCount: 1,
        toolPreview: "publisher request",
        modeLabel: "Action-capable",
        approvalLabel: "Approval required",
        tone: "warning",
      },
    ]);
  });

  it("renders a count when a tool group reports a count without names", () => {
    const [summary] = employeeToolGroupSummaries([
      {
        id: "custom",
        preset: null,
        label: "Custom group",
        description: "A curated set.",
        tool_count: 5,
        tool_names: null,
        side_effecting: false,
        approval_type: null,
      },
    ]);
    expect(summary?.toolCount).toBe(5);
    expect(summary?.toolPreview).toBe("5 tools");
    expect(summary?.approvalLabel).toBe("No approval");
  });

  it("sanitizes unknown provider details and redacts fallback identifiers", () => {
    expect(
      sanitizeEmployeeErrorText(
        "Azure OpenAI: DeploymentNotFound for resource my-resource-eastus",
      ),
    ).toBe(
      "The employee could not complete this request because the model provider rejected it.",
    );

    expect(
      sanitizeEmployeeErrorText(
        "Provider rejected key=seren_EZbR5XkovK_15PIo10ZioJo0omYawxGcSFlRls1bvhSdas4jpSA",
      ),
    ).toBe("Provider rejected [secret]");
  });

  it("falls back to sanitized text for unknown error codes", () => {
    expect(
      errorTextFromOutputEvents([
        {
          type: "error",
          code: "unknown",
          message: "Approval was denied.",
        },
      ]),
    ).toBe("Approval was denied.");
  });

  it("keeps ordinary human-readable failure messages", () => {
    expect(sanitizeEmployeeErrorText("Approval was denied.")).toBe(
      "Approval was denied.",
    );
  });

  it("explains missing tool configuration separately from provider failures", () => {
    expect(
      sanitizeEmployeeErrorText(
        "Error: seren client unavailable for publisher request tool",
      ),
    ).toBe(
      "The required tool is not enabled for this employee. Enable live data or publisher tools in employee settings.",
    );
  });

  it("explains missing publisher permissions separately from provider failures", () => {
    expect(
      sanitizeEmployeeErrorText(
        "publisher operation is not allowed by allowed_publisher_operations",
      ),
    ).toBe(
      "This employee is not allowed to use that publisher operation. Update tool permissions in employee settings.",
    );
  });

  it("keeps normal text event precedence for non-failed conversation messages", () => {
    const text = employeeTextFromConversationMessage({
      role: "assistant",
      content: "Stored fallback.",
      events: [
        {
          type: "text",
          text: "Normal assistant text.",
        },
        {
          type: "error",
          message: "Non-terminal warning.",
        },
      ],
      run_summary: {
        status: "completed",
      },
    });

    expect(text).toBe("Normal assistant text.");
    expect(
      errorTextFromOutputEvents([
        { type: "error", message: "First error." },
        { type: "error", message: "Second error." },
      ]),
    ).toBe("First error.\nSecond error.");
  });

  it("applies sequenced event envelopes and resolves terminal via one poll", async () => {
    const firstText: EmployeeOutputEventEnvelope = {
      type: "text",
      text: "Hello ",
      sequence_number: 1,
    };
    const thinking: EmployeeOutputEventEnvelope = {
      type: "thinking",
      text: "checking",
      sequence_number: 2,
    };
    const secondText: EmployeeOutputEventEnvelope = {
      type: "text",
      text: "world",
      sequence_number: 3,
    };
    const { api, getRun } = runtimeApi(
      [ev(firstText), ev(thinking), ev(secondText), control("end")],
      // The terminal poll returns the cumulative row; reconciliation must not
      // re-emit text already streamed.
      runEvent("completed", [firstText, thinking, secondText]),
    );
    const onText = vi.fn();
    const onThinking = vi.fn();

    const result = await createEmployeeRunManager(api).runEmployeeMessage(
      "dep_1",
      "hello",
      { onText, onThinking },
    );

    expect(result.text).toBe("Hello world");
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("checking");
    expect(onText.mock.calls.map(([chunk]) => chunk)).toEqual([
      "Hello ",
      "world",
    ]);
    expect(onThinking).toHaveBeenCalledWith("checking");
    // Exactly one authoritative terminal poll after the stream ends.
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("emits ordered tool updates and dedupes against the terminal poll", async () => {
    const started: EmployeeOutputEventEnvelope = {
      type: "tool_call",
      id: "tool_1",
      name: "search",
      arguments: '{"q":"status"}',
      status: "running",
      sequence_number: 1,
    };
    const completed: EmployeeOutputEventEnvelope = {
      type: "tool_call",
      id: "tool_1",
      name: "search",
      arguments: '{"q":"status"}',
      status: "completed",
      sequence_number: 2,
    };
    const resultEvent: EmployeeOutputEventEnvelope = {
      type: "tool_result",
      id: "tool_1",
      content: "done",
      is_error: false,
      sequence_number: 3,
    };
    const { api } = runtimeApi(
      [ev(started), ev(completed), ev(resultEvent), control("end")],
      // Cumulative terminal row replays the same tool events; content-based
      // dedupe must collapse them.
      runEvent("completed", [started, completed, resultEvent]),
    );
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    await createEmployeeRunManager(api).runEmployeeMessage("dep_1", "hello", {
      onToolCall,
      onToolResult,
    });

    expect(onToolCall.mock.calls.map(([event]) => event.status)).toEqual([
      "running",
      "completed",
    ]);
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it("ignores replay_complete and applies events on either side of it", async () => {
    const t = (
      text: string,
      seq: number,
    ): EmployeeOutputEventEnvelope => ({ type: "text", text, sequence_number: seq });
    const { api } = runtimeApi(
      [
        ev(t("a", 1)),
        control("replay_complete", { last_sequence: 1, status: "running" }),
        ev(t("b", 2)),
        control("end"),
      ],
      runEvent("completed", [t("a", 1), t("b", 2)]),
    );
    const onText = vi.fn();

    const result = await createEmployeeRunManager(api).runEmployeeMessage(
      "dep_1",
      "hi",
      { onText },
    );

    expect(result.text).toBe("ab");
    expect(onText.mock.calls.map(([chunk]) => chunk)).toEqual(["a", "b"]);
  });

  it("emits run.state frames through the live-state callback", async () => {
    const stateFrame = {
      checkpoint_id: null,
      current_step: "Using tool",
      current_tool: "search",
      deployment_id: "dep_1",
      latest_event_kind: "tool_call",
      latest_sequence: 7,
      pending_approval_count: 0,
      phase: "running",
      run_id: "run_1",
      started_at: "2026-06-27T00:00:00Z",
      status: "running",
      status_message: null,
      terminal: false,
      updated_at: "2026-06-27T00:00:01Z",
    };
    const { api } = runtimeApi(
      [
        control("run.state", stateFrame),
        ev({ type: "text", text: "done", sequence_number: 8 }),
        control("end"),
      ],
      runEvent("completed", [
        { type: "text", text: "done", sequence_number: 8 },
      ]),
    );
    const onRunState = vi.fn();
    const onText = vi.fn();

    const result = await createEmployeeRunManager(api).runEmployeeMessage(
      "dep_1",
      "hi",
      { onRunState, onText },
    );

    expect(result.text).toBe("done");
    expect(onRunState).toHaveBeenCalledWith(stateFrame);
    expect(runLiveStateLabel(onRunState.mock.calls[0][0])).toBe("Using search");
    expect(onText).toHaveBeenCalledWith("done");
  });

  it("stops on an error control frame and surfaces its message", async () => {
    const { api } = runtimeApi(
      [
        ev({ type: "text", text: "partial", sequence_number: 1 }),
        control("error", { error: "stream boom" }),
      ],
      runEvent("failed", undefined, { statusMessage: "runtime failed" }),
    );

    await expect(
      createEmployeeRunManager(api).runEmployeeMessage("dep_1", "hello"),
    ).rejects.toThrow("stream boom");
  });

  it("rejects with the terminal status message from the poll on failure", async () => {
    const { api, getRun } = runtimeApi(
      [
        ev({ type: "text", text: "partial", sequence_number: 1 }),
        control("end", { status: "failed", last_sequence: 1 }),
      ],
      runEvent("failed", undefined, {
        output: "partial stdout",
        statusMessage: "runtime failed",
      }),
    );

    await expect(
      createEmployeeRunManager(api).runEmployeeMessage("dep_1", "hello"),
    ).rejects.toThrow("runtime failed");
    expect(getRun).toHaveBeenCalled();
  });

  it("falls back to polling when the stream stalls without a control frame", async () => {
    async function* stalls(): AsyncGenerator<unknown> {
      yield ev({ type: "text", text: "partial", sequence_number: 1 });
      await new Promise<void>(() => {}); // never resolves -> stalled stream
    }
    const getRun = vi.fn(async () =>
      runEvent("completed", undefined, { output: "final" }),
    );
    const api: EmployeeRuntimeApi = {
      createRun: vi.fn(async () => ({ run_id: "run_1", status: "running" })),
      getRun,
      streamRun: vi.fn(async () => stalls()),
      cancelRun: vi.fn(async () => {}),
    };

    const result = await createEmployeeRunManager(api, {
      streamIdleTimeoutMs: 25,
      pollIntervalMs: 5,
    }).runEmployeeMessage("dep_1", "hi", {});

    expect(getRun).toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.text).toBe("final");
  });

  it("falls back to polling when the stream closes without a control frame", async () => {
    const { api, getRun } = runtimeApi(
      [ev({ type: "text", text: "partial", sequence_number: 1 })],
      runEvent("completed", undefined, { output: "final" }),
    );

    const result = await createEmployeeRunManager(api).runEmployeeMessage(
      "dep_1",
      "hi",
    );

    expect(getRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("final");
  });

  it("does not append divergent terminal snapshots as text chunks", async () => {
    const { api } = runtimeApi(
      [
        ev({ type: "text", text: "partial", sequence_number: 1 }),
        control("end"),
      ],
      runEvent("completed", undefined, { output: "final" }),
    );
    const onText = vi.fn();

    const result = await createEmployeeRunManager(api).runEmployeeMessage(
      "dep_1",
      "hi",
      { onText },
    );

    expect(result.text).toBe("final");
    expect(onText.mock.calls.map(([chunk]) => chunk)).toEqual(["partial"]);
  });

  it("dedupes repeated text and thinking events by sequence number", async () => {
    const text: EmployeeOutputEventEnvelope = {
      type: "text",
      text: "same",
      sequence_number: 1,
    };
    const thinking: EmployeeOutputEventEnvelope = {
      type: "thinking",
      text: "plan",
      sequence_number: 2,
    };
    const { api } = runtimeApi(
      [ev(text), ev(text), ev(thinking), ev(thinking), control("end")],
      runEvent("completed", [text, thinking]),
    );
    const onText = vi.fn();
    const onThinking = vi.fn();

    const result = await createEmployeeRunManager(api).runEmployeeMessage(
      "dep_1",
      "hi",
      { onText, onThinking },
    );

    expect(result.text).toBe("same");
    expect(result.thinking).toBe("plan");
    expect(onText.mock.calls.map(([chunk]) => chunk)).toEqual(["same"]);
    expect(onThinking.mock.calls.map(([chunk]) => chunk)).toEqual(["plan"]);
  });

  it("dedupes repeated unsequenced text and thinking events by content", async () => {
    const text: EmployeeOutputEventEnvelope = {
      type: "text",
      text: "same",
    };
    const thinking: EmployeeOutputEventEnvelope = {
      type: "thinking",
      text: "plan",
    };
    const { api } = runtimeApi(
      [ev(text), ev(text), ev(thinking), ev(thinking), control("end")],
      runEvent("completed", [text, thinking]),
    );
    const onText = vi.fn();
    const onThinking = vi.fn();

    const result = await createEmployeeRunManager(api).runEmployeeMessage(
      "dep_1",
      "hi",
      { onText, onThinking },
    );

    expect(result.text).toBe("same");
    expect(result.thinking).toBe("plan");
    expect(onText.mock.calls.map(([chunk]) => chunk)).toEqual(["same"]);
    expect(onThinking.mock.calls.map(([chunk]) => chunk)).toEqual(["plan"]);
  });
});
