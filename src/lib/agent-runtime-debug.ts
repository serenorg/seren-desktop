// ABOUTME: Debug switches for noisy AgentRuntime diagnostics.
// ABOUTME: Keeps high-volume runtime event logs opt-in instead of default console noise.

export const AGENT_RUNTIME_EVENT_DEBUG_KEY = "seren.debug.agentRuntimeEvents";

type DebugStorage = Pick<Storage, "getItem">;

function runtimeDebugStorage(): DebugStorage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isEnabled(value: string | null): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function shouldLogAgentRuntimeEvent(
  eventType: string,
  storage: DebugStorage | null = runtimeDebugStorage(),
): boolean {
  if (eventType === "messageChunk") return false;
  return isEnabled(storage?.getItem(AGENT_RUNTIME_EVENT_DEBUG_KEY) ?? null);
}
