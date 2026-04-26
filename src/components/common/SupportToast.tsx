import { Show } from "solid-js";
import { dismissSupportToast, supportToastVisible } from "@/lib/support/hook";

export function SupportToast() {
  return (
    <Show when={supportToastVisible()}>
      <div class="fixed right-4 bottom-4 z-[10000] flex items-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-3 text-sm text-foreground shadow-lg">
        <span>Bug detected - Seren is on it.</span>
        <button
          type="button"
          class="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-surface-3 hover:text-foreground"
          onClick={dismissSupportToast}
        >
          OK
        </button>
      </div>
    </Show>
  );
}
