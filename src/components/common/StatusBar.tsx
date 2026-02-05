// ABOUTME: Application status bar at the bottom.
// ABOUTME: Displays status messages, MCP state, autocomplete status, and connection state.

import type { Component } from "solid-js";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { AutocompleteStatus } from "./AutocompleteStatus";
import { McpStatusIndicator } from "./McpStatusIndicator";

interface StatusBarProps {
  message?: string;
}

export const StatusBar: Component<StatusBarProps> = (props) => {
  return (
    <footer class="h-6 px-3 bg-primary flex items-center justify-between">
      <span class="text-xs text-primary-foreground">
        {props.message || "Ready"}
      </span>
      <div class="flex items-center gap-2 [&_.mcp-status-indicator]:text-primary-foreground [&_.status-label]:text-primary-foreground/85">
        {/* MCP indicator moved to left side to avoid accidental clicks near Send button */}
        <McpStatusIndicator />
        <span class="w-px h-3.5 bg-primary-foreground/20" />
        <AutocompleteStatus
          state={autocompleteStore.state}
          errorMessage={autocompleteStore.errorMessage ?? undefined}
          onToggle={autocompleteStore.toggle}
        />
      </div>
    </footer>
  );
};
