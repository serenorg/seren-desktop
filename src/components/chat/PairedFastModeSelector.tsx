// ABOUTME: Role-scoped fast-mode toggle for paired Claude + Codex threads.
// ABOUTME: Renders only when that role reports a fast_mode option and model support.

import type { Component } from "solid-js";
import { Show } from "solid-js";
import type { PairedRole } from "@/services/providers";
import { type ActiveSession, agentStore } from "@/stores/agent.store";

interface Props {
  session: ActiveSession | null;
  pairedRole: PairedRole;
}

const ROLE_LABELS: Record<PairedRole, string> = {
  planner: "Planner fast",
  executor: "Executor fast",
};

export const PairedFastModeSelector: Component<Props> = (props) => {
  const roleStatus = () => props.session?.paired?.[props.pairedRole] ?? null;

  const availableModels = () => {
    const models = roleStatus()?.models?.availableModels;
    return Array.isArray(models) ? models : [];
  };

  const currentModelSupportsFastMode = () => {
    const id = roleStatus()?.models?.currentModelId;
    if (!id) return false;
    return (
      availableModels().find((model) => model.modelId === id)
        ?.supportsFastMode === true
    );
  };

  const configOptions = () => {
    const options = roleStatus()?.configOptions;
    return Array.isArray(options) ? options : [];
  };

  const option = () => {
    const fastModeOption =
      configOptions().find(
        (config) => config.id === "fast_mode" && config.type === "select",
      ) ?? null;
    return fastModeOption && currentModelSupportsFastMode()
      ? fastModeOption
      : null;
  };

  const isOn = () => option()?.currentValue === "on";

  const toggleFastMode = () => {
    if (!option()) return;
    void agentStore.setPairedConfigOption(
      props.pairedRole,
      "fast_mode",
      isOn() ? "off" : "on",
      props.session?.info.id,
    );
  };

  return (
    <Show when={option()}>
      <button
        type="button"
        class={`flex items-center gap-1.5 px-2 py-1 border rounded-md text-xs cursor-pointer transition-colors ${
          isOn()
            ? "bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
            : "bg-surface-2 border-surface-3 text-foreground hover:bg-surface-3"
        }`}
        aria-pressed={isOn()}
        title={isOn() ? "Disable fast mode" : "Enable fast mode"}
        onClick={toggleFastMode}
      >
        <svg
          class="w-3 h-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          role="img"
          aria-label="Fast mode"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M13 3L4 14h7l-1 7 9-11h-7l1-7z"
          />
        </svg>
        <span class="font-medium">{ROLE_LABELS[props.pairedRole]}</span>
      </button>
    </Show>
  );
};
