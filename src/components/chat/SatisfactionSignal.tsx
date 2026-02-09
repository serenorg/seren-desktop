// ABOUTME: Thumbs up/down satisfaction signal for assistant messages.
// ABOUTME: Sends eval signals to the orchestrator for trust graduation.

import { invoke } from "@tauri-apps/api/core";
import type { Component } from "solid-js";
import { createSignal, Show } from "solid-js";
import { getToken } from "@/lib/tauri-bridge";

interface SatisfactionSignalProps {
  messageId: string;
  initialSignal?: number | null;
}

export const SatisfactionSignal: Component<SatisfactionSignalProps> = (
  props,
) => {
  const [signal, setSignal] = createSignal<number | null>(
    props.initialSignal ?? null,
  );

  const submit = async (satisfaction: number) => {
    if (signal() === satisfaction) {
      setSignal(null);
      return;
    }

    setSignal(satisfaction);
    try {
      const authToken = (await getToken()) ?? "";
      await invoke("submit_eval_signal", {
        messageId: props.messageId,
        satisfaction,
        authToken,
      });
    } catch (error) {
      console.warn("[SatisfactionSignal] Failed to submit:", error);
    }
  };

  return (
    <div class="inline-flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150">
      <Show when={signal() === null || signal() === 1}>
        <button
          type="button"
          class={`bg-transparent border-none cursor-pointer p-0.5 rounded transition-colors ${
            signal() === 1
              ? "text-[#3fb950]"
              : "text-[#484f58] hover:text-[#3fb950]"
          }`}
          onClick={() => submit(1)}
          title="Helpful"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
          </svg>
        </button>
      </Show>
      <Show when={signal() === null || signal() === 0}>
        <button
          type="button"
          class={`bg-transparent border-none cursor-pointer p-0.5 rounded transition-colors ${
            signal() === 0
              ? "text-[#f85149]"
              : "text-[#484f58] hover:text-[#f85149]"
          }`}
          onClick={() => submit(0)}
          title="Not helpful"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z" />
          </svg>
        </button>
      </Show>
    </div>
  );
};
