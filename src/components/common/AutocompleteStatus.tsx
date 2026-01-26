// ABOUTME: Status indicator for AI autocomplete feature in the status bar.
// ABOUTME: Shows Active (green), Loading (yellow), Disabled (gray), Error (red) states.

import { Component, Show } from "solid-js";
import "./AutocompleteStatus.css";

export type AutocompleteState = "active" | "loading" | "disabled" | "error";

interface AutocompleteStatusProps {
  state: AutocompleteState;
  errorMessage?: string;
  onToggle?: () => void;
}

const STATE_CONFIG: Record<AutocompleteState, { label: string; icon: string }> = {
  active: { label: "AI Active", icon: "●" },
  loading: { label: "AI Loading", icon: "◐" },
  disabled: { label: "AI Disabled", icon: "○" },
  error: { label: "AI Error", icon: "⚠" },
};

export const AutocompleteStatus: Component<AutocompleteStatusProps> = (props) => {
  const config = () => STATE_CONFIG[props.state];

  return (
    <button
      class={`autocomplete-status autocomplete-status--${props.state}`}
      onClick={() => props.onToggle?.()}
      title={props.errorMessage || config().label}
      aria-label={config().label}
    >
      <span class="autocomplete-status__icon">{config().icon}</span>
      <Show when={props.state === "loading"}>
        <span class="autocomplete-status__spinner" />
      </Show>
      <span class="autocomplete-status__label">{config().label}</span>
    </button>
  );
};
