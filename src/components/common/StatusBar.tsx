// ABOUTME: Application status bar at the bottom.
// ABOUTME: Displays status messages, MCP state, autocomplete status, and connection state.

import type { Component } from "solid-js";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { AutocompleteStatus } from "./AutocompleteStatus";
import { McpStatusIndicator } from "./McpStatusIndicator";
import { UpdateIndicator } from "./UpdateIndicator";
import "./StatusBar.css";

interface StatusBarProps {
  message?: string;
}

export const StatusBar: Component<StatusBarProps> = (props) => {
  return (
    <footer class="status-bar">
      <span class="status-message">{props.message || "Ready"}</span>
      <div class="status-bar-right">
        <AutocompleteStatus
          state={autocompleteStore.state}
          errorMessage={autocompleteStore.errorMessage ?? undefined}
          onToggle={autocompleteStore.toggle}
        />
        <UpdateIndicator />
        <McpStatusIndicator />
      </div>
    </footer>
  );
};
