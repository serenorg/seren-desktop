// ABOUTME: Compact OpenClaw status indicator for the sidebar/editor panel.
// ABOUTME: Shows running state with channel count, clickable to open settings.

import { type Component, Show } from "solid-js";
import { openclawStore } from "@/stores/openclaw.store";

export const OpenClawStatus: Component = () => {
  const statusColor = () => {
    switch (openclawStore.processStatus) {
      case "running":
        return "#22c55e";
      case "starting":
      case "restarting":
        return "#eab308";
      case "crashed":
        return "#ef4444";
      default:
        return "#94a3b8";
    }
  };

  const label = () => {
    if (!openclawStore.setupComplete) return null;
    if (openclawStore.isRunning) {
      const count = openclawStore.connectedChannelCount;
      return count > 0 ? `OpenClaw (${count})` : "OpenClaw";
    }
    if (openclawStore.processStatus === "crashed") return "OpenClaw crashed";
    return null;
  };

  return (
    <Show when={label()}>
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 py-1 bg-transparent border-none rounded text-[0.75rem] text-muted-foreground cursor-pointer hover:bg-[rgba(148,163,184,0.1)] transition-all duration-150"
        onClick={() =>
          window.dispatchEvent(new CustomEvent("seren:open-settings"))
        }
        title="Open OpenClaw settings"
      >
        <span
          class="w-1.5 h-1.5 rounded-full inline-block"
          style={{ "background-color": statusColor() }}
        />
        <span>{label()}</span>
      </button>
    </Show>
  );
};

export default OpenClawStatus;
