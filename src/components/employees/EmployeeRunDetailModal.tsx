// ABOUTME: Detail modal for a single employee run.
// ABOUTME: Shows status, cost, tokens, output, structured events, and artifacts.

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import type {
  EmployeeRunApprovalDecision,
  EmployeeRunArtifact,
  EmployeeRunDetail,
  EmployeeRunPendingApprovals,
} from "@/lib/employees/types";
import { employees as svc } from "@/services/employees";

interface EmployeeRunDetailModalProps {
  deploymentId: string;
  runId: string;
  onClose: () => void;
}

const FAILURE_STATUSES = new Set([
  "failed",
  "cancelled",
  "canceled",
  "timeout",
  "blocked",
  "error",
]);

function statusPillClass(status: string): string {
  if (status === "completed")
    return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (status === "running" || status === "queued")
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  if (status === "awaiting_approval")
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (FAILURE_STATUSES.has(status))
    return "bg-red-500/15 text-red-400 border-red-500/30";
  return "bg-slate-500/15 text-slate-300 border-slate-500/30";
}

function statusLabel(status: string): string {
  if (status === "completed") return "Completed";
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  if (status === "awaiting_approval") return "Awaiting approval";
  if (status === "failed") return "Failed";
  if (status === "cancelled" || status === "canceled") return "Cancelled";
  if (status === "timeout") return "Timed out";
  if (status === "blocked") return "Blocked";
  if (status === "error") return "Error";
  return status;
}

function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  return `${min}m ${remSec}s`;
}

const InfoRow: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <div class="flex items-baseline gap-3">
    <div class="w-32 shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
      {props.label}
    </div>
    <div class="text-[12.5px] text-foreground min-w-0 break-words font-mono">
      {props.children}
    </div>
  </div>
);

interface EnvelopeShape {
  type?: string;
  text?: string;
  message?: string;
  name?: string;
  arguments?: string;
  content?: string;
  is_error?: boolean;
  reason?: string;
  tool?: string;
  state?: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function eventLine(raw: unknown): { kind: string; text: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const ev = raw as EnvelopeShape;
  if (ev.type === "text" && typeof ev.text === "string") {
    return { kind: "text", text: truncate(ev.text, 200) };
  }
  if (ev.type === "thinking" && typeof ev.text === "string") {
    return { kind: "thinking", text: truncate(ev.text, 200) };
  }
  if (ev.type === "tool_call") {
    const args = ev.arguments ?? "";
    return {
      kind: "tool_call",
      text: `${ev.name ?? "tool"}(${truncate(args, 80)})`,
    };
  }
  if (ev.type === "tool_result") {
    const content = ev.content ?? "";
    return {
      kind: ev.is_error ? "tool_error" : "tool_result",
      text: truncate(content, 200),
    };
  }
  if (ev.type === "tool_audit") {
    return {
      kind: "tool_audit",
      text: `${ev.tool ?? "tool"}: ${ev.reason ?? ""}`,
    };
  }
  if (ev.type === "workflow") {
    return { kind: "workflow", text: ev.state ?? "" };
  }
  if (ev.type === "error" && typeof ev.message === "string") {
    return { kind: "error", text: ev.message };
  }
  return null;
}

// Kinds where the visual style already conveys the event class, so the
// inline kind tag is just noise.
const HIDDEN_KIND_TAGS = new Set(["text", "thinking"]);

function hasInvocationPayload(payload: unknown): boolean {
  if (payload === null || payload === undefined) return false;
  if (typeof payload === "string") return payload.length > 0;
  if (typeof payload === "object") {
    return Object.keys(payload as Record<string, unknown>).length > 0;
  }
  return true;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function eventKindClass(kind: string): string {
  if (kind === "thinking") return "text-muted-foreground italic";
  if (kind === "tool_call") return "text-sky-400";
  if (kind === "tool_result") return "text-emerald-400";
  if (kind === "tool_error" || kind === "error") return "text-red-400";
  if (kind === "tool_audit") return "text-amber-300";
  if (kind === "workflow") return "text-muted-foreground";
  return "text-foreground";
}

export const EmployeeRunDetailModal: Component<EmployeeRunDetailModalProps> = (
  props,
) => {
  // Derived string sources: createResource compares source values with
  // Object.is. Object-literal sources return a fresh reference on every memo
  // re-evaluation, so an unrelated upstream invalidation (the sidebar's 30s
  // employee poll, which can cascade down to props through summary()) would
  // refetch and visibly churn the modal. Strings stay stable when inputs do.
  const runKey = () => `${props.deploymentId}::${props.runId}`;

  const [run, { refetch: refetchRun }] = createResource(runKey, async (key) => {
    const idx = key.indexOf("::");
    return svc.getRun(key.slice(0, idx), key.slice(idx + 2));
  });
  const [artifacts] = createResource(
    runKey,
    async (key): Promise<EmployeeRunArtifact[]> => {
      const idx = key.indexOf("::");
      return svc.listRunArtifacts(key.slice(0, idx), key.slice(idx + 2));
    },
  );
  const [approvals, { refetch: refetchApprovals }] = createResource(
    () => {
      const r = run();
      if (!r || r.status !== "awaiting_approval") return null;
      return runKey();
    },
    async (key): Promise<EmployeeRunPendingApprovals | null> => {
      if (!key) return null;
      const idx = key.indexOf("::");
      return svc.listPendingApprovals(key.slice(0, idx), key.slice(idx + 2));
    },
  );

  const [decisions, setDecisions] = createStore<
    Record<string, EmployeeRunApprovalDecision>
  >({});
  const [resumeError, setResumeError] = createSignal<string | null>(null);
  const [resuming, setResuming] = createSignal(false);

  let closeButtonRef: HTMLButtonElement | undefined;
  let interval: ReturnType<typeof setInterval> | null = null;

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    props.onClose();
  };

  // Refresh while the run is non-terminal so the modal stays live for
  // an in-progress run opened from the list. Skip when the document is
  // hidden so a backgrounded window doesn't poll.
  const tickRefresh = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const r = run();
    if (!r) return;
    if (FAILURE_STATUSES.has(r.status) || r.status === "completed") {
      return;
    }
    void refetchRun();
    if (r.status === "awaiting_approval") {
      void refetchApprovals();
    }
  };

  const setDecision = (id: string, decision: EmployeeRunApprovalDecision) => {
    setResumeError(null);
    setDecisions(id, decision);
  };

  const setAllDecisions = (decision: EmployeeRunApprovalDecision) => {
    setResumeError(null);
    const list = approvals();
    if (!list) return;
    for (const item of list.approvals) {
      setDecisions(item.id, decision);
    }
  };

  const decidedCount = createMemo(() => {
    const list = approvals();
    if (!list) return 0;
    let n = 0;
    for (const item of list.approvals) {
      if (decisions[item.id]) n++;
    }
    return n;
  });

  const handleResume = async () => {
    const list = approvals();
    if (!list?.checkpointId) {
      setResumeError("Missing checkpoint id; refresh and try again.");
      return;
    }
    if (list.approvals.length === 0) {
      setResumeError("No pending approvals to resume.");
      return;
    }
    if (decidedCount() < list.approvals.length) {
      setResumeError("Decide on every pending approval before resuming.");
      return;
    }
    setResuming(true);
    setResumeError(null);
    try {
      await svc.resumeRun(props.deploymentId, {
        checkpointId: list.checkpointId,
        decisions: list.approvals.map((a) => ({
          id: a.id,
          decision: decisions[a.id] ?? "reject",
        })),
      });
      const refreshed = await refetchRun();
      if (refreshed?.status === "awaiting_approval") {
        await refetchApprovals();
      } else {
        setDecisions({});
      }
    } catch (e) {
      setResumeError(e instanceof Error ? e.message : String(e));
    } finally {
      setResuming(false);
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleDocumentKeydown);
    requestAnimationFrame(() => closeButtonRef?.focus());
    interval = setInterval(tickRefresh, 3000);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleDocumentKeydown);
    if (interval !== null) clearInterval(interval);
  });

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) props.onClose();
  };

  const eventLines = createMemo<{ kind: string; text: string }[]>(() => {
    const events = run()?.outputEvents;
    if (!Array.isArray(events)) return [];
    const lines: { kind: string; text: string }[] = [];
    for (const ev of events) {
      const line = eventLine(ev);
      if (line) lines.push(line);
    }
    return lines;
  });

  const copyRunId = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(props.runId);
    } catch {
      // ignore
    }
  };

  return (
    <div
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="employee-run-detail-title"
    >
      <div class="bg-popover border border-border rounded-lg w-[720px] max-w-[94vw] max-h-[90vh] overflow-hidden flex flex-col shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border">
          <h2
            id="employee-run-detail-title"
            class="m-0 text-base font-semibold text-foreground"
          >
            Run detail
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            class="bg-transparent border-none text-muted-foreground cursor-pointer p-1 rounded transition-all duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            onClick={props.onClose}
            title="Close"
            aria-label="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-5 py-4">
          <Show when={run.error}>
            <div
              class="mb-4 py-2.5 px-3 bg-destructive/20 text-destructive rounded text-[13px]"
              role="alert"
            >
              {run.error instanceof Error
                ? run.error.message
                : String(run.error)}
            </div>
          </Show>
          <Show
            when={run()}
            fallback={
              <div class="text-[13px] text-muted-foreground italic py-8 text-center">
                Loading run...
              </div>
            }
          >
            {(detail) => {
              const r = (): EmployeeRunDetail => detail();
              return (
                <div class="flex flex-col gap-5">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span
                      class={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] font-medium ${statusPillClass(r().status)}`}
                    >
                      {statusLabel(r().status)}
                    </span>
                    <Show when={r().runName}>
                      <span class="text-[13px] font-semibold text-foreground">
                        {r().runName}
                      </span>
                    </Show>
                    <span class="text-[11.5px] text-muted-foreground">
                      {r().source}
                    </span>
                    <span
                      class="text-[11.5px] text-muted-foreground ml-auto"
                      title={new Date(r().startedAt).toLocaleString()}
                    >
                      {new Date(r().startedAt).toLocaleString()}
                    </span>
                  </div>

                  <Show when={r().statusMessage}>
                    <div
                      class="py-2 px-3 bg-destructive/15 text-destructive rounded text-[12.5px]"
                      role="alert"
                    >
                      {r().statusMessage}
                    </div>
                  </Show>

                  <div class="grid grid-cols-2 gap-x-6 gap-y-2 py-3 border-y border-border">
                    <InfoRow label="Run id">{r().id}</InfoRow>
                    <InfoRow label="Backend">{r().computeBackend}</InfoRow>
                    <InfoRow label="Duration">
                      {durationLabel(r().executionTimeMs)}
                    </InfoRow>
                    <InfoRow label="Billed">
                      {durationLabel(r().billedDurationMs)}
                    </InfoRow>
                    <InfoRow label="Tokens in">
                      {r().inferenceInputTokens.toLocaleString()}
                    </InfoRow>
                    <InfoRow label="Tokens out">
                      {r().inferenceOutputTokens.toLocaleString()}
                    </InfoRow>
                    <InfoRow label="Inference">${r().inferenceCostUsd}</InfoRow>
                    <InfoRow label="Compute">${r().computeCostUsd}</InfoRow>
                    <Show when={r().conversationId}>
                      <InfoRow label="Conversation">
                        {r().conversationId ?? ""}
                      </InfoRow>
                    </Show>
                    <Show when={r().sessionId}>
                      <InfoRow label="Session">{r().sessionId ?? ""}</InfoRow>
                    </Show>
                  </div>

                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="text-[11.5px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                      onClick={copyRunId}
                      aria-label="Copy run id"
                    >
                      Copy run id
                    </button>
                    <button
                      type="button"
                      class="text-[11.5px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:opacity-50"
                      onClick={() => void refetchRun()}
                      disabled={run.loading}
                    >
                      {run.loading ? "Refreshing..." : "Refresh"}
                    </button>
                  </div>

                  <Show when={r().status === "awaiting_approval"}>
                    <section
                      class="flex flex-col gap-3 border border-amber-500/30 bg-amber-500/5 rounded p-3"
                      aria-labelledby="employee-run-approvals-heading"
                      aria-busy={resuming()}
                    >
                      <div class="flex items-center justify-between gap-2">
                        <h3
                          id="employee-run-approvals-heading"
                          class="m-0 text-[12px] font-semibold text-amber-300"
                        >
                          Pending approvals
                        </h3>
                        <Show when={(approvals()?.approvals.length ?? 0) > 0}>
                          <div class="flex items-center gap-1.5">
                            <button
                              type="button"
                              class="text-[11px] px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/60"
                              onClick={() => setAllDecisions("approve")}
                              disabled={resuming()}
                            >
                              Approve all
                            </button>
                            <button
                              type="button"
                              class="text-[11px] px-2 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/60"
                              onClick={() => setAllDecisions("reject")}
                              disabled={resuming()}
                            >
                              Reject all
                            </button>
                          </div>
                        </Show>
                      </div>

                      <Show when={approvals.error}>
                        <div class="text-[12px] text-destructive" role="alert">
                          {approvals.error instanceof Error
                            ? approvals.error.message
                            : String(approvals.error)}
                        </div>
                      </Show>

                      <Show
                        when={!approvals.loading}
                        fallback={
                          <div class="text-[12px] text-muted-foreground italic">
                            Loading approvals...
                          </div>
                        }
                      >
                        <Show
                          when={(approvals()?.approvals.length ?? 0) > 0}
                          fallback={
                            <Show when={!approvals.error}>
                              <div class="text-[12px] text-muted-foreground italic">
                                No pending approvals reported. Try refreshing.
                              </div>
                            </Show>
                          }
                        >
                          <ul class="m-0 p-0 list-none flex flex-col gap-2">
                            <For each={approvals()?.approvals ?? []}>
                              {(item) => (
                                <li class="flex flex-col gap-1.5 border border-border/60 rounded p-2.5 bg-background/40">
                                  <div class="flex items-center gap-2 flex-wrap">
                                    <span class="text-[12.5px] font-mono font-semibold text-foreground">
                                      {item.tool}
                                    </span>
                                    <Show when={item.functionCallId}>
                                      <span
                                        class="text-[10.5px] font-mono text-muted-foreground/70 truncate"
                                        title={item.functionCallId ?? ""}
                                      >
                                        {item.functionCallId}
                                      </span>
                                    </Show>
                                    <div class="ml-auto flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        class={`text-[11px] px-2 py-0.5 rounded border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/60 ${
                                          decisions[item.id] === "approve"
                                            ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-200"
                                            : "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                                        }`}
                                        onClick={() =>
                                          setDecision(item.id, "approve")
                                        }
                                        disabled={resuming()}
                                        aria-pressed={
                                          decisions[item.id] === "approve"
                                        }
                                      >
                                        Approve
                                      </button>
                                      <button
                                        type="button"
                                        class={`text-[11px] px-2 py-0.5 rounded border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/60 ${
                                          decisions[item.id] === "reject"
                                            ? "bg-red-500/20 border-red-500/60 text-red-200"
                                            : "border-red-500/30 text-red-300 hover:bg-red-500/10"
                                        }`}
                                        onClick={() =>
                                          setDecision(item.id, "reject")
                                        }
                                        disabled={resuming()}
                                        aria-pressed={
                                          decisions[item.id] === "reject"
                                        }
                                      >
                                        Reject
                                      </button>
                                    </div>
                                  </div>
                                  <Show when={item.reason}>
                                    <div class="text-[11.5px] text-muted-foreground">
                                      {item.reason}
                                    </div>
                                  </Show>
                                  <Show
                                    when={
                                      item.args !== null &&
                                      item.args !== undefined
                                    }
                                  >
                                    <pre class="m-0 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-snug text-foreground/85 bg-background/60 border border-border/60 rounded p-2">
                                      {prettyJson(item.args)}
                                    </pre>
                                  </Show>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </Show>

                      <Show when={resumeError()}>
                        <div class="text-[12px] text-destructive" role="alert">
                          {resumeError()}
                        </div>
                      </Show>

                      <div class="flex items-center justify-between gap-2">
                        <span class="text-[11.5px] text-muted-foreground">
                          {decidedCount()} of{" "}
                          {approvals()?.approvals.length ?? 0} decided
                        </span>
                        <button
                          type="button"
                          class="text-[12px] px-3 py-1 rounded border border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60 disabled:opacity-50 disabled:cursor-not-allowed"
                          onClick={handleResume}
                          disabled={
                            resuming() ||
                            (approvals()?.approvals.length ?? 0) === 0 ||
                            decidedCount() <
                              (approvals()?.approvals.length ?? 0) ||
                            !approvals()?.checkpointId
                          }
                        >
                          {resuming() ? "Resuming..." : "Resume run"}
                        </button>
                      </div>
                    </section>
                  </Show>

                  <Show when={hasInvocationPayload(r().invocationPayload)}>
                    <details class="group">
                      <summary class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2 cursor-pointer hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 rounded">
                        Invocation payload
                      </summary>
                      <pre class="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-foreground/90 m-0 bg-background/40 border border-border/60 rounded p-3">
                        {prettyJson(r().invocationPayload)}
                      </pre>
                    </details>
                  </Show>

                  <Show when={r().output}>
                    <div>
                      <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                        Output
                      </div>
                      <pre class="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground/90 m-0 bg-background/40 border border-border/60 rounded p-3">
                        {r().output}
                      </pre>
                    </div>
                  </Show>

                  <Show when={eventLines().length > 0}>
                    <div>
                      <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                        Events
                      </div>
                      <ol class="m-0 p-0 list-none flex flex-col gap-1 max-h-80 overflow-auto bg-background/40 border border-border/60 rounded p-2">
                        <For each={eventLines()}>
                          {(line) => (
                            <li
                              class={`text-[11.5px] font-mono leading-snug whitespace-pre-wrap ${eventKindClass(line.kind)}`}
                            >
                              <Show when={!HIDDEN_KIND_TAGS.has(line.kind)}>
                                <span class="text-muted-foreground/70 mr-1">
                                  {line.kind}
                                </span>
                              </Show>
                              {line.text}
                            </li>
                          )}
                        </For>
                      </ol>
                    </div>
                  </Show>

                  <div>
                    <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                      Artifacts
                    </div>
                    <Show
                      when={!artifacts.loading}
                      fallback={
                        <div class="text-[12.5px] text-muted-foreground italic">
                          Loading artifacts...
                        </div>
                      }
                    >
                      <Show
                        when={(artifacts() ?? []).length > 0}
                        fallback={
                          <div class="text-[12.5px] text-muted-foreground italic">
                            No artifacts emitted.
                          </div>
                        }
                      >
                        <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
                          <For each={artifacts() ?? []}>
                            {(art: EmployeeRunArtifact) => (
                              <li class="flex items-center gap-2 text-[12px] border border-border/60 rounded px-2.5 py-1.5">
                                <span class="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground/70">
                                  {art.artifactType}
                                </span>
                                <Show when={art.title}>
                                  <span class="text-foreground truncate">
                                    {art.title}
                                  </span>
                                </Show>
                                <span
                                  class="font-mono text-[11px] text-muted-foreground/70 truncate ml-auto"
                                  title={art.id}
                                >
                                  {art.id}
                                </span>
                                <Show when={art.url}>
                                  <a
                                    class="text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 rounded px-1"
                                    href={art.url ?? "#"}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Open
                                  </a>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </Show>
                  </div>
                </div>
              );
            }}
          </Show>
        </div>
      </div>
    </div>
  );
};
