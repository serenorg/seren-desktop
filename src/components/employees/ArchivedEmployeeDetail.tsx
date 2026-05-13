// ABOUTME: Read-only detail pane for archived virtual employees.
// ABOUTME: Shows the snapshot, past chat threads, and a permanent-purge action.

import {
  type Component,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { gradientFor, initialFor } from "@/lib/employees/avatar";
import type { ArchivedEmployee } from "@/lib/employees/types";
import { employeesArchiveStore } from "@/services/employees-archive";
import { conversationStore } from "@/stores/conversation.store";
import { employeeStore } from "@/stores/employees.store";
import { threadStore } from "@/stores/thread.store";

interface ArchivedEmployeeDetailProps {
  employeeId: string;
  onClose: () => void;
}

function modeLabel(mode: ArchivedEmployee["mode"]): string {
  if (mode === "always_on") return "On-call";
  if (mode === "cron") return "Scheduled";
  return "On-demand";
}

function formatArchivedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "earlier";
  return d.toLocaleString();
}

const Avatar: Component<{ name: string; seed: string }> = (props) => (
  <div
    class="flex items-center justify-center text-white font-bold flex-none rounded-lg grayscale"
    style={{
      width: "44px",
      height: "44px",
      background: gradientFor(props.seed),
      "font-size": "18px",
    }}
    aria-hidden="true"
  >
    {initialFor(props.name)}
  </div>
);

export const ArchivedEmployeeDetail: Component<ArchivedEmployeeDetailProps> = (
  props,
) => {
  const [confirmPurge, setConfirmPurge] = createSignal(false);
  const [purging, setPurging] = createSignal(false);
  const [purgeError, setPurgeError] = createSignal<string | null>(null);

  const employee = createMemo<ArchivedEmployee | undefined>(() =>
    employeeStore.archivedById(props.employeeId),
  );

  const threads = createMemo(() => {
    const map = threadStore.threadsByEmployee;
    return map[props.employeeId] ?? [];
  });

  let closeButtonRef: HTMLButtonElement | undefined;

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (confirmPurge()) {
      if (purging()) return;
      event.preventDefault();
      setConfirmPurge(false);
      return;
    }
    event.preventDefault();
    props.onClose();
  };

  onMount(() => {
    document.addEventListener("keydown", handleDocumentKeydown);
    // Park initial keyboard focus on the Close button so screen-reader and
    // keyboard users land on a usable control. Matches the run/revisions
    // modal pattern.
    requestAnimationFrame(() => closeButtonRef?.focus());
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  const handlePurge = async () => {
    if (purging()) return;
    setPurgeError(null);
    setPurging(true);
    try {
      await employeesArchiveStore.cascadeDeleteChats(props.employeeId);
      conversationStore.forgetByEmployee(props.employeeId);
      await employeesArchiveStore.remove(props.employeeId);
      employeeStore.removeArchived(props.employeeId);
      setConfirmPurge(false);
      props.onClose();
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : String(err));
    } finally {
      setPurging(false);
    }
  };

  return (
    <Show
      when={employee()}
      fallback={
        <div class="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
          <p class="text-[13px]">
            This archived employee is no longer available.
          </p>
          <button
            type="button"
            class="text-[12px] text-primary hover:text-primary/80 underline underline-offset-2 bg-transparent border-none p-0 cursor-pointer"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
      }
    >
      {(emp) => (
        <div class="flex flex-col h-full overflow-hidden">
          <header class="flex items-center gap-3 px-6 py-4 border-b border-border">
            <Avatar name={emp().name} seed={emp().avatarSeed} />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h1 class="m-0 text-[18px] font-semibold text-foreground/80 line-through decoration-muted-foreground/40 truncate">
                  {emp().name}
                </h1>
                <span class="inline-flex items-center px-2 py-0.5 rounded-full border border-muted-foreground/30 bg-muted/30 text-muted-foreground text-[10.5px] font-medium">
                  Archived
                </span>
              </div>
              <div class="text-[12px] text-muted-foreground mt-1 truncate">
                {modeLabel(emp().mode)} · Deleted{" "}
                {formatArchivedAt(emp().archivedAt)}
              </div>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              class="text-[12px] text-muted-foreground hover:text-foreground rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              onClick={props.onClose}
              aria-label="Close archived employee"
            >
              Close
            </button>
          </header>

          <div class="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
            <section>
              <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-2">
                Past chats
              </div>
              <Show
                when={threads().length > 0}
                fallback={
                  <div class="text-[12.5px] text-muted-foreground italic">
                    No chats with this employee.
                  </div>
                }
              >
                <ul class="m-0 p-0 list-none flex flex-col gap-1">
                  <For each={threads()}>
                    {(thread) => (
                      <li>
                        <button
                          type="button"
                          class="flex items-center w-full text-left bg-transparent border border-border/60 rounded-md px-3 py-2 hover:bg-surface-2 hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 transition-colors"
                          onClick={() => {
                            threadStore.selectThread(thread.id, thread.kind);
                            props.onClose();
                          }}
                          title={thread.title}
                        >
                          <span class="text-[13px] text-foreground truncate">
                            {thread.title}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>

            <section class="border border-red-500/30 rounded-md p-4 bg-red-500/5">
              <div class="text-[12.5px] font-semibold text-red-300 mb-1">
                Remove permanently
              </div>
              <p class="m-0 text-[12.5px] text-muted-foreground leading-relaxed">
                Drops {emp().name} from your sidebar and permanently deletes all
                chats with them. This cannot be undone.
              </p>
              <button
                type="button"
                class="mt-3 py-1.5 px-3 rounded text-[12.5px] font-medium border border-red-500/50 text-red-300 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/60"
                onClick={() => setConfirmPurge(true)}
              >
                Remove permanently
              </button>
            </section>
          </div>

          <Show when={confirmPurge()}>
            <div
              class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
              onClick={(e) => {
                if (e.target === e.currentTarget && !purging()) {
                  setConfirmPurge(false);
                }
              }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-purge-title"
            >
              <div class="bg-popover border border-border rounded-lg w-[420px] max-w-[90vw] shadow-xl animate-[slideUp_0.2s_ease-out] p-5">
                <h2
                  id="confirm-purge-title"
                  class="m-0 text-base font-semibold text-foreground mb-2"
                >
                  Permanently remove {emp().name}?
                </h2>
                <p class="m-0 text-[13px] text-muted-foreground leading-relaxed">
                  The archived row and {threads().length} past chat
                  {threads().length === 1 ? "" : "s"} will be deleted from your
                  sidebar. This cannot be undone.
                </p>
                <Show when={purgeError()}>
                  <div
                    class="mt-3 py-2 px-3 bg-destructive/20 text-destructive rounded text-[12.5px]"
                    role="alert"
                  >
                    {purgeError()}
                  </div>
                </Show>
                <div class="flex justify-end gap-2 mt-5">
                  <button
                    type="button"
                    class="py-2 px-4 rounded text-[13px] font-medium bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                    onClick={() => setConfirmPurge(false)}
                    disabled={purging()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="py-2 px-4 rounded text-[13px] font-medium bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-300"
                    onClick={handlePurge}
                    disabled={purging()}
                  >
                    {purging() ? "Removing..." : "Remove permanently"}
                  </button>
                </div>
              </div>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
};
