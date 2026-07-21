// ABOUTME: Recovery card for CLI updates that could not be verified safely.
// ABOUTME: Offers a verified retry and an allowlisted official instructions link.

import { type Component, Show } from "solid-js";
import { agentStore } from "@/stores/agent.store";

function reasonLabel(reason: string): string {
  switch (reason) {
    case "installation_required":
      return "Installation required";
    case "integrity_failed":
      return "Download verification failed";
    case "self_update_failed":
      return "Update failed";
    case "verification_required":
      return "Updated CLI could not be verified";
    case "unresolved":
      return "CLI not found in a verifiable location";
    default:
      return "Update needs attention";
  }
}

export const CliUpdateActionCard: Component = () => (
  <Show when={agentStore.cliUpdateActionRequired} keyed>
    {(action) => (
      <div
        data-testid="cli-update-action-required"
        role="alert"
        class="mx-1 my-1 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-[11px] text-foreground shadow-sm"
      >
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-amber-300">
              {action.label} needs attention
            </div>
            <div class="mt-0.5 text-muted-foreground">
              {reasonLabel(action.reason)}. Seren kept the previous verified
              version.
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss CLI update action"
            class="border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => agentStore.dismissCliUpdateActionRequired()}
          >
            ×
          </button>
        </div>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            class="rounded-md border border-amber-500/35 bg-amber-500/15 px-2 py-1 font-medium text-amber-200 hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-60"
            disabled={action.retrying}
            onClick={() => void agentStore.retryCliUpdate()}
          >
            {action.retrying ? "Retrying…" : "Retry"}
          </button>
          <button
            type="button"
            class="rounded-md border border-border bg-surface-2 px-2 py-1 font-medium text-foreground hover:bg-surface-3"
            onClick={() => agentStore.openCliUpdateInstructions()}
          >
            Install instructions
          </button>
        </div>
      </div>
    )}
  </Show>
);
