// ABOUTME: Toggle switch for enabling/disabling Chain of Thought display.
// ABOUTME: Persists user preference via settings store.

import type { Component } from "solid-js";
import { settingsStore } from "@/stores/settings.store";

export const ThinkingToggle: Component = () => {
  const isEnabled = () => settingsStore.get("chatShowThinking");

  const toggle = () => {
    settingsStore.set("chatShowThinking", !isEnabled());
  };

  return (
    <button
      type="button"
      class={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-all border ${
        isEnabled()
          ? "bg-[#58a6ff]/10 border-[#58a6ff]/30 text-[#58a6ff]"
          : "bg-transparent border-[#30363d] text-[#8b949e] hover:border-[#484f58] hover:text-[#e6edf3]"
      }`}
      onClick={toggle}
      title={isEnabled() ? "Hide AI thinking" : "Show AI thinking"}
    >
      <svg
        class="w-3.5 h-3.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
        />
      </svg>
      <span>Thinking</span>
    </button>
  );
};
