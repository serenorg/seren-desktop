// ABOUTME: Panel for discovering and executing MCP tools.
// ABOUTME: Shows available tools across all connected servers with execution UI.

import { type Component, createSignal, For, Show } from "solid-js";
import { formatToolResultText } from "@/lib/format-tool-result";
import { mcpClient } from "@/lib/mcp/client";
import type { McpTool, McpToolResult } from "@/lib/mcp/types";

interface ToolExecutionState {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  isRunning: boolean;
  result: McpToolResult | null;
  error: string | null;
}

export const McpToolsPanel: Component = () => {
  const [selectedTool, setSelectedTool] = createSignal<{
    serverName: string;
    tool: McpTool;
  } | null>(null);
  const [execution, setExecution] = createSignal<ToolExecutionState | null>(
    null,
  );
  const [argInputs, setArgInputs] = createSignal<Record<string, string>>({});

  const tools = () => mcpClient.getAllTools();

  function selectTool(serverName: string, tool: McpTool): void {
    setSelectedTool({ serverName, tool });
    setArgInputs({});
    setExecution(null);
  }

  function getArgProperties(tool: McpTool): Array<{
    name: string;
    schema: Record<string, unknown>;
    required: boolean;
  }> {
    const props = tool.inputSchema.properties || {};
    const required = new Set(tool.inputSchema.required || []);

    return Object.entries(props).map(([name, schema]) => ({
      name,
      schema: schema as unknown as Record<string, unknown>,
      required: required.has(name),
    }));
  }

  function updateArg(name: string, value: string): void {
    setArgInputs((prev) => ({ ...prev, [name]: value }));
  }

  async function executeTool(): Promise<void> {
    const sel = selectedTool();
    if (!sel) return;

    const { serverName, tool } = sel;
    const args: Record<string, unknown> = {};

    // Parse argument values
    for (const [key, value] of Object.entries(argInputs())) {
      const propSchema = tool.inputSchema.properties[key];
      if (!propSchema) continue;

      const schemaType = (propSchema as unknown as Record<string, unknown>)
        .type;

      if (schemaType === "number") {
        args[key] = parseFloat(value) || 0;
      } else if (schemaType === "boolean") {
        args[key] = value === "true";
      } else if (schemaType === "array" || schemaType === "object") {
        try {
          args[key] = JSON.parse(value);
        } catch {
          args[key] = value;
        }
      } else {
        args[key] = value;
      }
    }

    setExecution({
      serverName,
      toolName: tool.name,
      args,
      isRunning: true,
      result: null,
      error: null,
    });

    try {
      const result = await mcpClient.callTool(serverName, {
        name: tool.name,
        arguments: args,
      });

      setExecution((prev) =>
        prev ? { ...prev, isRunning: false, result, error: null } : null,
      );
    } catch (err) {
      setExecution((prev) =>
        prev
          ? {
              ...prev,
              isRunning: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : null,
      );
    }
  }

  function formatResult(result: McpToolResult): string {
    return result.content
      .map((c) => {
        if (c.type === "text") {
          return formatToolResultText(
            (c as { type: "text"; text: string }).text,
          );
        }
        return JSON.stringify(c, null, 2);
      })
      .join("\n");
  }

  return (
    <div class="flex h-full bg-card">
      <div class="w-[280px] border-r border-border-strong flex flex-col bg-popover">
        <div class="p-4 border-b border-border-strong flex justify-between items-center">
          <h3 class="m-0 text-sm font-semibold">Available Tools</h3>
          <span class="px-2 py-0.5 bg-accent text-white rounded-xl text-xs font-medium">
            {tools().length}
          </span>
        </div>

        <Show
          when={tools().length > 0}
          fallback={
            <div class="flex items-center justify-center h-full text-muted-foreground text-sm text-center p-6">
              No tools available. Connect to an MCP server first.
            </div>
          }
        >
          <div class="flex-1 overflow-y-auto p-2">
            <For each={tools()}>
              {({ serverName, tool }) => {
                const isSelected = () => {
                  const sel = selectedTool();
                  return (
                    sel?.serverName === serverName &&
                    sel?.tool.name === tool.name
                  );
                };

                return (
                  <button
                    class={`w-full px-3 py-2.5 bg-transparent border-none rounded-md text-left cursor-pointer flex flex-col gap-0.5 transition-colors duration-150 ${
                      isSelected()
                        ? "bg-accent text-white"
                        : "hover:bg-border-medium"
                    }`}
                    onClick={() => selectTool(serverName, tool)}
                  >
                    <span class="text-[13px] font-medium">{tool.name}</span>
                    <span
                      class={`text-[11px] ${isSelected() ? "opacity-85" : "opacity-70"}`}
                    >
                      {serverName}
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <div class="flex-1 p-6 overflow-y-auto">
        <Show
          when={selectedTool()}
          fallback={
            <div class="flex items-center justify-center h-full text-muted-foreground text-sm text-center p-6">
              Select a tool from the list to view details and execute it.
            </div>
          }
        >
          {(sel) => (
            <>
              <div class="flex items-center gap-3 mb-3">
                <h2 class="m-0 text-xl font-semibold">{sel().tool.name}</h2>
                <span class="px-2.5 py-1 bg-popover rounded-md text-xs text-muted-foreground">
                  {sel().serverName}
                </span>
              </div>

              <p class="text-muted-foreground mb-6 leading-normal">
                {sel().tool.description}
              </p>

              <div class="mb-6">
                <h4 class="m-0 mb-3 text-sm font-semibold">Arguments</h4>
                <Show
                  when={getArgProperties(sel().tool).length > 0}
                  fallback={
                    <p class="text-muted-foreground text-[13px]">
                      This tool takes no arguments.
                    </p>
                  }
                >
                  <For each={getArgProperties(sel().tool)}>
                    {(arg) => (
                      <div class="mb-4">
                        <label class="block text-[13px] font-medium mb-1">
                          {arg.name}
                          {arg.required && (
                            <span class="text-destructive/85 ml-0.5">*</span>
                          )}
                        </label>
                        <Show when={arg.schema.description}>
                          <span class="block text-xs text-muted-foreground mb-1.5">
                            {arg.schema.description as string}
                          </span>
                        </Show>
                        <input
                          type="text"
                          placeholder={`${arg.schema.type || "string"}${
                            arg.schema.default !== undefined
                              ? ` (default: ${arg.schema.default})`
                              : ""
                          }`}
                          value={argInputs()[arg.name] || ""}
                          onInput={(e) =>
                            updateArg(arg.name, e.currentTarget.value)
                          }
                          class="w-full px-3 py-2 border border-border-strong rounded-md text-sm font-mono bg-card text-foreground focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
                        />
                      </div>
                    )}
                  </For>
                </Show>
              </div>

              <div class="mb-6">
                <button
                  class="px-5 py-2.5 bg-accent text-white border-none rounded-md text-sm font-medium cursor-pointer transition-colors duration-150 hover:not-disabled:bg-primary/85 disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={executeTool}
                  disabled={execution()?.isRunning}
                >
                  {execution()?.isRunning ? "Executing..." : "Execute Tool"}
                </button>
              </div>

              <Show when={execution()}>
                {(exec) => (
                  <div class="border-t border-border-strong pt-6">
                    <h4 class="m-0 mb-3 text-sm font-semibold">Result</h4>
                    <Show when={exec().isRunning}>
                      <div class="text-muted-foreground text-[13px]">
                        Executing tool...
                      </div>
                    </Show>
                    <Show when={exec().error}>
                      <div class="p-3 bg-destructive/10 text-destructive/85 rounded-md text-[13px]">
                        {exec().error}
                      </div>
                    </Show>
                    <Show when={exec().result}>
                      {(toolResult) => (
                        <div
                          class={`p-4 rounded-lg overflow-x-auto ${
                            toolResult().isError
                              ? "bg-destructive/10"
                              : "bg-popover"
                          }`}
                        >
                          <pre class="m-0 text-[13px] font-mono whitespace-pre-wrap break-words">
                            {formatResult(toolResult())}
                          </pre>
                        </div>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
};

export default McpToolsPanel;
