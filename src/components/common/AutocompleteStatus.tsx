// ABOUTME: Status indicator for AI autocomplete feature in the status bar.
// ABOUTME: Shows Active (green), Loading (yellow), Disabled (gray), Error (red) states.

import { type Component, Show } from "solid-js";

export type AutocompleteState = "active" | "loading" | "disabled" | "error";

interface AutocompleteStatusProps {
  state: AutocompleteState;
  errorMessage?: string;
  onToggle?: () => void;
}

const STATE_CONFIG: Record<
  AutocompleteState,
  { label: string; icon: string; colorClass: string }
> = {
  active: { label: "AI Active", icon: "●", colorClass: "text-green-400" },
  loading: { label: "AI Loading", icon: "◐", colorClass: "text-yellow-400" },
  disabled: { label: "AI Disabled", icon: "○", colorClass: "text-gray-500" },
  error: { label: "AI Error", icon: "⚠", colorClass: "text-red-500" },
};

export const AutocompleteStatus: Component<AutocompleteStatusProps> = (
  props,
) => {
  const config = () => STATE_CONFIG[props.state];

  return (
    <button
      class={`inline-flex items-center gap-1 py-0.5 px-2 border-none rounded bg-transparent text-xs cursor-pointer transition-colors duration-150 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1 ${config().colorClass}`}
      onClick={() => props.onToggle?.()}
      title={props.errorMessage || config().label}
      aria-label={config().label}
    >
      <span
        class={`text-[10px] leading-none ${props.state === "loading" ? "animate-pulse" : ""}`}
      >
        {config().icon}
      </span>
      <Show when={props.state === "loading"}>
        <span class="w-2.5 h-2.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
      </Show>
      <span class="font-medium whitespace-nowrap">{config().label}</span>
    </button>
  );
};
