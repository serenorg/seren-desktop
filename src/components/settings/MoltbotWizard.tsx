// ABOUTME: First-run onboarding wizard for Moltbot messaging integration.
// ABOUTME: Guides user through channel selection, connection, agent mode, and trust config.

import {
  type Component,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import {
  type AgentMode,
  moltbotStore,
  type TrustLevel,
} from "@/stores/moltbot.store";
import { MoltbotChannelConnect } from "./MoltbotChannelConnect";

// ============================================================================
// Types
// ============================================================================

type WizardStep =
  | "welcome"
  | "select-channels"
  | "connect-channels"
  | "agent-mode"
  | "trust-config"
  | "done";

interface PlatformOption {
  id: string;
  name: string;
  icon: string;
}

const AVAILABLE_PLATFORMS: PlatformOption[] = [
  { id: "whatsapp", name: "WhatsApp", icon: "💬" },
  { id: "telegram", name: "Telegram", icon: "✈️" },
  { id: "discord", name: "Discord", icon: "🎮" },
  { id: "signal", name: "Signal", icon: "🔒" },
  { id: "slack", name: "Slack", icon: "💼" },
  { id: "imessage", name: "iMessage", icon: "🍎" },
  { id: "mattermost", name: "Mattermost", icon: "🟦" },
  { id: "googlechat", name: "Google Chat", icon: "💚" },
  { id: "msteams", name: "Microsoft Teams", icon: "🟪" },
];

// ============================================================================
// Main Wizard Component
// ============================================================================

interface MoltbotWizardProps {
  onComplete: () => void;
  onSkip: () => void;
}

export const MoltbotWizard: Component<MoltbotWizardProps> = (props) => {
  const [step, setStep] = createSignal<WizardStep>("welcome");
  const [selectedPlatforms, setSelectedPlatforms] = createSignal<string[]>([]);
  const [connectingIndex, setConnectingIndex] = createSignal(0);
  const [showConnectModal, setShowConnectModal] = createSignal(false);
  const [channelAgentModes, setChannelAgentModes] = createSignal<
    Record<string, AgentMode>
  >({});
  const [channelTrustLevels, setChannelTrustLevels] = createSignal<
    Record<string, TrustLevel>
  >({});
  const [error, setError] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);

  const goBack = () => {
    const steps: WizardStep[] = [
      "welcome",
      "select-channels",
      "connect-channels",
      "agent-mode",
      "trust-config",
      "done",
    ];
    const current = steps.indexOf(step());
    if (current > 0) setStep(steps[current - 1]);
  };

  const connectedPlatforms = () =>
    moltbotStore.channels.filter((c) => c.status === "connected");

  // --- Step Handlers ---

  const handleSelectDone = async () => {
    if (selectedPlatforms().length === 0) return;
    // Start Moltbot before entering connection step so channels can actually connect
    if (!moltbotStore.isRunning) {
      setStarting(true);
      setError(null);
      try {
        await moltbotStore.start();
      } catch (e) {
        setError(
          `Failed to start Moltbot: ${e instanceof Error ? e.message : String(e)}`,
        );
        setStarting(false);
        return;
      }
      setStarting(false);
    }
    setConnectingIndex(0);
    setStep("connect-channels");
  };

  const handleChannelConnected = () => {
    setShowConnectModal(false);
    moltbotStore.refreshChannels();
    const nextIdx = connectingIndex() + 1;
    if (nextIdx < selectedPlatforms().length) {
      setConnectingIndex(nextIdx);
    } else {
      setStep("agent-mode");
    }
  };

  const handleSkipChannel = () => {
    const nextIdx = connectingIndex() + 1;
    if (nextIdx < selectedPlatforms().length) {
      setConnectingIndex(nextIdx);
    } else {
      setStep("agent-mode");
    }
  };

  const handleAgentModeDone = () => {
    // Apply agent modes to connected channels
    for (const channel of connectedPlatforms()) {
      const mode = channelAgentModes()[channel.platform];
      if (mode) {
        moltbotStore.configureChannel(channel.id, { agentMode: mode });
      }
    }
    setStep("trust-config");
  };

  const handleTrustDone = () => {
    // Apply trust levels to connected channels
    for (const channel of connectedPlatforms()) {
      const trust = channelTrustLevels()[channel.platform];
      if (trust) {
        moltbotStore.configureChannel(channel.id, { trustLevel: trust });
      }
    }
    setStep("done");
  };

  const handleFinish = async () => {
    setStarting(true);
    setError(null);
    try {
      if (!moltbotStore.isRunning) {
        await moltbotStore.start();
      }
      await moltbotStore.completeSetup();
      props.onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div class="max-w-[520px]">
      <Switch>
        {/* Step 1: Welcome */}
        <Match when={step() === "welcome"}>
          <div class="text-center py-6">
            <span class="text-[3rem] block mb-4">🦞</span>
            <h3 class="m-0 mb-3 text-[1.5rem] font-semibold text-foreground">
              Welcome to Moltbot
            </h3>
            <p class="m-0 mb-6 text-[1rem] text-muted-foreground leading-relaxed">
              Connect your messaging apps. Your AI agent can send and receive
              messages on your behalf across WhatsApp, Telegram, Signal,
              Discord, and more.
            </p>
            <div class="flex justify-center gap-3">
              <button
                type="button"
                class="px-6 py-3 bg-accent border-none rounded-md text-white text-[1rem] font-medium cursor-pointer transition-all duration-150 hover:opacity-80"
                onClick={() => setStep("select-channels")}
              >
                Get Started
              </button>
              <button
                type="button"
                class="px-4 py-3 bg-transparent border border-[rgba(148,163,184,0.3)] rounded-md text-muted-foreground text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-[rgba(148,163,184,0.1)]"
                onClick={props.onSkip}
              >
                Skip for now
              </button>
            </div>
          </div>
        </Match>

        {/* Step 2: Channel Selection */}
        <Match when={step() === "select-channels"}>
          <div>
            <WizardHeader
              title="Select Channels"
              subtitle="Choose which messaging platforms to connect."
              onBack={goBack}
            />
            <div class="grid grid-cols-3 gap-3 mb-6">
              <For each={AVAILABLE_PLATFORMS}>
                {(platform) => {
                  const isSelected = () =>
                    selectedPlatforms().includes(platform.id);
                  const toggle = () => {
                    setSelectedPlatforms((prev) =>
                      isSelected()
                        ? prev.filter((id) => id !== platform.id)
                        : [...prev, platform.id],
                    );
                  };
                  return (
                    <button
                      type="button"
                      class={`flex flex-col items-center gap-2 px-4 py-4 border-2 rounded-lg cursor-pointer transition-all duration-150 ${
                        isSelected()
                          ? "bg-[rgba(99,102,241,0.1)] border-accent"
                          : "bg-[rgba(30,30,30,0.6)] border-[rgba(148,163,184,0.2)] hover:border-[rgba(148,163,184,0.4)]"
                      }`}
                      onClick={toggle}
                    >
                      <span class="text-[1.8rem]">{platform.icon}</span>
                      <span
                        class={`text-[0.85rem] font-medium ${isSelected() ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {platform.name}
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
            <div class="flex justify-between">
              <button
                type="button"
                class="px-4 py-2 bg-transparent border border-[rgba(148,163,184,0.3)] rounded-md text-muted-foreground text-[0.85rem] cursor-pointer hover:bg-[rgba(148,163,184,0.1)]"
                onClick={props.onSkip}
              >
                Skip for now
              </button>
              <button
                type="button"
                class="px-5 py-2 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleSelectDone}
                disabled={selectedPlatforms().length === 0}
              >
                Connect Selected ({selectedPlatforms().length})
              </button>
            </div>
          </div>
        </Match>

        {/* Step 3: Connect Channels */}
        <Match when={step() === "connect-channels"}>
          <div>
            <WizardHeader
              title="Connect Channels"
              subtitle={`Connecting ${connectingIndex() + 1} of ${selectedPlatforms().length}`}
              onBack={goBack}
            />
            <div class="mb-4">
              {/* Progress dots */}
              <div class="flex items-center gap-2 mb-6">
                <For each={selectedPlatforms()}>
                  {(_, i) => (
                    <div
                      class={`w-2.5 h-2.5 rounded-full ${
                        i() < connectingIndex()
                          ? "bg-[#22c55e]"
                          : i() === connectingIndex()
                            ? "bg-accent"
                            : "bg-[rgba(148,163,184,0.3)]"
                      }`}
                    />
                  )}
                </For>
              </div>

              <div class="text-center mb-4">
                <span class="text-[2rem] block mb-2">
                  {
                    AVAILABLE_PLATFORMS.find(
                      (p) => p.id === selectedPlatforms()[connectingIndex()],
                    )?.icon
                  }
                </span>
                <p class="m-0 text-[1rem] font-medium text-foreground">
                  {
                    AVAILABLE_PLATFORMS.find(
                      (p) => p.id === selectedPlatforms()[connectingIndex()],
                    )?.name
                  }
                </p>
              </div>

              <div class="flex justify-center gap-3">
                <button
                  type="button"
                  class="px-5 py-2.5 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer hover:opacity-80"
                  onClick={() => setShowConnectModal(true)}
                >
                  Connect
                </button>
                <button
                  type="button"
                  class="px-4 py-2.5 bg-transparent border border-[rgba(148,163,184,0.3)] rounded-md text-muted-foreground text-[0.85rem] cursor-pointer hover:bg-[rgba(148,163,184,0.1)]"
                  onClick={handleSkipChannel}
                >
                  Skip
                </button>
              </div>
            </div>

            <Show when={showConnectModal()}>
              <MoltbotChannelConnect
                onClose={() => setShowConnectModal(false)}
                onConnected={handleChannelConnected}
              />
            </Show>
          </div>
        </Match>

        {/* Step 4: Agent Mode */}
        <Match when={step() === "agent-mode"}>
          <div>
            <WizardHeader
              title="Choose AI Agent"
              subtitle="Select which AI handles messages for each channel."
              onBack={goBack}
            />
            <div class="flex flex-col gap-3 mb-6">
              <For each={connectedPlatforms()}>
                {(channel) => {
                  const mode = () =>
                    channelAgentModes()[channel.platform] ?? "seren";
                  const setMode = (m: AgentMode) =>
                    setChannelAgentModes((prev) => ({
                      ...prev,
                      [channel.platform]: m,
                    }));
                  return (
                    <div class="flex items-center justify-between px-4 py-3 bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg">
                      <span class="text-[0.9rem] font-medium text-foreground">
                        {channel.displayName}
                      </span>
                      <div class="flex gap-2">
                        <button
                          type="button"
                          class={`px-3 py-1.5 rounded-md text-[0.8rem] cursor-pointer transition-all duration-150 border ${
                            mode() === "seren"
                              ? "bg-accent border-accent text-white"
                              : "bg-transparent border-[rgba(148,163,184,0.3)] text-muted-foreground hover:bg-[rgba(148,163,184,0.1)]"
                          }`}
                          onClick={() => setMode("seren")}
                        >
                          Seren AI
                        </button>
                        <button
                          type="button"
                          class={`px-3 py-1.5 rounded-md text-[0.8rem] cursor-pointer transition-all duration-150 border ${
                            mode() === "moltbot"
                              ? "bg-accent border-accent text-white"
                              : "bg-transparent border-[rgba(148,163,184,0.3)] text-muted-foreground hover:bg-[rgba(148,163,184,0.1)]"
                          }`}
                          onClick={() => setMode("moltbot")}
                        >
                          Moltbot AI
                        </button>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
            <Show when={connectedPlatforms().length === 0}>
              <p class="m-0 mb-4 text-[0.85rem] text-muted-foreground text-center">
                No channels connected yet. You can configure this later.
              </p>
            </Show>
            <div class="flex justify-end">
              <button
                type="button"
                class="px-5 py-2 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer hover:opacity-80"
                onClick={handleAgentModeDone}
              >
                Next
              </button>
            </div>
          </div>
        </Match>

        {/* Step 5: Trust Configuration */}
        <Match when={step() === "trust-config"}>
          <div>
            <WizardHeader
              title="Trust Settings"
              subtitle="Control how your AI responds on each channel."
              onBack={goBack}
            />
            <div class="flex flex-col gap-3 mb-6">
              <For each={connectedPlatforms()}>
                {(channel) => {
                  const trust = () =>
                    channelTrustLevels()[channel.platform] ??
                    channel.trustLevel;
                  const setTrust = (t: TrustLevel) =>
                    setChannelTrustLevels((prev) => ({
                      ...prev,
                      [channel.platform]: t,
                    }));
                  return (
                    <div class="px-4 py-3 bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg">
                      <span class="text-[0.9rem] font-medium text-foreground block mb-2">
                        {channel.displayName}
                      </span>
                      <div class="flex gap-2">
                        <TrustButton
                          label="Auto-respond"
                          active={trust() === "auto"}
                          onClick={() => setTrust("auto")}
                        />
                        <TrustButton
                          label="Mention only"
                          active={trust() === "mention-only"}
                          onClick={() => setTrust("mention-only")}
                        />
                        <TrustButton
                          label="Require approval"
                          active={trust() === "approval-required"}
                          onClick={() => setTrust("approval-required")}
                        />
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
            <Show when={connectedPlatforms().length === 0}>
              <p class="m-0 mb-4 text-[0.85rem] text-muted-foreground text-center">
                No channels connected yet. You can configure this later.
              </p>
            </Show>
            <div class="flex justify-end">
              <button
                type="button"
                class="px-5 py-2 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer hover:opacity-80"
                onClick={handleTrustDone}
              >
                Next
              </button>
            </div>
          </div>
        </Match>

        {/* Step 6: Done */}
        <Match when={step() === "done"}>
          <div class="text-center py-6">
            <span class="text-[3rem] block mb-4">🎉</span>
            <h3 class="m-0 mb-3 text-[1.3rem] font-semibold text-foreground">
              Setup Complete
            </h3>
            <p class="m-0 mb-2 text-[0.9rem] text-muted-foreground">
              {connectedPlatforms().length > 0
                ? `${connectedPlatforms().length} channel${connectedPlatforms().length !== 1 ? "s" : ""} connected.`
                : "No channels connected yet — you can add them anytime from this tab."}
            </p>

            <Show when={error()}>
              <div class="px-4 py-3 mb-4 mx-auto max-w-[400px] bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg text-[0.85rem] text-[#ef4444]">
                {error()}
              </div>
            </Show>

            <button
              type="button"
              class="mt-4 px-6 py-3 bg-accent border-none rounded-md text-white text-[1rem] font-medium cursor-pointer transition-all duration-150 hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleFinish}
              disabled={starting()}
            >
              {starting()
                ? "Starting Moltbot..."
                : moltbotStore.isRunning
                  ? "Finish Setup"
                  : "Start Moltbot"}
            </button>
          </div>
        </Match>
      </Switch>
    </div>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

const WizardHeader: Component<{
  title: string;
  subtitle: string;
  onBack: () => void;
}> = (props) => (
  <div class="mb-5">
    <button
      type="button"
      class="mb-2 px-0 py-1 bg-transparent border-none text-[0.85rem] text-muted-foreground cursor-pointer hover:text-foreground"
      onClick={props.onBack}
    >
      ← Back
    </button>
    <h3 class="m-0 mb-1 text-[1.3rem] font-semibold text-foreground">
      {props.title}
    </h3>
    <p class="m-0 text-[0.9rem] text-muted-foreground">{props.subtitle}</p>
  </div>
);

const TrustButton: Component<{
  label: string;
  active: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    class={`px-3 py-1.5 rounded-md text-[0.78rem] cursor-pointer transition-all duration-150 border ${
      props.active
        ? "bg-accent border-accent text-white"
        : "bg-transparent border-[rgba(148,163,184,0.3)] text-muted-foreground hover:bg-[rgba(148,163,184,0.1)]"
    }`}
    onClick={props.onClick}
  >
    {props.label}
  </button>
);

export default MoltbotWizard;
