// ABOUTME: Autocomplete popup for slash commands in chat/agent input.
// ABOUTME: Shows matching commands as user types "/" prefix.

import { For, Show } from "solid-js";
import { getCompletions } from "@/lib/commands/parser";
import type { SlashCommand } from "@/lib/commands/types";
import "./SlashCommandPopup.css";

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
      <div class="slash-popup">
        <For each={matches()}>
          {(cmd, i) => (
            <button
              type="button"
              class="slash-popup-item"
              classList={{
                "slash-popup-item--active": i() === props.selectedIndex,
              }}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent input blur
                props.onSelect(cmd);
              }}
            >
              <span class="slash-popup-name">/{cmd.name}</span>
              <span class="slash-popup-desc">{cmd.description}</span>
              {cmd.argHint && (
                <span class="slash-popup-hint">{cmd.argHint}</span>
              )}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
