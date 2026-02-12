// ABOUTME: Autocomplete popup for slash commands in chat/agent input.
// ABOUTME: Shows matching commands as user types "/" prefix.

import { For, Show } from "solid-js";
import { getCompletions } from "@/lib/commands/parser";
import type { SlashCommand } from "@/lib/commands/types";

interface SlashCommandPopupProps {
  input: string;
  panel: "chat" | "agent";
  onSelect: (command: SlashCommand) => void;
  /** Index of the currently highlighted item (controlled by parent for keyboard nav) */
  selectedIndex: number;
}

export function SlashCommandPopup(props: SlashCommandPopupProps) {
  const matches = () => {
    const result = getCompletions(props.input, props.panel);
    // Debug logging to trace slash command matching
    if (props.input.startsWith("/")) {
      console.log(
        "[SlashCommandPopup] Input:",
        props.input,
        "Panel:",
        props.panel,
        "Matches:",
        result.length,
        result.map((c) => c.name),
      );
    }
    return result;
  };

  return (
    <Show when={matches().length > 0}>
      <div class="absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.05)] overflow-hidden z-[999] max-h-[300px] overflow-y-auto">
        <For each={matches()}>
          {(cmd, i) => (
            <button
              type="button"
              class="flex items-center gap-2.5 w-full px-3 py-2 bg-transparent border-none cursor-pointer text-left text-[13px] text-foreground transition-colors duration-100"
              classList={{
                "bg-accent": i() === props.selectedIndex,
              }}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent input blur
                props.onSelect(cmd);
              }}
            >
              <span class="font-semibold text-primary shrink-0 font-mono">
                /{cmd.name}
              </span>
              <span class="text-muted-foreground flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {cmd.description}
              </span>
              {cmd.argHint && (
                <span class="text-muted-foreground text-[11px] italic opacity-70 shrink-0">
                  {cmd.argHint}
                </span>
              )}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
