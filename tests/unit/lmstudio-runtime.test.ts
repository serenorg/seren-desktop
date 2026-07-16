// ABOUTME: Critical guards for the LM Studio local-agent runtime (#2444).
// ABOUTME: Pins URL handling, OpenAI tool-call normalization, and MCP credential separation.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";
// @ts-ignore - browser-local runtime is plain ESM.
import * as lmStudioRuntime from "../../bin/browser-local/lmstudio-runtime.mjs";

const {
  buildLmStudioChatCompletionBodyForContextBudget,
  buildLmStudioPromptForContextBudget,
  buildLmsExecInvocation,
  isLmStudioContextOverflowError,
  isLmStudioModelToolIncompatible,
  isLoopbackLmStudioBaseUrl,
  isToolIncompatibilityError,
  lmStudioHttpBaseUrl,
  lmStudioWsBaseUrl,
  markLmStudioModelToolIncompatible,
  normalizeLmStudioBaseUrl,
  normalizeOpenAiToolName,
  normalizeToolCalls,
  prepareLmStudioMessagesForContextBudget,
  reasoningTextFromDelta,
} = lmStudioRuntime as {
  buildLmStudioChatCompletionBodyForContextBudget: (args: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    tools?: Array<Record<string, unknown>>;
    contextLength: number;
    useTools?: boolean;
    options?: { aggressive?: boolean };
  }) => {
    body: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      max_tokens: number;
      tools?: Array<Record<string, unknown>>;
      tool_choice?: string;
    };
    messages: Array<{ role: string; content: string }>;
    droppedMessages: number;
    droppedTools: number;
    estimatedInputTokens: number;
    maxTokens: number;
  };
  buildLmStudioPromptForContextBudget: (
    prompt: string,
    context: Array<Record<string, string>> | undefined,
    contextLength: number,
    options?: { aggressive?: boolean },
  ) => { prompt: string; trimmed: boolean; estimatedTokens: number };
  buildLmsExecInvocation: (
    command: string,
    args: string[],
    platform?: NodeJS.Platform,
  ) => { command: string; args: string[] };
  isLmStudioContextOverflowError: (message: unknown) => boolean;
  isLmStudioModelToolIncompatible: (
    session: {
      currentModelId?: string;
      toolIncompatibleModelIds?: Set<string>;
    },
    modelId?: string,
  ) => boolean;
  isLoopbackLmStudioBaseUrl: (value: string) => boolean;
  isToolIncompatibilityError: (message: unknown) => boolean;
  markLmStudioModelToolIncompatible: (
    session: {
      currentModelId?: string;
      toolIncompatibleModelIds?: Set<string>;
    },
    modelId?: string,
  ) => void;
  reasoningTextFromDelta: (delta: unknown) => string;
  lmStudioHttpBaseUrl: (value: string) => string;
  lmStudioWsBaseUrl: (value: string) => string;
  normalizeLmStudioBaseUrl: (value: string) => string;
  normalizeOpenAiToolName: (value: string) => string;
  normalizeToolCalls: (
    accumulator: Map<
      number,
      { id: string; function: { name: string; arguments: string } }
    >,
  ) => Array<{ function: { name: string } }>;
  prepareLmStudioMessagesForContextBudget: (
    messages: Array<{ role: string; content: string }>,
    contextLength: number,
    options?: { aggressive?: boolean },
  ) => {
    messages: Array<{ role: string; content: string }>;
    droppedMessages: number;
    estimatedTokens: number;
  };
};

describe("LM Studio runtime helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeLmStudioBaseUrl(" http://localhost:1234/// ")).toBe(
      "http://localhost:1234",
    );
    expect(lmStudioWsBaseUrl("http://localhost:1234")).toBe(
      "ws://localhost:1234",
    );
    expect(lmStudioHttpBaseUrl("wss://example.test:1234")).toBe(
      "https://example.test:1234",
    );
  });

  it("detects localhost URLs for lifecycle controls", () => {
    expect(isLoopbackLmStudioBaseUrl("http://localhost:1234")).toBe(true);
    expect(isLoopbackLmStudioBaseUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLoopbackLmStudioBaseUrl("http://192.168.1.20:1234")).toBe(false);
  });

  it("maps MCP names into OpenAI function names", () => {
    expect(normalizeOpenAiToolName("gateway/gmail.get-messages")).toBe(
      "gateway_gmail_get-messages",
    );
    expect(normalizeOpenAiToolName("")).toBe("tool");
  });

  it("returns completed tool calls in stream-index order", () => {
    const calls = normalizeToolCalls(
      new Map([
        [
          1,
          {
            id: "call_b",
            function: { name: "write_file", arguments: "{\"path\":\"b\"}" },
          },
        ],
        [
          0,
          {
            id: "call_a",
            function: { name: "read_file", arguments: "{\"path\":\"a\"}" },
          },
        ],
      ]),
    );
    expect(calls.map((call) => call.function.name)).toEqual([
      "read_file",
      "write_file",
    ]);
  });

  it("extracts reasoning-model thinking from streaming deltas", () => {
    // Qwen3.5 / DeepSeek-R1 emit `reasoning_content`; some builds use `reasoning`.
    expect(reasoningTextFromDelta({ reasoning_content: "thinking" })).toBe(
      "thinking",
    );
    expect(reasoningTextFromDelta({ reasoning: "thinking" })).toBe("thinking");
    // Non-reasoning deltas (plain content) yield no thinking text.
    expect(reasoningTextFromDelta({ content: "hello" })).toBe("");
    expect(reasoningTextFromDelta({})).toBe("");
    expect(reasoningTextFromDelta(null)).toBe("");
  });

  it("detects tool-incompatibility failures and ignores unrelated errors", () => {
    // The obliterated-Gemma signature reproduced live against LM Studio.
    expect(
      isToolIncompatibilityError(
        'Error rendering prompt with jinja template: "Cannot call something that is not a function: got UndefinedValue".',
      ),
    ).toBe(true);
    expect(isToolIncompatibilityError("This model does not support tools")).toBe(
      true,
    );
    expect(isToolIncompatibilityError("Invalid tool_choice value")).toBe(true);
    // Unrelated failures must NOT trigger a silent no-tools degrade.
    expect(isToolIncompatibilityError("Context length exceeded")).toBe(false);
    expect(isToolIncompatibilityError("Model is still loading")).toBe(false);
    expect(isToolIncompatibilityError("")).toBe(false);
    expect(isToolIncompatibilityError(null)).toBe(false);
  });

  it("detects LM Studio context overflow without treating it as tool incompatibility", () => {
    const error =
      "The number of tokens to keep from the initial prompt is greater than the context length.";
    expect(isLmStudioContextOverflowError(error)).toBe(true);
    expect(isToolIncompatibilityError(error)).toBe(false);
  });

  it("trims oversized prompt context while preserving the current prompt tail", () => {
    const bounded = buildLmStudioPromptForContextBudget(
      "Answer the current request. KEEP_CURRENT_PROMPT_TAIL",
      [{ type: "text", text: `old context ${"x".repeat(40_000)}` }],
      4096,
    );

    expect(bounded.trimmed).toBe(true);
    expect(bounded.prompt).toContain("trimmed older LM Studio context");
    expect(bounded.prompt).toContain("KEEP_CURRENT_PROMPT_TAIL");
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(4096);
  });

  it("drops old LM Studio history at user boundaries when the loaded context is full", () => {
    const prepared = prepareLmStudioMessagesForContextBudget(
      [
        { role: "user", content: `first ${"a".repeat(20_000)}` },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "latest request" },
      ],
      4096,
    );

    expect(prepared.droppedMessages).toBe(2);
    expect(prepared.messages).toEqual([
      { role: "user", content: "latest request" },
    ]);
  });

  it("builds LM Studio request bodies with a bounded completion budget", () => {
    const prepared = buildLmStudioChatCompletionBodyForContextBudget({
      model: "gemma-4-e4b",
      messages: [
        { role: "user", content: `first ${"a".repeat(20_000)}` },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "latest request" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
      ],
      contextLength: 4096,
      useTools: true,
    });

    expect(prepared.droppedMessages).toBe(2);
    expect(prepared.body.messages).toEqual([
      { role: "user", content: "latest request" },
    ]);
    expect(prepared.body.tools).toHaveLength(1);
    expect(prepared.body.tool_choice).toBe("auto");
    expect(prepared.body.max_tokens).toBeGreaterThan(0);
    expect(prepared.body.max_tokens).toBeLessThanOrEqual(1024);
    expect(prepared.estimatedInputTokens + prepared.maxTokens).toBeLessThanOrEqual(
      Math.floor(4096 * 0.94),
    );
  });

  it("omits oversized LM Studio tool schemas when they would exhaust local context", () => {
    const prepared = buildLmStudioChatCompletionBodyForContextBudget({
      model: "gemma-4-e4b",
      messages: [{ role: "user", content: "Hello world?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "huge_gateway_tool",
            description: "x".repeat(40_000),
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      contextLength: 4096,
      useTools: true,
    });

    expect(prepared.droppedTools).toBe(1);
    expect(prepared.body.tools).toBeUndefined();
    expect(prepared.body.tool_choice).toBeUndefined();
    expect(prepared.body.max_tokens).toBeGreaterThan(0);
  });

  it("scopes tool incompatibility to the selected LM Studio model", () => {
    const session = {
      currentModelId: "gemma-4-12b-obliterated",
      toolIncompatibleModelIds: new Set<string>(),
    };

    expect(isLmStudioModelToolIncompatible(session)).toBe(false);
    markLmStudioModelToolIncompatible(session);
    expect(isLmStudioModelToolIncompatible(session)).toBe(true);

    session.currentModelId = "qwen/qwen3.5-9b";
    expect(isLmStudioModelToolIncompatible(session)).toBe(false);
    markLmStudioModelToolIncompatible(session);
    expect(isLmStudioModelToolIncompatible(session)).toBe(true);

    session.currentModelId = "mistral/tool-capable";
    markLmStudioModelToolIncompatible(session, "gemma-4-12b-obliterated");
    expect(isLmStudioModelToolIncompatible(session)).toBe(false);

    session.currentModelId = "gemma-4-12b-obliterated";
    expect(
      isLmStudioModelToolIncompatible(session, "gemma-4-12b-obliterated"),
    ).toBe(true);
  });

  it("runs Windows lms command shims through cmd.exe", () => {
    expect(
      buildLmsExecInvocation("C:\\Users\\me\\.lmstudio\\bin\\lms.cmd", [
        "--version",
      ], "win32"),
    ).toEqual({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "C:\\Users\\me\\.lmstudio\\bin\\lms.cmd",
        "--version",
      ],
    });
    expect(buildLmsExecInvocation("lms", ["server", "start"], "win32")).toEqual(
      {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "lms", "server", "start"],
      },
    );
    expect(
      buildLmsExecInvocation("C:\\Program Files\\LM Studio\\lms.exe", [
        "--version",
      ], "win32"),
    ).toEqual({
      command: "C:\\Program Files\\LM Studio\\lms.exe",
      args: ["--version"],
    });
  });
});

describe("LM Studio runtime wiring", () => {
  const runtimeSource = readSource("bin/browser-local/lmstudio-runtime.mjs");
  const providersSource = readSource("bin/browser-local/providers.mjs");

  it("keeps LM Studio server auth separate from Seren MCP gateway auth", () => {
    expect(runtimeSource).toContain("const lmStudioApiKey");
    expect(runtimeSource).toContain("const serenApiKey");
    expect(runtimeSource).toContain(
      "mcpGateway: createMcpGatewayClient({",
    );
    expect(runtimeSource).toContain("apiKey: serenApiKey");
    expect(runtimeSource).toContain("url: serenMcpProxy?.url");
  });

  it("is wired into the provider dispatcher", () => {
    expect(providersSource).toContain("createLmStudioRuntime");
    expect(providersSource).toContain('agentType === "lmstudio"');
    const fallbacks = providersSource.match(/lmStudioRuntime\.hasSession/g) ?? [];
    expect(fallbacks.length).toBeGreaterThanOrEqual(5);
  });

  it("surfaces streamed error frames and degrades tools instead of replying empty", () => {
    // Streamed `event: error` frames must throw, not be swallowed into an empty
    // completion; tool-incompatible models must drop tools and retry.
    expect(runtimeSource).toContain("throwIfErrorPayload");
    expect(runtimeSource).toContain(
      "markLmStudioModelToolIncompatible(session, requestModelId)",
    );
    expect(runtimeSource).toContain(
      "const requestModelId = session.currentModelId",
    );
    expect(runtimeSource).toContain("toolIncompatibleModelIds: new Set()");
    expect(runtimeSource).toContain("runChatCompletion");
  });

  it("surfaces reasoning-model thinking as thought chunks", () => {
    expect(runtimeSource).toContain("reasoningTextFromDelta");
    expect(runtimeSource).toContain("isThought: true");
  });
});
