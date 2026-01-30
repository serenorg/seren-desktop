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
  icon: () => import("solid-js").JSX.Element;
}

const AVAILABLE_PLATFORMS: PlatformOption[] = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="#25D366"
        role="img"
        aria-label="WhatsApp logo"
      >
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
      </svg>
    ),
  },
  {
    id: "telegram",
    name: "Telegram",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="#26A5E4"
        role="img"
        aria-label="Telegram logo"
      >
        <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0 12 12 0 0011.944 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
      </svg>
    ),
  },
  {
    id: "discord",
    name: "Discord",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="#5865F2"
        role="img"
        aria-label="Discord logo"
      >
        <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z" />
      </svg>
    ),
  },
  {
    id: "signal",
    name: "Signal",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="#3A76F0"
        role="img"
        aria-label="Signal logo"
      >
        <path d="M12 0C5.373 0 0 5.373 0 12c0 2.917 1.04 5.59 2.77 7.67l-.92 3.37 3.473-.94A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm5.894 16.546c-.248.695-1.46 1.326-2.036 1.394-.523.063-1.18.089-1.907-.12a17.37 17.37 0 01-1.726-.638c-3.037-1.31-5.02-4.382-5.172-4.586-.153-.204-1.243-1.652-1.243-3.153 0-1.5.787-2.24 1.066-2.546.278-.306.607-.382.81-.382.202 0 .405.002.581.01.187.01.438-.07.685.523.248.594.845 2.063.92 2.212.074.15.123.323.024.52-.1.197-.148.32-.297.494-.148.174-.312.39-.446.522-.149.148-.304.31-.13.607.173.298.77 1.27 1.654 2.058 1.136 1.013 2.093 1.327 2.39 1.476.298.149.471.124.644-.075.173-.198.744-.868.942-1.166.198-.297.397-.248.669-.148.272.099 1.727.814 2.024.963.297.149.496.223.57.347.074.124.074.719-.174 1.413z" />
      </svg>
    ),
  },
  {
    id: "slack",
    name: "Slack",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        role="img"
        aria-label="Slack logo"
      >
        <path
          d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313z"
          fill="#E01E5A"
        />
        <path
          d="M8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312z"
          fill="#36C5F0"
        />
        <path
          d="M18.956 8.834a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 01-2.521 2.521 2.528 2.528 0 01-2.521-2.521V2.522A2.528 2.528 0 0115.164 0a2.528 2.528 0 012.521 2.522v6.312z"
          fill="#2EB67D"
        />
        <path
          d="M15.164 18.956a2.528 2.528 0 012.521 2.522A2.528 2.528 0 0115.164 24a2.528 2.528 0 01-2.521-2.522v-2.522h2.521zm0-1.271a2.528 2.528 0 01-2.521-2.521 2.528 2.528 0 012.521-2.521h6.314A2.528 2.528 0 0124 15.164a2.528 2.528 0 01-2.522 2.521h-6.314z"
          fill="#ECB22E"
        />
      </svg>
    ),
  },
  {
    id: "imessage",
    name: "iMessage",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="#34C759"
        role="img"
        aria-label="iMessage logo"
      >
        <path d="M5.285 22.354c-.135 0-.27-.039-.385-.118a.742.742 0 01-.322-.615v-3.29C1.658 16.582 0 13.604 0 10.399 0 4.665 5.383 0 12 0s12 4.665 12 10.399c0 5.735-5.383 10.4-12 10.4-1.11 0-2.217-.145-3.287-.433l-3.117 1.9a.742.742 0 01-.311.088z" />
      </svg>
    ),
  },
  {
    id: "mattermost",
    name: "Mattermost",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="#0058CC"
        role="img"
        aria-label="Mattermost logo"
      >
        <path d="M12.081 0C7.032-.031 2.387 3.146.757 7.883c-1.8 5.227.237 10.977 4.87 13.755.209.126.477.008.496-.234l.314-4.072a.26.26 0 00-.122-.237C4.024 15.632 2.89 12.84 3.524 10.1c.734-3.152 3.473-5.509 6.691-5.752 4.128-.312 7.607 2.954 7.607 7.003 0 2.436-1.254 4.586-3.149 5.84a.26.26 0 00-.119.246l.345 4.474c.02.258.312.373.513.218 3.697-2.85 5.749-7.477 4.836-12.42C19.283 4.386 15.86.874 10.544.078A8.16 8.16 0 0012.081 0z" />
      </svg>
    ),
  },
  {
    id: "googlechat",
    name: "Google Chat",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="#00AC47"
        role="img"
        aria-label="Google Chat logo"
      >
        <path d="M12 0C5.372 0 0 5.373 0 12s5.372 12 12 12 12-5.373 12-12S18.628 0 12 0zm5.568 14.655c0 .518-.419.937-.936.937h-2.19l-2.442 2.442V15.59H7.368a.935.935 0 01-.936-.936V8.4c0-.518.419-.937.936-.937h9.264c.517 0 .936.419.936.937v6.255z" />
      </svg>
    ),
  },
  {
    id: "msteams",
    name: "Microsoft Teams",
    icon: () => (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="#6264A7"
        role="img"
        aria-label="Microsoft Teams logo"
      >
        <path d="M20.625 8.073h-1.27V6.844c0-.82-.569-1.27-1.27-1.27h-.704c.65-.484 1.073-1.256 1.073-2.125C18.454 1.545 16.91 0 15 0c-1.91 0-3.454 1.545-3.454 3.45 0 .868.423 1.64 1.073 2.124h-.704c-.701 0-1.27.45-1.27 1.27v1.229H9.375C8.063 8.073 7 9.136 7 10.448v7.177C7 18.937 8.063 20 9.375 20h11.25C21.937 20 23 18.937 23 17.625v-7.177c0-1.312-1.063-2.375-2.375-2.375zM15 1.5c1.078 0 1.954.876 1.954 1.95s-.876 1.95-1.954 1.95-1.954-.876-1.954-1.95S13.922 1.5 15 1.5zM2.37 7.5C1.062 7.5 0 8.563 0 9.87v5.76C0 16.938 1.063 18 2.37 18h4.26c.164 0 .324-.017.48-.049V10.45c0-1.502.887-2.798 2.165-3.4h-.463V5.573c0-.366-.1-.702-.265-.994H4.5C3.324 4.579 2.37 5.534 2.37 6.71V7.5z" />
      </svg>
    ),
  },
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
                      <span class="flex items-center justify-center w-[1.8rem] h-[1.8rem]">
                        {platform.icon()}
                      </span>
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
            <Show when={error()}>
              <div class="px-4 py-3 mb-4 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg text-[0.85rem] text-[#ef4444]">
                {error()}
              </div>
            </Show>
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
                disabled={selectedPlatforms().length === 0 || starting()}
              >
                {starting()
                  ? "Starting..."
                  : `Connect Selected (${selectedPlatforms().length})`}
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
                <span class="flex items-center justify-center w-[2rem] h-[2rem] mx-auto mb-2">
                  {AVAILABLE_PLATFORMS.find(
                    (p) => p.id === selectedPlatforms()[connectingIndex()],
                  )?.icon()}
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
