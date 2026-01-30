// ABOUTME: Reactive state for Moltbot process status, connected channels, and per-channel config.
// ABOUTME: Communicates with Rust backend via Tauri invoke() calls and listens for events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore } from "solid-js/store";

// ============================================================================
// Types
// ============================================================================

export type ProcessStatus =
  | "stopped"
  | "starting"
  | "running"
  | "crashed"
  | "restarting";

export type ChannelStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "error";

export type AgentMode = "seren" | "moltbot";

export type TrustLevel = "auto" | "mention-only" | "approval-required";

export interface MoltbotChannel {
  id: string;
  platform: string;
  displayName: string;
  status: ChannelStatus;
  agentMode: AgentMode;
  trustLevel: TrustLevel;
  errorMessage?: string;
}

interface MoltbotState {
  processStatus: ProcessStatus;
  channels: MoltbotChannel[];
  setupComplete: boolean;
  port: number | null;
  uptimeSecs: number | null;
}

// ============================================================================
// Store
// ============================================================================

const [state, setState] = createStore<MoltbotState>({
  processStatus: "stopped",
  channels: [],
  setupComplete: false,
  port: null,
  uptimeSecs: null,
});

let unlistenStatus: UnlistenFn | null = null;
let unlistenChannel: UnlistenFn | null = null;
let unlistenMessage: UnlistenFn | null = null;

// ============================================================================
// Event Listeners
// ============================================================================

async function setupEventListeners() {
  unlistenStatus = await listen<{ status: ProcessStatus }>(
    "moltbot://status-changed",
    (event) => {
      setState("processStatus", event.payload.status);
    },
  );

  unlistenChannel = await listen<{
    type: string;
    id?: string;
    platform?: string;
    status?: string;
  }>("moltbot://channel-event", (event) => {
    const { type: eventType, id } = event.payload;

    if (!id) return;

    const channelIndex = state.channels.findIndex((c) => c.id === id);

    if (
      eventType === "channel:connected" ||
      eventType === "channel:disconnected" ||
      eventType === "channel:error"
    ) {
      const newStatus: ChannelStatus =
        eventType === "channel:connected"
          ? "connected"
          : eventType === "channel:error"
            ? "error"
            : "disconnected";

      if (channelIndex >= 0) {
        setState("channels", channelIndex, "status", newStatus);
      }
    }
  });

  unlistenMessage = await listen("moltbot://message-received", (_event) => {
    // Message events are handled by the notification system (Phase 6)
    // and agent routing (Phase 4). No store update needed here.
  });
}

function teardownEventListeners() {
  unlistenStatus?.();
  unlistenChannel?.();
  unlistenMessage?.();
  unlistenStatus = null;
  unlistenChannel = null;
  unlistenMessage = null;
}

// ============================================================================
// Default Trust Levels
// ============================================================================

/** Personal messaging platforms default to approval-required for safety. */
function defaultTrustLevel(platform: string): TrustLevel {
  switch (platform) {
    case "whatsapp":
    case "signal":
    case "imessage":
    case "bluebubbles":
      return "approval-required";
    case "telegram":
    case "discord":
    case "slack":
    case "mattermost":
    case "googlechat":
    case "msteams":
      return "auto";
    default:
      return "approval-required";
  }
}

// ============================================================================
// Actions
// ============================================================================

export const moltbotStore = {
  // --- Getters ---

  get processStatus() {
    return state.processStatus;
  },
  get channels() {
    return state.channels;
  },
  get setupComplete() {
    return state.setupComplete;
  },
  get isRunning() {
    return state.processStatus === "running";
  },
  get connectedChannelCount() {
    return state.channels.filter((c) => c.status === "connected").length;
  },

  // --- Lifecycle ---

  async init() {
    await setupEventListeners();
    // Load setupComplete flag from Tauri store
    try {
      const value = await invoke<string | null>("get_setting", {
        store: "moltbot.json",
        key: "setup_complete",
      });
      setState("setupComplete", value === "true");
    } catch {
      // Store doesn't exist yet — first run
      setState("setupComplete", false);
    }
  },

  destroy() {
    teardownEventListeners();
  },

  // --- Process Management ---

  async start() {
    try {
      await invoke("moltbot_start");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "already running" is not an error — treat it as success
      if (msg.toLowerCase().includes("already running")) {
        console.log("[Moltbot Store] Moltbot already running, skipping start");
        return;
      }
      console.error("[Moltbot Store] Failed to start:", e);
      throw e;
    }
  },

  async stop() {
    try {
      await invoke("moltbot_stop");
    } catch (e) {
      console.error("[Moltbot Store] Failed to stop:", e);
      throw e;
    }
  },

  async restart() {
    try {
      await invoke("moltbot_restart");
    } catch (e) {
      console.error("[Moltbot Store] Failed to restart:", e);
      throw e;
    }
  },

  async refreshStatus() {
    try {
      const info = await invoke<{
        processStatus: ProcessStatus;
        port: number | null;
        channels: MoltbotChannel[];
        uptimeSecs: number | null;
      }>("moltbot_status");
      setState("processStatus", info.processStatus);
      setState("port", info.port);
      setState("uptimeSecs", info.uptimeSecs);
    } catch (e) {
      console.error("[Moltbot Store] Failed to get status:", e);
    }
  },

  // --- Channel Management ---

  async refreshChannels() {
    try {
      const channels = await invoke<MoltbotChannel[]>("moltbot_list_channels");
      // Preserve local agentMode and trustLevel settings
      const merged = channels.map((ch) => {
        const existing = state.channels.find((c) => c.id === ch.id);
        return {
          ...ch,
          agentMode: existing?.agentMode ?? "seren",
          trustLevel: existing?.trustLevel ?? defaultTrustLevel(ch.platform),
        };
      });
      setState("channels", merged);

      // Sync default trust levels to backend for any channels it doesn't know about yet
      for (const ch of merged) {
        invoke("moltbot_set_trust", {
          channelId: ch.id,
          trustLevel: ch.trustLevel,
          agentMode: ch.agentMode,
        }).catch((e) => {
          console.error(
            "[Moltbot Store] Failed to sync trust for channel:",
            ch.id,
            e,
          );
        });
      }
    } catch (e) {
      console.error("[Moltbot Store] Failed to list channels:", e);
    }
  },

  configureChannel(
    channelId: string,
    config: { agentMode?: AgentMode; trustLevel?: TrustLevel },
  ) {
    const index = state.channels.findIndex((c) => c.id === channelId);
    if (index < 0) return;

    if (config.agentMode !== undefined) {
      setState("channels", index, "agentMode", config.agentMode);
    }
    if (config.trustLevel !== undefined) {
      setState("channels", index, "trustLevel", config.trustLevel);
    }

    // Sync trust settings to Rust backend for enforcement
    const channel = state.channels[index];
    invoke("moltbot_set_trust", {
      channelId,
      trustLevel: channel.trustLevel,
      agentMode: channel.agentMode,
    }).catch((e) => {
      console.error("[Moltbot Store] Failed to sync trust settings:", e);
    });
  },

  // --- Messaging ---

  async connectChannel(platform: string, credentials: Record<string, string>) {
    // Auto-start moltbot if not running
    if (state.processStatus !== "running") {
      console.log("[Moltbot Store] Moltbot not running, auto-starting before channel connect...");
      await moltbotStore.start();
      // Wait briefly for the gateway to be ready
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("[Moltbot Store] Connecting channel:", platform);
    const result = await invoke<Record<string, unknown>>("moltbot_connect_channel", {
      platform,
      credentials,
    });
    console.log("[Moltbot Store] Channel connect result:", result);
    return result;
  },

  async getQrCode(platform: string) {
    return invoke<string>("moltbot_get_qr", { platform });
  },

  async disconnectChannel(channelId: string) {
    await invoke("moltbot_disconnect_channel", { channelId });
    // Remove from local state
    setState(
      "channels",
      state.channels.filter((c) => c.id !== channelId),
    );
  },

  async sendMessage(channel: string, to: string, message: string) {
    return invoke<string>("moltbot_send", {
      channel,
      to,
      message,
    });
  },

  // --- Setup ---

  async completeSetup() {
    setState("setupComplete", true);
    try {
      await invoke("set_setting", {
        store: "moltbot.json",
        key: "setup_complete",
        value: "true",
      });
    } catch (e) {
      console.error("[Moltbot Store] Failed to save setup state:", e);
    }
  },

  resetSetup() {
    setState("setupComplete", false);
  },
};
