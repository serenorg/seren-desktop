// ABOUTME: Detail view for a single virtual employee - status, suspend/wake, manage actions.
// ABOUTME: Replaces the main content area when an employee row is selected in the sidebar.

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
import { EmployeeCheckpointsList } from "@/components/employees/EmployeeCheckpointsList";
import { EmployeeEvalDriftCard } from "@/components/employees/EmployeeEvalDriftCard";
import { EmployeeRevisionsModal } from "@/components/employees/EmployeeRevisionsModal";
import { EmployeeRunDetailModal } from "@/components/employees/EmployeeRunDetailModal";
import { EmployeeRunsList } from "@/components/employees/EmployeeRunsList";
import { EvalGateEditor } from "@/components/employees/EvalGateEditor";
import { CreateEmployeeModal } from "@/components/sidebar/CreateEmployeeModal";
import { gradientFor, initialFor } from "@/lib/employees/avatar";
import { extractInstructionSections } from "@/lib/employees/instructions";
import type {
  EmployeeMode,
  EmployeeStatus,
  EmployeeSummary,
} from "@/lib/employees/types";
import { getDefaultOrganizationId } from "@/lib/tauri-bridge";
import { employees as svc } from "@/services/employees";
import { employeesArchiveStore } from "@/services/employees-archive";
import {
  cancelEmployeeRun,
  runEmployeeMessage,
} from "@/services/employees-runtime";
import { conversationStore } from "@/stores/conversation.store";
import { employeeStore } from "@/stores/employees.store";
import { threadStore } from "@/stores/thread.store";

type ManualRunState =
  | { kind: "running"; partial: string }
  | { kind: "completed"; output: string; runId: string | null }
  | { kind: "awaitingApproval"; output: string; runId: string | null }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

// Condition types whose healthy steady state is `True`. Everything else is a
// problem signal whose healthy steady state is `False`.
const POSITIVE_CONDITION_TYPES = new Set(["Accepted", "Ready"]);

function manualRunKey(employeeId: string): string {
  return `manual:${employeeId}`;
}

interface EmployeeDetailProps {
  employeeId: string;
  onClose: () => void;
}

function modeLabel(mode: EmployeeMode): string {
  if (mode === "always_on") return "On-call";
  if (mode === "cron") return "Scheduled";
  return "On-demand";
}

function statusLabel(status: EmployeeStatus): string {
  if (status === "running") return "Live";
  if (status === "stopped") return "Suspended";
  if (status === "failed") return "Error";
  if (status === "pending") return "Pending";
  if (status === "building") return "Deploying";
  return status;
}

function statusPillClass(status: EmployeeStatus): string {
  if (status === "running")
    return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (status === "failed")
    return "bg-red-500/15 text-red-400 border-red-500/30";
  if (status === "stopped")
    return "bg-slate-500/15 text-slate-300 border-slate-500/30";
  return "bg-sky-500/15 text-sky-300 border-sky-500/30";
}

function primaryCtaLabel(mode: EmployeeMode): string {
  if (mode === "always_on") return "New conversation";
  if (mode === "cron") return "Run now";
  return "Run now";
}

const Avatar: Component<{ name: string; seed: string; size?: number }> = (
  props,
) => {
  const size = () => props.size ?? 44;
  return (
    <div
      class="flex items-center justify-center text-white font-bold flex-none rounded-lg shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.18)]"
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        background: gradientFor(props.seed),
        "font-size": `${Math.max(14, Math.floor(size() * 0.45))}px`,
      }}
      aria-hidden="true"
    >
      {initialFor(props.name)}
    </div>
  );
};

/**
 * Small inline status dot used inside the header status pill. Pulses for
 * transitory states (running/building/pending) so the operator gets an
 * ambient "this is live" signal without scanning text.
 */
const StatusDot: Component<{ status: EmployeeStatus }> = (props) => {
  const tone = () => {
    if (props.status === "running") return "bg-emerald-400";
    if (props.status === "failed") return "bg-red-400";
    if (props.status === "stopped") return "bg-slate-400";
    return "bg-sky-400";
  };
  const transitory = () =>
    props.status === "running" ||
    props.status === "pending" ||
    props.status === "building";
  return (
    <span class="relative inline-flex w-1.5 h-1.5 shrink-0" aria-hidden="true">
      <Show when={transitory()}>
        <span
          class={`absolute inset-0 rounded-full ${tone()} opacity-60 animate-ping`}
        />
      </Show>
      <span
        class={`relative inline-block w-1.5 h-1.5 rounded-full ${tone()}`}
      />
    </span>
  );
};

/**
 * Presence-style indicator notched into the bottom-right of the avatar.
 * Conveys deployment status at a glance even when the status pill is off
 * screen (e.g. when the operator is reading past the header).
 */
const AvatarPresence: Component<{ status: EmployeeStatus }> = (props) => (
  <span
    class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-[2px] border-background"
    classList={{
      "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.55)]":
        props.status === "running",
      "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.55)]":
        props.status === "failed",
      "bg-sky-400 animate-pulse":
        props.status === "pending" || props.status === "building",
      "bg-slate-500": props.status === "stopped",
    }}
    aria-hidden="true"
  />
);

const InfoRow: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <div class="flex items-baseline gap-3">
    <div class="w-32 shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
      {props.label}
    </div>
    <div class="text-[13px] text-foreground min-w-0 break-words">
      {props.children}
    </div>
  </div>
);

export const EmployeeDetail: Component<EmployeeDetailProps> = (props) => {
  const [actionPending, setActionPending] = createSignal<
    "suspend" | "wake" | "delete" | null
  >(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [showKebab, setShowKebab] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [removeChatsToo, setRemoveChatsToo] = createSignal(false);
  const [showEdit, setShowEdit] = createSignal(false);
  const [showRevisions, setShowRevisions] = createSignal(false);
  const [manualRun, setManualRun] = createSignal<ManualRunState | null>(null);
  const [runsRefreshNonce, setRunsRefreshNonce] = createSignal(0);
  const [detailRunId, setDetailRunId] = createSignal<string | null>(null);
  const [editingEvalGate, setEditingEvalGate] = createSignal(false);
  const [showCheckpoints, setShowCheckpoints] = createSignal(true);

  const [organizationId] = createResource(async () =>
    getDefaultOrganizationId(),
  );

  const summary = createMemo<EmployeeSummary | undefined>(() =>
    employeeStore.byId(props.employeeId),
  );

  const [detail] = createResource(
    () => props.employeeId,
    async (id) => employeeStore.loadDetail(id),
  );

  // Surface only conditions that warrant operator attention.
  // `Accepted`/`Ready` are positive conditions whose healthy steady state is
  // `True`; any other status (False/Unknown) means the spec did not validate
  // or the workload is not serving yet. Every other condition type is a
  // problem signal whose healthy steady state is `False`; True or Unknown
  // means the deployment is in (or may be in) that failure mode.
  const alertConditions = createMemo(() => {
    const conditions = detail()?.conditions ?? [];
    return conditions.filter((condition) => {
      if (POSITIVE_CONDITION_TYPES.has(condition.type)) {
        return condition.status !== "True";
      }
      return condition.status !== "False";
    });
  });

  // The runtime governance section also hosts the eval gate row, which is
  // the operator's entry point for attaching a gate on a minimal deployment.
  // Showing the section as soon as detail loads keeps "Attach gate" reachable
  // even when no other governance fields are set.

  let kebabContainerRef: HTMLDivElement | undefined;

  // Dismissing the confirm dialog resets the cascade-chats opt-in so a
  // reopened dialog starts from the safe default rather than carrying a
  // forgotten check across cancel/escape/backdrop dismissals.
  const dismissConfirmDelete = () => {
    setConfirmDelete(false);
    setRemoveChatsToo(false);
  };

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // The edit modal owns its own keydown listener; let it handle Escape.
    if (showEdit()) return;
    // The revisions modal owns its own keydown listener.
    if (showRevisions()) return;
    // The run detail modal owns its own keydown listener.
    if (detailRunId()) return;
    if (confirmDelete()) {
      if (actionPending() === "delete") return;
      event.preventDefault();
      dismissConfirmDelete();
      return;
    }
    if (showKebab()) {
      event.preventDefault();
      setShowKebab(false);
      return;
    }
    event.preventDefault();
    props.onClose();
  };

  const handleDocumentMousedown = (event: MouseEvent) => {
    if (!showKebab()) return;
    if (
      kebabContainerRef &&
      event.target instanceof Node &&
      kebabContainerRef.contains(event.target)
    ) {
      return;
    }
    setShowKebab(false);
  };

  onMount(() => {
    // The sidebar polls the roster every 30s and on visibility change, so a
    // foreground refresh here just toggles the store's loading state for no
    // reason. Use background mode once the store has loaded at least once so
    // mounting the detail doesn't ripple through any consumer that reads
    // `loading` (and lets the sidebar/thread groups stay still).
    void employeeStore.refresh({
      background: employeeStore.lastLoadedAt !== null,
    });
    document.addEventListener("keydown", handleDocumentKeydown);
    document.addEventListener("mousedown", handleDocumentMousedown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleDocumentKeydown);
    document.removeEventListener("mousedown", handleDocumentMousedown);
  });

  const status = () => summary()?.status ?? "pending";
  const isRunning = () => status() === "running";
  const isWakeable = () => status() === "stopped" || status() === "failed";
  const canStartRun = () => isRunning() && actionPending() === null;

  const handleSuspendOrWake = async () => {
    const id = props.employeeId;
    if (actionPending() !== null) return;
    setActionError(null);
    if (isRunning()) {
      setActionPending("suspend");
      employeeStore.setStatus(id, "stopped");
      try {
        await svc.suspend(id);
        await employeeStore.refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        await employeeStore.refresh();
      } finally {
        setActionPending(null);
      }
    } else if (isWakeable()) {
      setActionPending("wake");
      employeeStore.setStatus(id, "pending");
      try {
        await svc.wake(id);
        await employeeStore.refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        await employeeStore.refresh();
      } finally {
        setActionPending(null);
      }
    }
  };

  const handleDelete = async () => {
    const id = props.employeeId;
    if (actionPending() !== null) return;
    setActionError(null);
    setActionPending("delete");
    // Capture display metadata BEFORE the cloud delete so the archive snapshot
    // survives the live row being removed from the store on success.
    const snapshot = (() => {
      const s = summary() ?? detail();
      if (!s) return null;
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        mode: s.mode,
        avatarSeed: s.avatarSeed,
      };
    })();
    try {
      const cascadeChats = removeChatsToo();
      if (cascadeChats) {
        // Wipe local chat history first; if the cloud delete fails after this
        // the user can re-run delete without an inconsistent half-state.
        await employeesArchiveStore.cascadeDeleteChats(id);
        await conversationStore.forgetByEmployee(id);
      } else if (snapshot) {
        // Persist the local parent before cloud deletion so a successful cloud
        // wipe cannot strand the chats under "No project" if local archiving
        // fails.
        await employeesArchiveStore.archive(snapshot);
      }
      try {
        await svc.remove(id);
      } catch (err) {
        if (!cascadeChats && snapshot) {
          try {
            await employeesArchiveStore.remove(snapshot.id);
          } catch (cleanupErr) {
            console.warn(
              "Failed to roll back archived employee snapshot",
              cleanupErr,
            );
          }
        }
        throw err;
      }
      if (!cascadeChats && snapshot) {
        employeeStore.addArchived({
          ...snapshot,
          archivedAt: new Date().toISOString(),
        });
      }
      employeeStore.remove(id);
      setConfirmDelete(false);
      setRemoveChatsToo(false);
      props.onClose();
    } catch (err) {
      // Leave the confirm dialog open so the user sees the error in context
      // rather than having it fade behind the now-dismissed modal.
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const handleManualRun = async () => {
    const id = props.employeeId;
    if (manualRun()?.kind === "running") return;
    setManualRun({ kind: "running", partial: "" });
    let startupNoticeShown = false;
    try {
      const result = await runEmployeeMessage(id, "", {
        runKey: manualRunKey(id),
        onStartupWait: () => {
          if (startupNoticeShown) return;
          startupNoticeShown = true;
          setManualRun({
            kind: "running",
            partial:
              "Starting employee runtime. The run will begin once it is ready.",
          });
        },
        onText: (chunk) => {
          setManualRun((prev) => {
            if (prev?.kind !== "running") return prev;
            const base = startupNoticeShown ? "" : prev.partial;
            startupNoticeShown = false;
            return { kind: "running", partial: base + chunk };
          });
        },
      });
      if (result.status === "awaiting_approval") {
        setManualRun({
          kind: "awaitingApproval",
          output: result.text,
          runId: result.runId,
        });
      } else {
        setManualRun({
          kind: "completed",
          output: result.text,
          runId: result.runId,
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setManualRun({ kind: "cancelled" });
        return;
      }
      setManualRun({
        kind: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Pull the persisted run into the list once cloud storage catches up.
      setRunsRefreshNonce((n) => n + 1);
    }
  };

  const handleManualCancel = () => {
    void cancelEmployeeRun(manualRunKey(props.employeeId));
  };

  const handlePrimaryAction = async () => {
    const employee = summary();
    if (!employee || !canStartRun()) return;
    if (employee.mode === "always_on") {
      try {
        await threadStore.createChatThreadWithOptions("New Chat", {
          provider: employee.modelChoice === "private" ? "seren-private" : null,
          model: employee.modelId ?? undefined,
          employeeId: employee.id,
        });
        props.onClose();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    await handleManualRun();
  };

  const detailRecord = () => employeeStore.detail(props.employeeId);

  const description = () => {
    const instructions = detailRecord()?.instructions;
    if (!instructions) return null;
    return extractInstructionSections(instructions).skill.trim();
  };

  const copyEndpoint = async () => {
    const url = summary()?.endpointUrl;
    if (!url || typeof navigator === "undefined" || !navigator.clipboard)
      return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard write can fail without a user gesture; ignore silently.
    }
  };

  const PrimaryActionButton: Component<{
    employee: EmployeeSummary;
    variant?: "full" | "compact";
  }> = (buttonProps) => {
    const isCompact = () => buttonProps.variant === "compact";
    const isAlwaysOn = () => buttonProps.employee.mode === "always_on";
    // Only on-demand/cron buttons drive a manual run; always-on never enters
    // this loading state because the action opens a chat instead.
    const isManualRunInFlight = () =>
      !isAlwaysOn() && manualRun()?.kind === "running";
    const isDisabled = () => isManualRunInFlight() || !canStartRun();
    const actionNoun = () => (isAlwaysOn() ? "chat" : "run");
    const title = () => {
      if (!canStartRun()) {
        return `${buttonProps.employee.name} is ${statusLabel(
          buttonProps.employee.status,
        ).toLowerCase()}; wake it before starting a ${actionNoun()}`;
      }
      return isAlwaysOn()
        ? `Open a new chat with ${buttonProps.employee.name}`
        : `Run ${buttonProps.employee.name} once now`;
    };

    // `min-w-[12rem]` keeps the compact button at a stable footprint so the
    // header doesn't reflow when the label or icon changes width.
    const compactClass =
      "inline-flex h-10 min-w-[12rem] items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 text-[13.5px] font-medium text-primary-foreground shadow-sm shadow-primary/20 transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background";
    const fullClass =
      "inline-flex w-full items-center justify-center gap-2 py-3 px-4 rounded-lg bg-primary text-primary-foreground font-medium text-[14px] transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

    return (
      <button
        type="button"
        class={isCompact() ? compactClass : fullClass}
        disabled={isDisabled()}
        title={title()}
        onClick={handlePrimaryAction}
      >
        <Show
          when={!isManualRunInFlight()}
          fallback={
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              class="shrink-0 animate-spin"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-dasharray="22 14"
              />
            </svg>
          }
        >
          <Show
            when={isAlwaysOn()}
            fallback={
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                class="shrink-0"
              >
                <path
                  d="M5 4 L12 8 L5 12 Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
              </svg>
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              class="shrink-0"
            >
              <path
                d="M3.5 4.5h9v5.5h-5l-3 2v-2h-1z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
            </svg>
          </Show>
        </Show>
        {isManualRunInFlight()
          ? "Running..."
          : primaryCtaLabel(buttonProps.employee.mode)}
      </button>
    );
  };

  return (
    <div class="flex flex-col h-full overflow-hidden bg-background">
      <Show
        when={summary()}
        fallback={
          <div class="flex items-center justify-center h-full text-muted-foreground text-sm px-6">
            <Show
              when={!detail.loading}
              fallback={<span>Loading employee...</span>}
            >
              <Show
                when={detail.error}
                fallback={<span>Employee not found</span>}
              >
                <div
                  class="py-2.5 px-3 bg-destructive/20 text-destructive rounded text-[13px] max-w-md"
                  role="alert"
                >
                  {detail.error instanceof Error
                    ? detail.error.message
                    : String(detail.error)}
                </div>
              </Show>
            </Show>
          </div>
        }
      >
        {(emp) => (
          <>
            {/* Header */}
            <div class="flex items-start gap-4 px-6 py-5 border-b border-border">
              <div class="relative flex-none">
                <Avatar name={emp().name} seed={emp().avatarSeed} />
                <AvatarPresence status={emp().status} />
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <h1 class="m-0 text-xl font-semibold text-foreground truncate tracking-tight">
                    {emp().name}
                  </h1>
                  <span
                    class={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium ${statusPillClass(emp().status)}`}
                  >
                    <StatusDot status={emp().status} />
                    {statusLabel(emp().status)}
                  </span>
                </div>
                <div class="mt-1 text-[12px] text-muted-foreground flex items-center gap-3 flex-wrap">
                  <span>{modeLabel(emp().mode)}</span>
                  <Show when={emp().modelChoice === "private"}>
                    <span>Private model</span>
                  </Show>
                  <Show when={emp().modelChoice === "standard"}>
                    <span>Standard - {emp().modelPolicy ?? "balanced"}</span>
                  </Show>
                  <Show when={emp().mode === "cron" && emp().cronSchedule}>
                    <span class="font-mono">{emp().cronSchedule}</span>
                  </Show>
                </div>
                <Show when={alertConditions().length > 0}>
                  <div class="mt-2 flex items-center gap-1.5 flex-wrap">
                    <For each={alertConditions()}>
                      {(condition) => (
                        <span
                          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-900 text-[11px] font-medium"
                          title={
                            condition.message ?? condition.reason ?? undefined
                          }
                        >
                          {condition.type}
                          <Show when={condition.reason}>
                            <span class="text-amber-700">
                              - {condition.reason}
                            </span>
                          </Show>
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <div class="flex items-center justify-end gap-2 flex-none relative flex-wrap max-w-[420px]">
                <Show when={emp().mode === "always_on"}>
                  <PrimaryActionButton employee={emp()} variant="compact" />
                </Show>
                <Show when={emp().mode === "always_on" && !canStartRun()}>
                  <div class="basis-full text-right text-[12px] text-muted-foreground">
                    Wake this employee before starting a chat.
                  </div>
                </Show>
                <Show
                  when={isRunning() || isWakeable() || actionPending() !== null}
                  fallback={
                    <span
                      class="px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground"
                      aria-label={`Status: ${statusLabel(emp().status)}`}
                    >
                      {statusLabel(emp().status)}
                    </span>
                  }
                >
                  <button
                    type="button"
                    class="px-3 py-1.5 rounded-md border text-[12px] font-medium transition-colors disabled:opacity-50"
                    classList={{
                      "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10":
                        isWakeable(),
                      "border-amber-500/40 text-amber-300 hover:bg-amber-500/10":
                        isRunning(),
                    }}
                    disabled={actionPending() !== null}
                    onClick={handleSuspendOrWake}
                  >
                    <Show when={actionPending() === "suspend"}>
                      Suspending...
                    </Show>
                    <Show when={actionPending() === "wake"}>Waking...</Show>
                    <Show when={actionPending() === null}>
                      {isRunning() ? "Suspend" : "Wake"}
                    </Show>
                  </button>
                </Show>
                <div ref={kebabContainerRef} class="relative">
                  <button
                    type="button"
                    class="flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                    aria-label="More actions"
                    aria-haspopup="menu"
                    aria-expanded={showKebab()}
                    disabled={actionPending() !== null}
                    onClick={() => setShowKebab((v) => !v)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="3" cy="8" r="1.4" />
                      <circle cx="8" cy="8" r="1.4" />
                      <circle cx="13" cy="8" r="1.4" />
                    </svg>
                  </button>
                  <Show when={showKebab()}>
                    <div
                      class="absolute right-0 top-10 z-10 min-w-[160px] bg-popover border border-border rounded-md shadow-lg py-1"
                      role="menu"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        class="w-full text-left px-3 py-1.5 text-[13px] text-foreground hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:bg-surface-2"
                        onClick={() => {
                          setShowKebab(false);
                          setShowEdit(true);
                        }}
                        disabled={!detailRecord()}
                        title={
                          detailRecord()
                            ? "Edit this employee"
                            : "Loading employee detail..."
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="w-full text-left px-3 py-1.5 text-[13px] text-foreground hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:bg-surface-2"
                        onClick={() => {
                          setShowKebab(false);
                          setShowRevisions(true);
                        }}
                      >
                        View revisions
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="w-full text-left px-3 py-1.5 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors focus-visible:outline-none focus-visible:bg-red-500/10"
                        onClick={() => {
                          setShowKebab(false);
                          setConfirmDelete(true);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </Show>
                </div>
                <button
                  type="button"
                  class="w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                  aria-label="Close"
                  onClick={props.onClose}
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
            </div>

            {/* Body */}
            <div class="flex-1 overflow-y-auto px-6 py-6 w-full min-w-0">
              <Show when={actionError()}>
                <div
                  class="mb-4 py-2.5 px-3 bg-destructive/20 text-destructive rounded text-[13px]"
                  role="alert"
                >
                  {actionError()}
                </div>
              </Show>

              <Show when={emp().mode !== "always_on"}>
                <PrimaryActionButton employee={emp()} />
                <Show when={!canStartRun()}>
                  <div class="mt-2 mb-4 text-[12px] text-muted-foreground">
                    Wake this employee before starting a run.
                  </div>
                </Show>
              </Show>

              {/* Inline manual-run status (cron / on-demand only) */}
              <Show
                when={emp().mode !== "always_on" && manualRun()}
                fallback={<div class="mb-6" />}
              >
                {(run) => (
                  <div class="mt-3 mb-6 border border-border rounded-md px-3 py-2.5 bg-card">
                    <Show when={run().kind === "running"}>
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-[12.5px] text-muted-foreground">
                          Run in progress...
                        </span>
                        <button
                          type="button"
                          class="text-[11.5px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                          onClick={handleManualCancel}
                          aria-label="Cancel run"
                        >
                          Cancel
                        </button>
                      </div>
                      <Show
                        when={
                          run().kind === "running" &&
                          (run() as { partial: string }).partial
                        }
                      >
                        <pre class="mt-2 whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-foreground/90 m-0">
                          {(run() as { partial: string }).partial}
                        </pre>
                      </Show>
                    </Show>
                    <Show when={run().kind === "completed"}>
                      <div class="flex items-center gap-2 mb-1.5">
                        <span class="inline-flex items-center px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-400 text-[10.5px] font-medium">
                          Completed
                        </span>
                        <Show
                          when={
                            (
                              run() as {
                                runId: string | null;
                              }
                            ).runId
                          }
                        >
                          {(id) => (
                            <button
                              type="button"
                              class="text-[11.5px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                              onClick={() => setDetailRunId(id())}
                            >
                              Open run details
                            </button>
                          )}
                        </Show>
                        <button
                          type="button"
                          class="ml-auto text-[11.5px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                          onClick={() => setManualRun(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                      <Show
                        when={(run() as { output: string }).output}
                        fallback={
                          <div class="text-[12.5px] text-muted-foreground italic">
                            (no output)
                          </div>
                        }
                      >
                        <pre class="whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-foreground m-0">
                          {(run() as { output: string }).output}
                        </pre>
                      </Show>
                    </Show>
                    <Show when={run().kind === "awaitingApproval"}>
                      <div class="flex items-center gap-2 mb-1.5 flex-wrap">
                        <span class="inline-flex items-center px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/15 text-amber-300 text-[10.5px] font-medium">
                          Awaiting approval
                        </span>
                        <Show
                          when={
                            (
                              run() as {
                                runId: string | null;
                              }
                            ).runId
                          }
                        >
                          {(id) => (
                            <button
                              type="button"
                              class="text-[11.5px] px-2 py-0.5 rounded border border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60"
                              onClick={() => setDetailRunId(id())}
                            >
                              Review approvals
                            </button>
                          )}
                        </Show>
                        <button
                          type="button"
                          class="ml-auto text-[11.5px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                          onClick={() => setManualRun(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                      <div class="text-[12.5px] text-muted-foreground mb-1.5">
                        The run is paused waiting on approval. Open the run to
                        approve or reject the pending tool calls.
                      </div>
                      <Show when={(run() as { output: string }).output}>
                        <pre class="whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-foreground m-0">
                          {(run() as { output: string }).output}
                        </pre>
                      </Show>
                    </Show>
                    <Show when={run().kind === "failed"}>
                      <div class="flex items-center gap-2 mb-1.5">
                        <span class="inline-flex items-center px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/15 text-red-400 text-[10.5px] font-medium">
                          Failed
                        </span>
                        <button
                          type="button"
                          class="ml-auto text-[11.5px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                          onClick={() => setManualRun(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                      <div class="text-[12.5px] text-red-400" role="alert">
                        {(run() as { message: string }).message}
                      </div>
                    </Show>
                    <Show when={run().kind === "cancelled"}>
                      <div class="flex items-center gap-2">
                        <span class="text-[12.5px] text-muted-foreground italic">
                          Run cancelled.
                        </span>
                        <button
                          type="button"
                          class="ml-auto text-[11.5px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                          onClick={() => setManualRun(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>

              {/* Description */}
              <div class="mb-6">
                <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                  SKILL.md
                </div>
                <Show
                  when={description()}
                  fallback={
                    <Show
                      when={!detail.loading}
                      fallback={
                        <div class="text-[13px] text-muted-foreground italic">
                          Loading...
                        </div>
                      }
                    >
                      <div class="text-[13px] text-muted-foreground italic">
                        No description available.
                      </div>
                    </Show>
                  }
                >
                  {(text) => (
                    <pre class="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-foreground m-0">
                      {text()}
                    </pre>
                  )}
                </Show>
              </div>

              {/* Tools */}
              <Show when={detailRecord()}>
                {(d) => (
                  <Show when={d().toolPresets.length > 0}>
                    <div class="mb-6">
                      <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                        Tools
                      </div>
                      <div class="flex flex-wrap gap-1.5">
                        <For each={d().toolPresets}>
                          {(preset) => (
                            <span class="px-2.5 py-0.5 rounded-full bg-surface-2 border border-border text-[11.5px] text-foreground">
                              {preset}
                            </span>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                )}
              </Show>

              {/* Recent runs - cron and on-demand employees produce runs
                  rather than chat threads; on-call employees show their
                  threads under the employee in the sidebar instead. */}
              <Show when={emp().mode !== "always_on"}>
                <div class="mb-6">
                  <EmployeeRunsList
                    employeeId={emp().id}
                    refreshNonce={runsRefreshNonce()}
                  />
                </div>
              </Show>

              {/* Deployment info */}
              <div class="mb-2 grid gap-2 py-4 border-t border-border">
                <InfoRow label="Deployment ID">
                  <span class="font-mono text-[12px] text-muted-foreground">
                    {emp().id}
                  </span>
                </InfoRow>
                <InfoRow label="Slug">
                  <span class="font-mono text-[12px]">{emp().slug}</span>
                </InfoRow>
                <Show when={emp().endpointUrl}>
                  <InfoRow label="Endpoint">
                    <span class="flex items-center gap-2">
                      <span class="font-mono text-[12px] text-muted-foreground truncate">
                        {emp().endpointUrl}
                      </span>
                      <button
                        type="button"
                        class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                        onClick={copyEndpoint}
                      >
                        Copy
                      </button>
                    </span>
                  </InfoRow>
                </Show>
                <Show when={emp().activeRevisionId}>
                  <InfoRow label="Active revision">
                    <span class="font-mono text-[12px] text-muted-foreground">
                      {emp().activeRevisionId}
                    </span>
                  </InfoRow>
                </Show>
                <InfoRow label="Updated">
                  <span class="text-[12px] text-muted-foreground">
                    {new Date(emp().updatedAt).toLocaleString()}
                  </span>
                </InfoRow>
                <Show when={emp().errorMessage}>
                  <InfoRow label="Last error">
                    <span class="text-[12px] text-red-400">
                      {emp().errorMessage}
                    </span>
                  </InfoRow>
                </Show>
              </div>

              <Show when={detail()}>
                <div class="mb-2 grid gap-2 py-4 border-t border-border">
                  <div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                    Runtime governance
                  </div>
                  <Show when={detail()?.runtimePolicy?.network}>
                    {(network) => (
                      <InfoRow label="Network">
                        <span class="text-[12px] text-muted-foreground">
                          Default {network().default}
                          <Show
                            when={(network().egress_rules ?? []).length > 0}
                          >
                            {" - "}
                            {(network().egress_rules ?? []).length} egress rule
                            {(network().egress_rules ?? []).length === 1
                              ? ""
                              : "s"}
                          </Show>
                        </span>
                      </InfoRow>
                    )}
                  </Show>
                  <Show when={detail()?.runtimePolicy?.resources}>
                    {(resources) => (
                      <InfoRow label="Resources">
                        <span class="text-[12px] text-muted-foreground">
                          <Show when={resources().cpu_limit}>
                            cpu {resources().cpu_limit}
                          </Show>
                          <Show when={resources().memory_limit}>
                            {resources().cpu_limit ? " - " : ""}
                            mem {resources().memory_limit}
                          </Show>
                        </span>
                      </InfoRow>
                    )}
                  </Show>
                  <Show when={(detail()?.guardrails ?? []).length > 0}>
                    <InfoRow label="Guardrails">
                      <span class="text-[12px] text-muted-foreground">
                        {(detail()?.guardrails ?? []).length} declared
                      </span>
                    </InfoRow>
                  </Show>
                  <Show when={detail()?.memoryPolicy}>
                    {(policy) => (
                      <InfoRow label="Memory">
                        <span class="text-[12px] text-muted-foreground">
                          {policy().semantic_memory?.enabled
                            ? "Semantic memory enabled"
                            : "Configured"}
                        </span>
                      </InfoRow>
                    )}
                  </Show>
                  <Show when={(detail()?.credentials ?? []).length > 0}>
                    <InfoRow label="Credentials">
                      <span class="text-[12px] text-muted-foreground">
                        {(detail()?.credentials ?? []).length} reference
                        {(detail()?.credentials ?? []).length === 1 ? "" : "s"}
                      </span>
                    </InfoRow>
                  </Show>
                  <Show when={(detail()?.toolRefs ?? []).length > 0}>
                    <InfoRow label="Tool refs">
                      <span class="text-[12px] text-muted-foreground">
                        {(detail()?.toolRefs ?? []).length} typed ref
                        {(detail()?.toolRefs ?? []).length === 1 ? "" : "s"}
                      </span>
                    </InfoRow>
                  </Show>
                  <Show when={detail()?.evalGate}>
                    {(gate) => (
                      <>
                        <InfoRow label="Eval gate">
                          <span class="flex items-center gap-2 flex-wrap">
                            <span class="text-[12px] text-muted-foreground">
                              set <span class="font-mono">{gate().set_id}</span>
                              <span class="mx-1.5 text-muted-foreground/60">
                                -
                              </span>
                              fresh within {gate().max_age_seconds}s
                              <Show when={gate().block_on_failure === true}>
                                <span class="ml-1 text-amber-700 font-medium">
                                  - blocks apply on failure
                                </span>
                              </Show>
                            </span>
                            <button
                              type="button"
                              class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                              onClick={() => setEditingEvalGate((v) => !v)}
                              data-testid="employee-edit-eval-gate"
                            >
                              {editingEvalGate() ? "Close editor" : "Edit gate"}
                            </button>
                          </span>
                        </InfoRow>
                        <Show when={gate().schedule}>
                          {(schedule) => (
                            <InfoRow label="Eval schedule">
                              <span class="text-[12px] text-muted-foreground">
                                <span class="font-mono">{schedule().cron}</span>
                                <Show when={schedule().timezone}>
                                  <span class="ml-1.5">
                                    ({schedule().timezone})
                                  </span>
                                </Show>
                              </span>
                            </InfoRow>
                          )}
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show when={!detail()?.evalGate}>
                    <InfoRow label="Eval gate">
                      <span class="flex items-center gap-2 flex-wrap">
                        <span class="text-[12px] text-muted-foreground italic">
                          No gate attached.
                        </span>
                        <button
                          type="button"
                          class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                          onClick={() => setEditingEvalGate((v) => !v)}
                          data-testid="employee-attach-eval-gate"
                        >
                          {editingEvalGate() ? "Close editor" : "Attach gate"}
                        </button>
                      </span>
                    </InfoRow>
                  </Show>
                </div>
                <Show when={editingEvalGate()}>
                  <div class="mt-3">
                    <EvalGateEditor
                      deploymentId={emp().id}
                      initial={detail()?.evalGate ?? null}
                      onCancel={() => setEditingEvalGate(false)}
                      onSaved={() => {
                        setEditingEvalGate(false);
                        void employeeStore.loadDetail(emp().id);
                      }}
                    />
                  </div>
                </Show>
                <Show when={detail()?.evalGate && organizationId()}>
                  {(orgId) => (
                    <div class="mt-3">
                      <EmployeeEvalDriftCard
                        deploymentId={emp().id}
                        organizationId={orgId() as string}
                      />
                    </div>
                  )}
                </Show>
              </Show>

              <div class="mb-2 grid gap-2 py-4 border-t border-border">
                <button
                  type="button"
                  class="flex items-center justify-between text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 hover:text-foreground transition-colors"
                  onClick={() => setShowCheckpoints((v) => !v)}
                  aria-expanded={showCheckpoints()}
                  data-testid="employee-toggle-checkpoints"
                >
                  <span>Session checkpoints</span>
                  <span aria-hidden="true">
                    {showCheckpoints() ? "-" : "+"}
                  </span>
                </button>
                {/* Keep the list mounted across collapse so pagination state
                    and the initial fetch survive a fold/unfold cycle. The
                    org id resolves asynchronously via Tauri; gating on it
                    here means the resource fires exactly once with real
                    data rather than firing twice (null then real) and
                    flashing an empty state in between. */}
                <div hidden={!showCheckpoints()}>
                  <Show
                    when={organizationId()}
                    fallback={<div class="min-h-11" aria-hidden="true" />}
                  >
                    {(orgId) => (
                      <EmployeeCheckpointsList
                        deploymentId={emp().id}
                        organizationId={orgId() as string}
                      />
                    )}
                  </Show>
                </div>
              </div>
            </div>

            <Show when={showEdit() && detailRecord()}>
              {(d) => (
                <CreateEmployeeModal
                  employee={d()}
                  onClose={() => setShowEdit(false)}
                  onCreated={(id) => {
                    void employeeStore.loadDetail(id);
                  }}
                />
              )}
            </Show>

            <Show when={showRevisions()}>
              <EmployeeRevisionsModal
                employeeId={emp().id}
                activeRevisionId={emp().activeRevisionId}
                onClose={() => setShowRevisions(false)}
                onRolledBack={() => {
                  void employeeStore.refresh();
                  void employeeStore.loadDetail(emp().id);
                }}
              />
            </Show>

            <Show when={detailRunId()}>
              {(id) => (
                <EmployeeRunDetailModal
                  deploymentId={emp().id}
                  runId={id()}
                  onClose={() => setDetailRunId(null)}
                />
              )}
            </Show>

            <Show when={confirmDelete()}>
              <div
                class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
                onClick={(e) => {
                  if (
                    e.target === e.currentTarget &&
                    actionPending() !== "delete"
                  ) {
                    dismissConfirmDelete();
                  }
                }}
                role="dialog"
                aria-modal="true"
                aria-labelledby="confirm-delete-title"
              >
                <div class="bg-popover border border-border rounded-lg w-[420px] max-w-[90vw] shadow-xl animate-[slideUp_0.2s_ease-out] p-5">
                  <h2
                    id="confirm-delete-title"
                    class="m-0 text-base font-semibold text-foreground mb-2"
                  >
                    Delete {emp().name}?
                  </h2>
                  <p class="m-0 text-[13px] text-muted-foreground leading-relaxed">
                    <Show
                      when={removeChatsToo()}
                      fallback={
                        <>
                          The cloud deployment will be removed. Past chats with{" "}
                          {emp().name} stay in your sidebar under an archived
                          row so you can still read them.
                        </>
                      }
                    >
                      The cloud deployment and all chats with {emp().name} will
                      be permanently removed. This cannot be undone.
                    </Show>
                  </p>
                  <label class="mt-4 flex items-start gap-2 text-[12.5px] text-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      class="mt-[2px] accent-red-500 cursor-pointer"
                      checked={removeChatsToo()}
                      onChange={(e) =>
                        setRemoveChatsToo(e.currentTarget.checked)
                      }
                      disabled={actionPending() === "delete"}
                    />
                    <span>
                      Also remove past chats with this employee
                      <span class="block text-[11.5px] text-muted-foreground/80 mt-0.5">
                        Default keeps chats; check to wipe them with the
                        deployment.
                      </span>
                    </span>
                  </label>
                  <Show when={actionError()}>
                    <div
                      class="mt-3 py-2 px-3 bg-destructive/20 text-destructive rounded text-[12.5px]"
                      role="alert"
                    >
                      {actionError()}
                    </div>
                  </Show>
                  <div class="flex justify-end gap-2 mt-5">
                    <button
                      type="button"
                      class="py-2 px-4 rounded text-[13px] font-medium bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                      onClick={dismissConfirmDelete}
                      disabled={actionPending() === "delete"}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="py-2 px-4 rounded text-[13px] font-medium bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-300"
                      onClick={handleDelete}
                      disabled={actionPending() === "delete"}
                    >
                      {actionPending() === "delete" ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};
