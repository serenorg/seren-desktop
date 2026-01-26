// ABOUTME: Component for approving/denying MCP tool calls requested by AI.
// ABOUTME: Shows tool details, arguments, and allows user to confirm execution.

import {
  type Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { isRecoverableError } from "@/lib/mcp";
import { mcpClient } from "@/lib/mcp/client";
import { getRiskLabel, getToolRiskLevel } from "@/lib/mcp/risk";
import type { McpToolResult } from "@/lib/mcp/types";
import type { ToolCallRequest } from "@/stores/mcp-chat.store";
import "./McpToolCallApproval.css";

export interface McpToolCallApprovalProps {
  request: ToolCallRequest;
  onApprove: (id: string, result: McpToolResult) => void;
  onDeny: (id: string) => void;
  onCancel?: (id: string) => void;
  maxRetryAttempts?: number;
}

export const McpToolCallApproval: Component<McpToolCallApprovalProps> = (
  props,
) => {
  const [isExecuting, setIsExecuting] = createSignal(false);
  const [isPendingRetry, setIsPendingRetry] = createSignal(false);
  const [result, setResult] = createSignal<McpToolResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [attemptCount, setAttemptCount] = createSignal(0);
  const [confirmationInput, setConfirmationInput] = createSignal("");
  const [wasCancelled, setWasCancelled] = createSignal(false);
  const maxAttempts = () => props.maxRetryAttempts ?? 3;
  const riskLevel = () => getToolRiskLevel(props.request.call.name);
  const isHighRisk = () => riskLevel() === "high";
  const isMediumRisk = () => riskLevel() === "medium";
  const requiresTypeConfirmation = () => isHighRisk();

  const INITIAL_RETRY_DELAY = 1000;
  let currentAbortController: AbortController | null = null;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;

  createEffect(() => {
    void props.request.id;
    setAttemptCount(0);
    setResult(null);
    setError(null);
    setConfirmationInput("");
    setIsPendingRetry(false);
    setWasCancelled(false);
    currentAbortController?.abort();
    currentAbortController = null;
  });

  onCleanup(() => {
    currentAbortController?.abort();
    if (retryTimeout) {
      clearTimeout(retryTimeout);
    }
  });

  async function handleApprove(): Promise<void> {
    if (isExecuting()) return;

    if (isMediumRisk()) {
      const confirmed = window.confirm(
        `Approve ${props.request.call.name} on ${props.request.serverName}?`,
      );
      if (!confirmed) {
        return;
      }
    }

    if (requiresTypeConfirmation()) {
      const expected = props.request.call.name.toLowerCase();
      if (confirmationInput().trim().toLowerCase() !== expected) {
        setError(`Type ${props.request.call.name} to confirm.`);
        return;
      }
    }

    await executeWithRetry();
  }

  function handleDeny(): void {
    props.onDeny(props.request.id);
  }

  function handleCancel(): void {
    if (!isExecuting()) return;
    currentAbortController?.abort();
    setWasCancelled(true);
  }

  async function executeWithRetry(manualRetry = false): Promise<void> {
    let attempt = manualRetry ? attemptCount() : 0;
    let delay = INITIAL_RETRY_DELAY;

    while (attempt < maxAttempts()) {
      attempt += 1;
      setAttemptCount(attempt);
      setIsExecuting(true);
      setIsPendingRetry(false);
      setError(null);
      setResult(null);
      setWasCancelled(false);

      const controller = new AbortController();
      currentAbortController = controller;

      try {
        const execResult = await mcpClient.callTool(
          props.request.serverName,
          props.request.call,
          { signal: controller.signal },
        );
        setResult(execResult);
        props.onApprove(props.request.id, execResult);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setWasCancelled(true);
          setError("Tool call cancelled.");
          props.onCancel?.(props.request.id);
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        setError(message);

        if (!isRecoverableError(err) || attempt >= maxAttempts()) {
          setIsPendingRetry(false);
          return;
        }

        setIsPendingRetry(true);
        await waitWithAbort(delay, controller.signal);
        setIsPendingRetry(false);
        delay *= 2;
      } finally {
        setIsExecuting(false);
        currentAbortController = null;
      }
    }
  }

  async function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new DOMException("Operation aborted", "AbortError");
    }

    await new Promise<void>((resolve, reject) => {
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        if (retryTimeout) {
          clearTimeout(retryTimeout);
          retryTimeout = null;
        }
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Operation aborted", "AbortError"));
      };

      signal.addEventListener("abort", onAbort);
    });
  }

  async function handleManualRetry(): Promise<void> {
    await executeWithRetry(true);
  }

  function formatArgValue(value: unknown): string {
    if (typeof value === "string") return `"${value}"`;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    return JSON.stringify(value);
  }

  function formatResult(res: McpToolResult): string {
    return res.content
      .map((c) => {
        if (c.type === "text") {
          return (c as { type: "text"; text: string }).text;
        }
        return JSON.stringify(c, null, 2);
      })
      .join("\n");
  }

  const argEntries = () => Object.entries(props.request.call.arguments);

  return (
    <div class="mcp-tool-call-approval">
      <div class="approval-header">
        <span class="icon">🔧</span>
        <div class="header-content">
          <span class="title">Tool Call Request</span>
          <span class="tool-name">{props.request.call.name}</span>
          <div class={`risk-badge risk-${riskLevel()}`}>
            {getRiskLabel(riskLevel())}
          </div>
        </div>
        <span class="server-badge">{props.request.serverName}</span>
      </div>

      <Show when={argEntries().length > 0}>
        <div class="arguments">
          <span class="section-label">Arguments:</span>
          <div class="arg-list">
            <For each={argEntries()}>
              {([key, value]) => (
                <div class="arg-item">
                  <span class="arg-key">{key}:</span>
                  <span class="arg-value">{formatArgValue(value)}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={requiresTypeConfirmation()}>
        <div class="confirmation-block">
          <label>
            Type <strong>{props.request.call.name}</strong> to confirm high-risk
            execution
          </label>
          <input
            value={confirmationInput()}
            onInput={(e) => setConfirmationInput(e.currentTarget.value)}
            placeholder={props.request.call.name}
          />
        </div>
      </Show>

      <div class="attempt-meta">
        Attempt {Math.min(Math.max(attemptCount(), 1), maxAttempts())} /{" "}
        {maxAttempts()}
      </div>

      <Show when={isPendingRetry()}>
        <div class="pending-retry">Retrying automatically...</div>
      </Show>

      <div class="approval-actions">
        <button
          class="btn-approve"
          onClick={handleApprove}
          disabled={
            isExecuting() ||
            (requiresTypeConfirmation() &&
              confirmationInput().trim().toLowerCase() !==
                props.request.call.name.toLowerCase())
          }
        >
          {isExecuting() ? "Executing..." : "Approve & Execute"}
        </button>
        <Show when={isExecuting()}>
          <button class="btn-cancel" onClick={handleCancel}>
            Cancel
          </button>
        </Show>
        <button class="btn-deny" onClick={handleDeny} disabled={isExecuting()}>
          Deny
        </button>
      </div>

      <Show when={error()}>
        <div class="execution-error">
          <span class="error-icon">❌</span>
          <span class="error-message">{error()}</span>
        </div>
        <div class="retry-actions">
          <Show when={wasCancelled()}>
            <span class="cancelled-note">Call cancelled by user.</span>
          </Show>
          <Show when={!wasCancelled() && attemptCount() < maxAttempts()}>
            <button
              class="btn-retry"
              onClick={handleManualRetry}
              disabled={isExecuting()}
            >
              Retry ({attemptCount()} / {maxAttempts()})
            </button>
          </Show>
        </div>
      </Show>

      <Show when={result()}>
        <div
          class="execution-result"
          classList={{ "is-error": result()?.isError }}
        >
          <span class="result-icon">{result()?.isError ? "⚠️" : "✅"}</span>
          <div class="result-content">
            <pre>{formatResult(result()!)}</pre>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default McpToolCallApproval;
