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

  const getRiskBadgeClasses = () => {
    const level = riskLevel();
    const base =
      "mt-1 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full w-fit before:content-[''] before:w-1.5 before:h-1.5 before:rounded-full";
    if (level === "low")
      return `${base} bg-[rgba(34,197,94,0.15)] text-[#15803d] before:bg-[#22c55e]`;
    if (level === "medium")
      return `${base} bg-[rgba(251,191,36,0.2)] text-[#b45309] before:bg-[#f59e0b]`;
    return `${base} bg-[rgba(248,113,113,0.2)] text-[#b91c1c] before:bg-[#ef4444]`;
  };

  return (
    <div class="bg-popover border border-[rgba(148,163,184,0.25)] rounded-lg px-4 py-3 my-2">
      <div class="flex items-center gap-2.5 mb-3">
        <span class="text-xl">🔧</span>
        <div class="flex-1 flex flex-col gap-0.5">
          <span class="text-[11px] uppercase tracking-[0.5px] text-muted-foreground">
            Tool Call Request
          </span>
          <span class="text-sm font-semibold font-mono">
            {props.request.call.name}
          </span>
          <div class={getRiskBadgeClasses()}>{getRiskLabel(riskLevel())}</div>
        </div>
        <span class="px-2.5 py-1 bg-[#dbeafe] text-accent rounded-md text-[11px] font-medium">
          {props.request.serverName}
        </span>
      </div>

      <Show when={argEntries().length > 0}>
        <div class="mb-3">
          <span class="block text-[11px] uppercase tracking-[0.5px] text-muted-foreground mb-1.5">
            Arguments:
          </span>
          <div class="bg-card border border-[rgba(148,163,184,0.25)] rounded-md px-3 py-2">
            <For each={argEntries()}>
              {([key, value]) => (
                <div class="flex gap-2 py-1 text-[13px] font-mono border-b border-[rgba(148,163,184,0.25)] last:border-b-0">
                  <span class="text-accent font-medium">{key}:</span>
                  <span class="text-foreground break-all">
                    {formatArgValue(value)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={requiresTypeConfirmation()}>
        <div class="my-3 flex flex-col gap-1.5">
          <label class="text-[13px]">
            Type <strong>{props.request.call.name}</strong> to confirm high-risk
            execution
          </label>
          <input
            value={confirmationInput()}
            onInput={(e) => setConfirmationInput(e.currentTarget.value)}
            placeholder={props.request.call.name}
            class="p-2 border border-[rgba(148,163,184,0.25)] rounded-md font-mono bg-card text-foreground"
          />
        </div>
      </Show>

      <div class="text-xs text-muted-foreground mt-2">
        Attempt {Math.min(Math.max(attemptCount(), 1), maxAttempts())} /{" "}
        {maxAttempts()}
      </div>

      <Show when={isPendingRetry()}>
        <div class="mt-1 text-xs text-accent">Retrying automatically...</div>
      </Show>

      <div class="flex items-center gap-2 mt-3">
        <button
          class="flex-1 px-4 py-2 bg-[#22c55e] text-white border-none rounded-md text-[13px] font-medium cursor-pointer transition-colors duration-150 hover:not-disabled:bg-[#16a34a] disabled:opacity-60 disabled:cursor-not-allowed"
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
          <button
            class="px-3 py-2 border border-[rgba(148,163,184,0.25)] rounded-md bg-popover text-muted-foreground text-xs font-medium cursor-pointer hover:bg-[#fee2e2] hover:border-[#f87171] hover:text-[#b91c1c]"
            onClick={handleCancel}
          >
            Cancel
          </button>
        </Show>
        <button
          class="px-4 py-2 bg-popover text-foreground border border-[rgba(148,163,184,0.25)] rounded-md text-[13px] font-medium cursor-pointer transition-colors duration-150 hover:not-disabled:bg-[rgba(239,68,68,0.1)] hover:not-disabled:border-[#dc2626] hover:not-disabled:text-[#dc2626] disabled:opacity-60 disabled:cursor-not-allowed"
          onClick={handleDeny}
          disabled={isExecuting()}
        >
          Deny
        </button>
      </div>

      <Show when={error()}>
        <div class="flex items-start gap-2 px-3 py-2.5 bg-[rgba(239,68,68,0.1)] rounded-md mt-3">
          <span class="shrink-0">❌</span>
          <span class="text-[13px] text-[#dc2626]">{error()}</span>
        </div>
        <div class="mt-2 flex items-center gap-3">
          <Show when={wasCancelled()}>
            <span class="text-xs text-muted-foreground">
              Call cancelled by user.
            </span>
          </Show>
          <Show when={!wasCancelled() && attemptCount() < maxAttempts()}>
            <button
              class="px-3 py-1.5 text-xs rounded-md border border-accent bg-transparent text-accent cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={handleManualRetry}
              disabled={isExecuting()}
            >
              Retry ({attemptCount()} / {maxAttempts()})
            </button>
          </Show>
        </div>
      </Show>

      <Show when={result()}>
        {(toolResult) => (
          <div
            class={`flex items-start gap-2 px-3 py-2.5 rounded-md mt-3 ${
              toolResult().isError ? "bg-[#fef9c3]" : "bg-[#dcfce7]"
            }`}
          >
            <span class="shrink-0">{toolResult().isError ? "⚠️" : "✅"}</span>
            <div class="flex-1 overflow-auto">
              <pre class="m-0 text-xs font-mono whitespace-pre-wrap break-words">
                {formatResult(toolResult())}
              </pre>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};

export default McpToolCallApproval;
