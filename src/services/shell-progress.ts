// ABOUTME: Bridges `shell://progress` Tauri events into the conversation store.
// ABOUTME: Backs the Tail / LIVE pane for the in-process Bash tool (#2100).

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { conversationStore } from "@/stores/conversation.store";

interface ShellProgressPayload {
  toolCallId: string;
  chunk: string;
  isStderr: boolean;
}

let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;

/**
 * Subscribe to streaming Bash output and append each chunk to the matching
 * tool_call message's `toolCall.partialResult`. Idempotent — repeat calls
 * are no-ops while the subscription is already active. Awaitable so callers
 * can defer to the listener being attached before triggering a streaming
 * command.
 */
export async function startShellProgressListener(): Promise<void> {
  if (unlisten) return;
  if (starting) return starting;
  starting = (async () => {
    try {
      unlisten = await listen<ShellProgressPayload>(
        "shell://progress",
        (event) => {
          const { toolCallId, chunk } = event.payload;
          if (!toolCallId || !chunk) return;
          conversationStore.appendToolCallPartial(toolCallId, chunk);
        },
      );
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** Tear down the subscription. Test/teardown helper. */
export async function stopShellProgressListener(): Promise<void> {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
