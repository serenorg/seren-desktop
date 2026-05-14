// ABOUTME: In-app confirmation dialog used by catalog destructive actions.
// ABOUTME: Replaces window.confirm so the UX matches CatalogEntryModal styling.

import {
  type Component,
  createEffect,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: Component<ConfirmDialogProps> = (props) => {
  let confirmButton: HTMLButtonElement | undefined;
  let cancelButton: HTMLButtonElement | undefined;
  let lastFocusedBeforeOpen: HTMLElement | null = null;
  const titleId = `confirm-dialog-title-${createUniqueId()}`;
  const messageId = `confirm-dialog-message-${createUniqueId()}`;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!props.open) return;
    if (event.key === "Escape" && !props.pending) {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    // Trap focus between the two buttons so keyboard users cannot tab to
    // background controls while the dialog is open.
    if (!cancelButton || !confirmButton) return;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (active === cancelButton || active === document.body) {
        event.preventDefault();
        confirmButton.focus();
      }
    } else if (active === confirmButton || active === document.body) {
      event.preventDefault();
      cancelButton.focus();
    }
  };

  // Capture pre-open focus and apply the safest default focus on each open;
  // restore focus on each close so opening and closing repeatedly does not
  // leak focus to body. Cancel is the default focus for destructive actions
  // so an accidental Enter does not delete data; confirm is the default for
  // benign actions.
  createEffect((previouslyOpen: boolean) => {
    const isOpen = props.open;
    if (isOpen && !previouslyOpen) {
      lastFocusedBeforeOpen = document.activeElement as HTMLElement | null;
      queueMicrotask(() => {
        if (!props.open) return;
        if (props.destructive) cancelButton?.focus();
        else confirmButton?.focus();
      });
    } else if (!isOpen && previouslyOpen) {
      lastFocusedBeforeOpen?.focus?.();
      lastFocusedBeforeOpen = null;
    }
    return isOpen;
  }, false);

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
      // Restore focus if the component unmounts while still open.
      lastFocusedBeforeOpen?.focus?.();
    });
  });

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1100] animate-[fadeIn_0.15s_ease-out]"
        onClick={(event) => {
          if (event.target === event.currentTarget && !props.pending) {
            props.onCancel();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <div class="bg-popover border border-border rounded-lg w-[420px] max-w-[92vw] shadow-xl animate-[slideUp_0.2s_ease-out]">
          <header class="px-5 py-4 border-b border-border">
            <h2
              id={titleId}
              class="m-0 text-base font-semibold text-foreground"
            >
              {props.title}
            </h2>
          </header>
          <div class="px-5 py-4">
            <p id={messageId} class="m-0 text-[13px] text-muted-foreground">
              {props.message}
            </p>
          </div>
          <footer class="flex justify-end gap-2 py-3 px-5 border-t border-border">
            <button
              type="button"
              ref={cancelButton}
              class="py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={props.onCancel}
              disabled={props.pending}
            >
              {props.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              ref={confirmButton}
              class={
                props.destructive
                  ? "py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-red-600 text-white border border-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  : "py-2 px-4 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 bg-primary text-primary-foreground border border-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              }
              onClick={props.onConfirm}
              disabled={props.pending}
            >
              {props.pending ? "Working..." : (props.confirmLabel ?? "Confirm")}
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
};
