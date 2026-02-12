// ABOUTME: Settings tab for OpenClaw messaging integration — process control, channels, and config.
// ABOUTME: Renders as wizard on first visit, config panel after setup is complete.

import { type Component, createSignal, For, onMount, Show } from "solid-js";
import {
  type AgentMode,
  type OpenClawChannel,
  openclawStore,
  type TrustLevel,
} from "@/stores/openclaw.store";
import { OpenClawChannelConnect } from "./OpenClawChannelConnect";
import { OpenClawWizard } from "./OpenClawWizard";

export const OpenClawSettings: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const [isToggling, setIsToggling] = createSignal(false);
  const [showConnectModal, setShowConnectModal] = createSignal(false);

  onMount(() => {
    openclawStore.init();
  });

  const handleToggleProcess = async () => {
    setIsToggling(true);
    setError(null);
    try {
      if (openclawStore.isRunning) {
        await openclawStore.stop();
      } else {
        await openclawStore.start();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsToggling(false);
    }
  };

  const handleRestart = async () => {
    setIsToggling(true);
    setError(null);
    try {
      await openclawStore.restart();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsToggling(false);
    }
  };

  const handleRefreshChannels = async () => {
    try {
      await openclawStore.refreshChannels();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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

  const statusLabel = () => {
    switch (openclawStore.processStatus) {
      case "running":
        return "Running";
      case "starting":
        return "Starting...";
      case "restarting":
        return "Restarting...";
      case "crashed":
        return "Crashed";
      default:
        return "Stopped";
    }
  };

  return (
    <section>
      <Show
        when={openclawStore.setupComplete}
        fallback={
          <OpenClawWizard
            onComplete={() => {
              // Wizard sets setupComplete in the store
            }}
            onSkip={() => {
              // Don't set setupComplete — wizard will appear again next visit
            }}
          />
        }
      >
        <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">OpenClaw</h3>
        <p class="m-0 mb-6 text-muted-foreground leading-normal">
          AI-powered messaging across WhatsApp, Telegram, Signal, Discord, and
          more. OpenClaw routes messages to your AI agent.
        </p>

        {/* Status Bar */}
        <div class="flex items-center justify-between px-4 py-3 mb-4 bg-surface-3/60 border border-border-hover rounded-lg">
          <div class="flex items-center gap-3">
            <span
              class="w-2.5 h-2.5 rounded-full"
              style={{ "background-color": statusColor() }}
            />
            <span class="text-[0.9rem] text-foreground font-medium">
              {statusLabel()}
            </span>
            <Show when={openclawStore.connectedChannelCount > 0}>
              <span class="text-[0.8rem] text-muted-foreground">
                ({openclawStore.connectedChannelCount} channel
                {openclawStore.connectedChannelCount !== 1 ? "s" : ""})
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <Show when={openclawStore.isRunning}>
              <button
                type="button"
                class="px-3 py-1.5 bg-transparent border border-border-strong rounded-md text-[0.8rem] text-muted-foreground cursor-pointer transition-all duration-150 hover:bg-border"
                onClick={handleRestart}
                disabled={isToggling()}
              >
                Restart
              </button>
            </Show>
            <button
              type="button"
              class={`px-3 py-1.5 border-none rounded-md text-[0.8rem] text-white cursor-pointer transition-all duration-150 hover:opacity-80 ${
                openclawStore.isRunning ? "bg-destructive" : "bg-success"
              }`}
              onClick={handleToggleProcess}
              disabled={isToggling()}
            >
              {isToggling()
                ? "..."
                : openclawStore.isRunning
                  ? "Stop"
                  : "Start"}
            </button>
          </div>
        </div>

        {/* Error Display */}
        <Show when={error()}>
          <div class="px-4 py-3 mb-4 bg-destructive/10 border border-destructive/30 rounded-lg text-[0.85rem] text-destructive">
            {error()}
          </div>
        </Show>

        {/* Connected Channels */}
        <Show
          when={openclawStore.channels.length > 0}
          fallback={
            <div class="text-center py-10 px-6 text-muted-foreground">
              <span class="text-[2.5rem] block mb-3 opacity-60">🦞</span>
              <p class="m-0">No channels connected</p>
              <p class="m-0 mt-2 text-[0.85rem] text-muted-foreground">
                Start OpenClaw and connect your first messaging channel.
              </p>
              <Show when={openclawStore.isRunning}>
                <button
                  type="button"
                  class="mt-4 px-4 py-2 bg-accent border-none rounded-md text-white text-[0.85rem] cursor-pointer transition-all duration-150 hover:opacity-80"
                  onClick={handleRefreshChannels}
                >
                  Refresh Channels
                </button>
              </Show>
            </div>
          }
        >
          <h4 class="m-0 mb-3 text-[1rem] font-semibold text-foreground">
            Connected Channels
          </h4>
          <div class="flex flex-col gap-2 mb-6">
            <For each={openclawStore.channels}>
              {(channel) => (
                <ChannelRow
                  channel={channel}
                  onConfigChange={(config) =>
                    openclawStore.configureChannel(channel.id, config)
                  }
                />
              )}
            </For>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 bg-accent border-none rounded-md text-[0.8rem] text-white cursor-pointer transition-all duration-150 hover:opacity-80"
              onClick={() => setShowConnectModal(true)}
            >
              Connect Channel
            </button>
            <button
              type="button"
              class="px-3 py-1.5 bg-transparent border border-border-strong rounded-md text-[0.8rem] text-muted-foreground cursor-pointer transition-all duration-150 hover:bg-border"
              onClick={handleRefreshChannels}
            >
              Refresh Channels
            </button>
          </div>
        </Show>

        {/* OpenClaw Dashboard */}
        <Show when={openclawStore.isRunning && openclawStore.port}>
          <div class="mt-6 pt-6 border-t border-border-medium">
            <h4 class="m-0 mb-2 text-[1rem] font-semibold text-foreground">
              OpenClaw Dashboard
            </h4>
            <p class="m-0 mb-3 text-[0.8rem] text-muted-foreground">
              Configure channel security policies, allowlists, and DM/group
              settings.
            </p>
            <div class="rounded-lg border border-border-hover overflow-hidden">
              <iframe
                src={`http://127.0.0.1:${openclawStore.port}/`}
                style="width: 100%; height: 600px; border: none; background: #1a1a2e;"
                title="OpenClaw Dashboard"
              />
            </div>
          </div>
        </Show>

        {/* Connect Channel Button (when no channels) */}
        <Show
          when={openclawStore.isRunning && openclawStore.channels.length === 0}
        >
          <button
            type="button"
            class="mt-2 px-4 py-2 bg-accent border-none rounded-md text-white text-[0.85rem] cursor-pointer transition-all duration-150 hover:opacity-80"
            onClick={() => setShowConnectModal(true)}
          >
            Connect a Channel
          </button>
        </Show>

        {/* Channel Connect Modal */}
        <Show when={showConnectModal()}>
          <OpenClawChannelConnect
            onClose={() => setShowConnectModal(false)}
            onConnected={() => {
              setShowConnectModal(false);
              openclawStore.refreshChannels();
            }}
          />
        </Show>
      </Show>
    </section>
  );
};

// ============================================================================
// Channel Row Component
// ============================================================================

const ChannelRow: Component<{
  channel: OpenClawChannel;
  onConfigChange: (config: {
    agentMode?: AgentMode;
    trustLevel?: TrustLevel;
  }) => void;
}> = (props) => {
  const channelStatusColor = () => {
    switch (props.channel.status) {
      case "connected":
        return "#22c55e";
      case "connecting":
        return "#eab308";
      case "error":
        return "#ef4444";
      default:
        return "#94a3b8";
    }
  };

  return (
    <div class="flex items-center justify-between px-4 py-3 bg-surface-3/60 border border-border-hover rounded-lg">
      <div class="flex items-center gap-3">
        <span
          class="w-2 h-2 rounded-full"
          style={{ "background-color": channelStatusColor() }}
        />
        <div class="flex flex-col gap-0.5">
          <span class="text-[0.9rem] font-medium text-foreground">
            {props.channel.displayName}
          </span>
          <span class="text-[0.75rem] text-muted-foreground">
            {props.channel.platform}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-3">
        {/* Agent Mode */}
        <select
          title="Agent mode"
          class="px-2 py-1 bg-surface-3/80 border border-border-hover rounded text-[0.8rem] text-foreground cursor-pointer"
          value={props.channel.agentMode}
          onChange={(e) =>
            props.onConfigChange({
              agentMode: e.currentTarget.value as AgentMode,
            })
          }
        >
          <option value="seren">Seren AI</option>
          <option value="openclaw">OpenClaw AI</option>
        </select>

        {/* Trust Level */}
        <select
          title="Trust level"
          class="px-2 py-1 bg-surface-3/80 border border-border-hover rounded text-[0.8rem] text-foreground cursor-pointer"
          value={props.channel.trustLevel}
          onChange={(e) =>
            props.onConfigChange({
              trustLevel: e.currentTarget.value as TrustLevel,
            })
          }
        >
          <option value="auto">Auto-respond</option>
          <option value="mention-only">Mention only</option>
          <option value="approval-required">Require approval</option>
        </select>
      </div>
    </div>
  );
};

export default OpenClawSettings;
