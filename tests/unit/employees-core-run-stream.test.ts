import { describe, expect, it, vi } from "vitest";
import {
  createEmployeeRunManager,
  type EmployeeOutputEventEnvelope,
  type EmployeeRunEventLike,
  type EmployeeRuntimeApi,
  runLiveStateLabel,
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
