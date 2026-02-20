// ABOUTME: Application status bar at the bottom.
// ABOUTME: Displays status messages, MCP state, autocomplete status, and connection state.

import { createMemo, type Component } from "solid-js";
import { acpStore } from "@/stores/acp.store";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { AutocompleteStatus } from "./AutocompleteStatus";
import { McpStatusIndicator } from "./McpStatusIndicator";

interface StatusBarProps {
  message?: string;
}

export const StatusBar: Component<StatusBarProps> = (props) => {
  const agentStatusText = createMemo(() => {
    const session = acpStore.activeSession;
    if (!session || session.info.status !== "prompting") return null;
    const running = session.messages
      .filter(
        (m) =>
          m.type === "tool" &&
          ["running", "pending", "in_progress"].includes(
            m.toolCall?.status ?? "",
          ),
      )
      .at(-1);
    return running ? `Codex: ${running.content}` : "Working...";
  });

  return (
    <footer class="h-6 px-3 bg-surface-0 border-t border-border flex items-center justify-between">
      <span class="text-xs text-muted-foreground">
        {agentStatusText() ?? props.message ?? "Ready"}
      </span>
      <div class="flex items-center gap-2 [&_.status-label]:text-muted-foreground">
        {/* MCP indicator moved to left side to avoid accidental clicks near Send button */}
        <McpStatusIndicator />
        <span class="w-px h-3.5 bg-border" />
        <AutocompleteStatus
          state={autocompleteStore.state}
          errorMessage={autocompleteStore.errorMessage ?? undefined}
          onToggle={autocompleteStore.toggle}
        />
      </div>
    </footer>
  );
};
