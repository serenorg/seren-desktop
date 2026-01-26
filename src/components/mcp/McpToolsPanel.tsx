// ABOUTME: Panel for discovering and executing MCP tools.
// ABOUTME: Shows available tools across all connected servers with execution UI.

import { createSignal, For, Show, type Component } from "solid-js";
import { mcpClient } from "@/lib/mcp/client";
import type { McpTool, McpToolResult } from "@/lib/mcp/types";
import "./McpToolsPanel.css";

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
  const [execution, setExecution] = createSignal<ToolExecutionState | null>(null);
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

      const schemaType = (propSchema as unknown as Record<string, unknown>).type;

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
        prev
          ? { ...prev, isRunning: false, result, error: null }
          : null
      );
    } catch (err) {
      setExecution((prev) =>
        prev
          ? {
              ...prev,
              isRunning: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : null
      );
    }
  }

  function formatResult(result: McpToolResult): string {
    return result.content
      .map((c) => {
        if (c.type === "text") {
          return (c as { type: "text"; text: string }).text;
        }
        return JSON.stringify(c, null, 2);
      })
      .join("\n");
  }

  return (
    <div class="mcp-tools-panel">
      <div class="tools-sidebar">
        <div class="sidebar-header">
          <h3>Available Tools</h3>
          <span class="tool-count">{tools().length}</span>
        </div>

        <Show
          when={tools().length > 0}
          fallback={
            <div class="empty-state">
              No tools available. Connect to an MCP server first.
            </div>
          }
        >
          <div class="tools-list">
            <For each={tools()}>
              {({ serverName, tool }) => {
                const isSelected = () => {
                  const sel = selectedTool();
                  return sel?.serverName === serverName && sel?.tool.name === tool.name;
                };

                return (
                  <button
                    class="tool-item"
                    classList={{ selected: isSelected() }}
                    onClick={() => selectTool(serverName, tool)}
                  >
                    <span class="tool-name">{tool.name}</span>
                    <span class="tool-server">{serverName}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <div class="tool-detail">
        <Show
          when={selectedTool()}
          fallback={
            <div class="no-selection">
              Select a tool from the list to view details and execute it.
            </div>
          }
        >
          {(sel) => (
            <>
              <div class="tool-header">
                <h2>{sel().tool.name}</h2>
                <span class="server-badge">{sel().serverName}</span>
              </div>

              <p class="tool-description">{sel().tool.description}</p>

              <div class="tool-args">
                <h4>Arguments</h4>
                <Show
                  when={getArgProperties(sel().tool).length > 0}
                  fallback={<p class="no-args">This tool takes no arguments.</p>}
                >
                  <For each={getArgProperties(sel().tool)}>
                    {(arg) => (
                      <div class="arg-field">
                        <label>
                          {arg.name}
                          {arg.required && <span class="required">*</span>}
                        </label>
                        <Show when={arg.schema.description}>
                          <span class="arg-description">
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
                          onInput={(e) => updateArg(arg.name, e.currentTarget.value)}
                        />
                      </div>
                    )}
                  </For>
                </Show>
              </div>

              <div class="tool-actions">
                <button
                  class="btn-execute"
                  onClick={executeTool}
                  disabled={execution()?.isRunning}
                >
                  {execution()?.isRunning ? "Executing..." : "Execute Tool"}
                </button>
              </div>

              <Show when={execution()}>
                {(exec) => (
                  <div class="execution-result">
                    <h4>Result</h4>
                    <Show when={exec().isRunning}>
                      <div class="loading">Executing tool...</div>
                    </Show>
                    <Show when={exec().error}>
                      <div class="error">{exec().error}</div>
                    </Show>
                    <Show when={exec().result}>
                      <div
                        class="result-content"
                        classList={{ "is-error": exec().result?.isError }}
                      >
                        <pre>{formatResult(exec().result!)}</pre>
                      </div>
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
