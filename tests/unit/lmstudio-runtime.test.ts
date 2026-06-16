// ABOUTME: Critical guards for the LM Studio local-agent runtime (#2444).
// ABOUTME: Pins URL handling, OpenAI tool-call normalization, and MCP credential separation.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";
// @ts-ignore - browser-local runtime is plain ESM.
import * as lmStudioRuntime from "../../bin/browser-local/lmstudio-runtime.mjs";

const {
  buildLmsExecInvocation,
  isLoopbackLmStudioBaseUrl,
  isToolIncompatibilityError,
  lmStudioHttpBaseUrl,
  lmStudioWsBaseUrl,
  normalizeLmStudioBaseUrl,
  normalizeOpenAiToolName,
  normalizeToolCalls,
} = lmStudioRuntime as {
  buildLmsExecInvocation: (
    command: string,
    args: string[],
    platform?: NodeJS.Platform,
  ) => { command: string; args: string[] };
  isLoopbackLmStudioBaseUrl: (value: string) => boolean;
  isToolIncompatibilityError: (message: unknown) => boolean;
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
      "mcpGateway: createMcpGatewayClient({ apiKey: serenApiKey })",
    );
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
    expect(runtimeSource).toContain("session.toolsDisabled = true");
    expect(runtimeSource).toContain("runChatCompletion");
  });
});
