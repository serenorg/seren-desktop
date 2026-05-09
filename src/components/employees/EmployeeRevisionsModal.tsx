// ABOUTME: Modal listing the immutable revision history for an employee.
// ABOUTME: Lets the user roll back to a prior revision after a confirm step.

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
import type { EmployeeRevisionChangeKind } from "@/lib/employees/types";
import { employees as svc } from "@/services/employees";
import { employeeStore } from "@/stores/employees.store";

interface EmployeeRevisionsModalProps {
  employeeId: string;
  activeRevisionId: string | null;
  onClose: () => void;
  onRolledBack: () => void;
}

function changeKindLabel(kind: EmployeeRevisionChangeKind): string {
  if (kind === "create") return "Created";
  if (kind === "rollback") return "Rolled back";
  return "Updated";
}

function changeKindClass(kind: EmployeeRevisionChangeKind): string {
  if (kind === "create")
    return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (kind === "rollback")
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-sky-500/15 text-sky-300 border-sky-500/30";
}

export const EmployeeRevisionsModal: Component<EmployeeRevisionsModalProps> = (
  props,
) => {
  const [revisions, { refetch }] = createResource(
    () => props.employeeId,
    async (id) => svc.listRevisions(id),
  );

  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [confirmId, setConfirmId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const sorted = createMemo(() => {
    const list = revisions() ?? [];
    return [...list].sort((a, b) => b.version - a.version);
  });

  const confirmRevision = createMemo(() => {
    const id = confirmId();
    if (!id) return null;
    return sorted().find((r) => r.revisionId === id) ?? null;
  });

  const handleRollback = async (revisionId: string) => {
    if (pendingId() !== null) return;
    setPendingId(revisionId);
    setError(null);
    try {
      const summary = await svc.rollback(props.employeeId, revisionId);
      employeeStore.upsert(summary);
      await employeeStore.loadDetail(props.employeeId);
      await refetch();
      setConfirmId(null);
      props.onRolledBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  };

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (confirmId()) {
      if (pendingId() !== null) return;
      event.preventDefault();
      setConfirmId(null);
      return;
    }
    event.preventDefault();
    props.onClose();
  };

  onMount(() => {
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && pendingId() === null) {
      props.onClose();
    }
  };

  return (
    <div
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="employee-revisions-title"
    >
      <div class="bg-popover border border-border rounded-lg w-[640px] max-w-[92vw] max-h-[88vh] overflow-hidden flex flex-col shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="flex justify-between items-center py-4 px-5 border-b border-border">
          <h2
            id="employee-revisions-title"
            class="m-0 text-base font-semibold text-foreground"
          >
            Revisions
          </h2>
          <button
            type="button"
            class="bg-transparent border-none text-muted-foreground text-2xl leading-none cursor-pointer py-1 px-2 rounded transition-all duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50"
            onClick={props.onClose}
            disabled={pendingId() !== null}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-5 py-4">
          <Show when={error()}>
            <div
              class="mb-4 py-2.5 px-3 bg-destructive/20 text-destructive rounded text-[13px]"
              role="alert"
            >
              {error()}
            </div>
          </Show>

          <Show
            when={!revisions.loading}
            fallback={
              <div class="text-[13px] text-muted-foreground italic py-8 text-center">
                Loading revisions...
              </div>
            }
          >
            <Show
              when={sorted().length > 0}
              fallback={
                <div class="text-[13px] text-muted-foreground italic py-8 text-center">
                  No revisions yet.
                </div>
              }
            >
              <ol class="m-0 p-0 list-none flex flex-col gap-2">
                <For each={sorted()}>
                  {(rev) => {
                    const isActive = () =>
                      rev.revisionId === props.activeRevisionId;
                    return (
                      <li
                        class="border border-border rounded-md px-3 py-2.5"
                        classList={{
                          "border-primary/60 bg-primary/[0.04]": isActive(),
                        }}
                      >
                        <div class="flex items-center gap-2 flex-wrap">
                          <span
                            class={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] font-medium ${changeKindClass(rev.changeKind)}`}
                          >
                            {changeKindLabel(rev.changeKind)}
                          </span>
                          <span class="text-[13px] font-semibold text-foreground">
                            v{rev.version}
                          </span>
                          <Show when={isActive()}>
                            <span class="text-[10.5px] text-primary uppercase tracking-[0.12em]">
                              Active
                            </span>
                          </Show>
                          <span class="text-[11.5px] text-muted-foreground ml-auto">
                            {new Date(rev.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <Show when={rev.changeSummary.length > 0}>
                          <ul class="mt-1.5 mb-0 pl-4 text-[12.5px] text-foreground/90">
                            <For each={rev.changeSummary}>
                              {(line) => <li>{line}</li>}
                            </For>
                          </ul>
                        </Show>
                        <Show when={rev.restoredFromRevisionId}>
                          <div class="mt-1 text-[11.5px] text-muted-foreground">
                            Restored from{" "}
                            <span class="font-mono">
                              {rev.restoredFromRevisionId}
                            </span>
                          </div>
                        </Show>
                        <div class="mt-2 flex items-center gap-2">
                          <span class="font-mono text-[11px] text-muted-foreground/80 truncate flex-1">
                            {rev.revisionId}
                          </span>
                          <Show when={!isActive()}>
                            <button
                              type="button"
                              class="px-2.5 py-1 rounded text-[12px] font-medium border border-border text-foreground hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              onClick={() => setConfirmId(rev.revisionId)}
                              disabled={pendingId() !== null}
                            >
                              Roll back
                            </button>
                          </Show>
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ol>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={confirmRevision()}>
        {(rev) => (
          <div
            class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1100] animate-[fadeIn_0.15s_ease-out]"
            onClick={(e) => {
              if (e.target === e.currentTarget && pendingId() === null) {
                setConfirmId(null);
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-rollback-title"
          >
            <div class="bg-popover border border-border rounded-lg w-[420px] max-w-[90vw] shadow-xl animate-[slideUp_0.2s_ease-out] p-5">
              <h2
                id="confirm-rollback-title"
                class="m-0 text-base font-semibold text-foreground mb-2"
              >
                Roll back to v{rev().version}?
              </h2>
              <p class="m-0 text-[13px] text-muted-foreground leading-relaxed">
                The current configuration becomes a new revision; you can roll
                forward by selecting it from this list.
              </p>
              <Show when={error()}>
                <div
                  class="mt-3 py-2 px-3 bg-destructive/20 text-destructive rounded text-[12.5px]"
                  role="alert"
                >
                  {error()}
                </div>
              </Show>
              <div class="flex justify-end gap-2 mt-5">
                <button
                  type="button"
                  class="py-2 px-4 rounded text-[13px] font-medium bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50"
                  onClick={() => setConfirmId(null)}
                  disabled={pendingId() !== null}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="py-2 px-4 rounded text-[13px] font-medium bg-primary text-primary-foreground border border-primary hover:bg-primary/90 disabled:opacity-50"
                  onClick={() => handleRollback(rev().revisionId)}
                  disabled={pendingId() !== null}
                >
                  {pendingId() === rev().revisionId
                    ? "Rolling back..."
                    : "Roll back"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};
