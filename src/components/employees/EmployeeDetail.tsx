// ABOUTME: Detail view for a single virtual employee - status, suspend/wake, manage actions.
// ABOUTME: Replaces the main content area when an employee row is selected in the sidebar.

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { CreateEmployeeModal } from "@/components/sidebar/CreateEmployeeModal";
import { gradientFor, initialFor } from "@/lib/employees/avatar";
import type {
  EmployeeMode,
  EmployeeStatus,
  EmployeeSummary,
} from "@/lib/employees/types";
import { employees as svc } from "@/services/employees";
import { employeeStore } from "@/stores/employees.store";
import { threadStore } from "@/stores/thread.store";

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
      class="flex items-center justify-center text-white font-bold flex-none rounded-lg"
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

const InfoRow: Component<{ label: string; children: unknown }> = (props) => (
  <div class="flex items-baseline gap-3">
    <div class="w-32 shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
      {props.label}
    </div>
    <div class="text-[13px] text-foreground min-w-0 break-words">
      {props.children as never}
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
  const [showEdit, setShowEdit] = createSignal(false);

  const summary = createMemo<EmployeeSummary | undefined>(() =>
    employeeStore.byId(props.employeeId),
  );

  const [detail] = createResource(
    () => props.employeeId,
    async (id) => employeeStore.loadDetail(id),
  );

  let kebabContainerRef: HTMLDivElement | undefined;

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // The edit modal owns its own keydown listener; let it handle Escape.
    if (showEdit()) return;
    if (confirmDelete()) {
      if (actionPending() === "delete") return;
      event.preventDefault();
      setConfirmDelete(false);
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
    void employeeStore.refresh();
    document.addEventListener("keydown", handleDocumentKeydown);
    document.addEventListener("mousedown", handleDocumentMousedown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleDocumentKeydown);
    document.removeEventListener("mousedown", handleDocumentMousedown);
  });

  const status = () => summary()?.status ?? "pending";
  const isRunning = () => status() === "running";
  const isStopped = () => status() === "stopped";

  const handleSuspendOrWake = async () => {
    const id = props.employeeId;
    if (actionPending() !== null) return;
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
    } else if (isStopped()) {
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
    setActionPending("delete");
    try {
      await svc.remove(id);
      employeeStore.remove(id);
      setConfirmDelete(false);
      props.onClose();
    } catch (err) {
      // Leave the confirm dialog open so the user sees the error in context
      // rather than having it fade behind the now-dismissed modal.
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const detailRecord = () => employeeStore.detail(props.employeeId);

  const description = () => {
    const prompt = detailRecord()?.prompt;
    if (!prompt) return null;
    // Strip YAML frontmatter and the leading H1 to surface just the body.
    const withoutFrontmatter = prompt.replace(/^---[\s\S]*?---\n/, "");
    const withoutHeading = withoutFrontmatter.replace(/^# .*\n+/, "");
    return withoutHeading.trim();
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

  return (
    <div class="flex flex-col h-full overflow-hidden bg-background">
      <Show
        when={summary()}
        fallback={
          <div class="flex items-center justify-center h-full text-muted-foreground text-sm">
            <Show
              when={!detail.loading}
              fallback={<span>Loading employee...</span>}
            >
              <span>Employee not found</span>
            </Show>
          </div>
        }
      >
        {(emp) => (
          <>
            {/* Header */}
            <div class="flex items-start gap-4 px-6 py-5 border-b border-border">
              <Avatar name={emp().name} seed={emp().avatarSeed} />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <h1 class="m-0 text-xl font-semibold text-foreground truncate">
                    {emp().name}
                  </h1>
                  <span
                    class={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium ${statusPillClass(emp().status)}`}
                  >
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
              </div>
              <div class="flex items-center gap-2 flex-none relative">
                <button
                  type="button"
                  class="px-3 py-1.5 rounded-md border text-[12px] font-medium transition-colors disabled:opacity-50"
                  classList={{
                    "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10":
                      isStopped(),
                    "border-amber-500/40 text-amber-300 hover:bg-amber-500/10":
                      isRunning(),
                    "border-border text-muted-foreground":
                      !isRunning() && !isStopped(),
                  }}
                  disabled={
                    actionPending() !== null || (!isRunning() && !isStopped())
                  }
                  onClick={handleSuspendOrWake}
                >
                  <Show when={actionPending() === "suspend"}>
                    Suspending...
                  </Show>
                  <Show when={actionPending() === "wake"}>Waking...</Show>
                  <Show
                    when={
                      actionPending() === null && (isRunning() || isStopped())
                    }
                  >
                    {isRunning() ? "Suspend" : "Wake"}
                  </Show>
                  <Show
                    when={
                      actionPending() === null && !isRunning() && !isStopped()
                    }
                  >
                    {statusLabel(emp().status)}
                  </Show>
                </button>
                <div ref={kebabContainerRef} class="relative">
                  <button
                    type="button"
                    class="flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                        class="w-full text-left px-3 py-1.5 text-[13px] text-foreground hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                        class="w-full text-left px-3 py-1.5 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors"
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
                  class="w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors"
                  aria-label="Close"
                  onClick={props.onClose}
                >
                  ×
                </button>
              </div>
            </div>

            {/* Body */}
            <div class="flex-1 overflow-y-auto px-6 py-6 max-w-3xl w-full">
              <Show when={actionError()}>
                <div
                  class="mb-4 py-2.5 px-3 bg-destructive/20 text-destructive rounded text-[13px]"
                  role="alert"
                >
                  {actionError()}
                </div>
              </Show>

              {/* Primary CTA */}
              <button
                type="button"
                class="w-full mb-6 py-3 px-4 bg-primary text-primary-foreground rounded-lg font-medium text-[14px] hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={emp().mode !== "always_on"}
                title={
                  emp().mode === "always_on"
                    ? `Open a new chat with ${emp().name}`
                    : "Manual run support is coming in a later phase"
                }
                onClick={async () => {
                  if (emp().mode !== "always_on") return;
                  try {
                    // Pass the default title so conversationStore.addMessage's
                    // auto-titler renames the thread based on the first user
                    // message. Linkage to the employee is conveyed by the
                    // sidebar grouping; we don't need the row title to repeat
                    // the employee name.
                    await threadStore.createChatThreadWithOptions("New Chat", {
                      provider:
                        emp().modelChoice === "private"
                          ? "seren-private"
                          : null,
                      model: emp().modelId ?? undefined,
                      employeeId: emp().id,
                    });
                    props.onClose();
                  } catch (err) {
                    setActionError(
                      err instanceof Error ? err.message : String(err),
                    );
                  }
                }}
              >
                {primaryCtaLabel(emp().mode)}
              </button>

              {/* Description */}
              <div class="mb-6">
                <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                  Role
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
                        class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors"
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

            <Show when={confirmDelete()}>
              <div
                class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
                onClick={(e) => {
                  if (
                    e.target === e.currentTarget &&
                    actionPending() !== "delete"
                  ) {
                    setConfirmDelete(false);
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
                    This permanently removes the deployment. Any threads
                    associated with this employee will lose their link.
                  </p>
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
                      class="py-2 px-4 rounded text-[13px] font-medium bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50"
                      onClick={() => setConfirmDelete(false)}
                      disabled={actionPending() === "delete"}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="py-2 px-4 rounded text-[13px] font-medium bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
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
