// ABOUTME: Channel connection UI for Moltbot — platform picker and per-platform auth flows.
// ABOUTME: Handles QR code display (WhatsApp), token input (Telegram/Discord), and generic fallback.

import {
  type Component,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { moltbotStore } from "@/stores/moltbot.store";

// ============================================================================
// Platform Definitions
// ============================================================================

interface PlatformDef {
  id: string;
  name: string;
  icon: string;
  authType: "qr" | "token" | "oauth" | "phone" | "instructions";
  tokenLabel?: string;
  tokenPlaceholder?: string;
  instructions?: string;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: "💬",
    authType: "qr",
  },
  {
    id: "telegram",
    name: "Telegram",
    icon: "✈️",
    authType: "token",
    tokenLabel: "Bot API Token",
    tokenPlaceholder: "123456:ABC-DEF1234ghIkl-zyx57W2v...",
  },
  {
    id: "discord",
    name: "Discord",
    icon: "🎮",
    authType: "token",
    tokenLabel: "Bot Token",
    tokenPlaceholder: "MTI3NjM4...",
  },
  {
    id: "signal",
    name: "Signal",
    icon: "🔒",
    authType: "phone",
  },
  {
    id: "slack",
    name: "Slack",
    icon: "💼",
    authType: "token",
    tokenLabel: "Bot OAuth Token",
    tokenPlaceholder: "xoxb-...",
  },
  {
    id: "imessage",
    name: "iMessage",
    icon: "🍎",
    authType: "instructions",
    instructions:
      "iMessage requires macOS with BlueBubbles or similar bridge. Configure BlueBubbles separately, then Moltbot will detect it automatically.",
  },
  {
    id: "mattermost",
    name: "Mattermost",
    icon: "🟦",
    authType: "token",
    tokenLabel: "Bot Access Token",
    tokenPlaceholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    id: "googlechat",
    name: "Google Chat",
    icon: "💚",
    authType: "token",
    tokenLabel: "Service Account JSON",
    tokenPlaceholder: '{"type": "service_account", ...}',
  },
  {
    id: "msteams",
    name: "Microsoft Teams",
    icon: "🟪",
    authType: "token",
    tokenLabel: "Bot Framework App ID",
    tokenPlaceholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  },
];

// ============================================================================
// Main Component
// ============================================================================

interface MoltbotChannelConnectProps {
  onClose: () => void;
  onConnected: () => void;
}

export const MoltbotChannelConnect: Component<MoltbotChannelConnectProps> = (
  props,
) => {
  const [selectedPlatform, setSelectedPlatform] =
    createSignal<PlatformDef | null>(null);

  const handleBack = () => {
    setSelectedPlatform(null);
  };

  const handleConnected = () => {
    moltbotStore.refreshChannels();
    props.onConnected();
  };

  return (
    <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]">
      <div
        class="bg-popover border border-[rgba(148,163,184,0.25)] rounded-xl max-w-[560px] w-[90%] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="flex items-center justify-between px-6 py-4 border-b border-[rgba(148,163,184,0.15)]">
          <div class="flex items-center gap-3">
            <Show when={selectedPlatform()}>
              <button
                type="button"
                class="w-7 h-7 flex items-center justify-center bg-transparent border-none rounded text-muted-foreground cursor-pointer hover:bg-[rgba(148,163,184,0.1)]"
                onClick={handleBack}
              >
                ←
              </button>
            </Show>
            <h3 class="m-0 text-[1.1rem] font-semibold text-foreground">
              {selectedPlatform()
                ? `Connect ${selectedPlatform()?.name}`
                : "Connect a Channel"}
            </h3>
          </div>
          <button
            type="button"
            class="w-7 h-7 flex items-center justify-center bg-transparent border-none rounded text-[1.2rem] text-muted-foreground cursor-pointer hover:bg-[rgba(148,163,184,0.1)]"
            onClick={props.onClose}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto px-6 py-4">
          <Show
            when={selectedPlatform()}
            fallback={
              <PlatformPicker onSelect={(p) => setSelectedPlatform(p)} />
            }
          >
            {(platform) => (
              <Switch>
                <Match when={platform().authType === "qr"}>
                  <QrCodeFlow
                    platform={platform()}
                    onConnected={handleConnected}
                  />
                </Match>
                <Match when={platform().authType === "token"}>
                  <TokenFlow
                    platform={platform()}
                    onConnected={handleConnected}
                  />
                </Match>
                <Match when={platform().authType === "phone"}>
                  <PhoneFlow
                    platform={platform()}
                    onConnected={handleConnected}
                  />
                </Match>
                <Match when={platform().authType === "instructions"}>
                  <InstructionsFlow
                    platform={platform()}
                    onConnected={handleConnected}
                  />
                </Match>
              </Switch>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Platform Picker
// ============================================================================

const PlatformPicker: Component<{
  onSelect: (platform: PlatformDef) => void;
}> = (props) => {
  return (
    <div class="grid grid-cols-3 gap-3">
      <For each={PLATFORMS}>
        {(platform) => (
          <button
            type="button"
            class="flex flex-col items-center gap-2 px-4 py-5 bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg cursor-pointer transition-all duration-150 hover:bg-[rgba(148,163,184,0.1)] hover:border-[rgba(148,163,184,0.4)]"
            onClick={() => props.onSelect(platform)}
          >
            <span class="text-[2rem]">{platform.icon}</span>
            <span class="text-[0.85rem] text-foreground font-medium">
              {platform.name}
            </span>
          </button>
        )}
      </For>
    </div>
  );
};

// ============================================================================
// QR Code Flow (WhatsApp)
// ============================================================================

const QrCodeFlow: Component<{
  platform: PlatformDef;
  onConnected: () => void;
}> = (props) => {
  const [qrData, setQrData] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [polling, setPolling] = createSignal(true);

  let pollInterval: ReturnType<typeof setInterval> | undefined;

  const fetchQr = async () => {
    setLoading(true);
    setError(null);
    try {
      const qr = await moltbotStore.getQrCode(props.platform.id);
      setQrData(qr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const startPolling = () => {
    // Poll for channel connection status
    pollInterval = setInterval(async () => {
      try {
        await moltbotStore.refreshChannels();
        const connected = moltbotStore.channels.find(
          (c) => c.platform === props.platform.id && c.status === "connected",
        );
        if (connected) {
          setPolling(false);
          clearInterval(pollInterval);
          props.onConnected();
        }
      } catch {
        // Silently retry
      }
    }, 3000);
  };

  // Fetch QR code and start polling on mount
  fetchQr().then(() => {
    if (!error()) startPolling();
  });

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  return (
    <div class="flex flex-col items-center gap-4">
      <p class="m-0 text-[0.9rem] text-muted-foreground text-center">
        Scan this QR code with your {props.platform.name} app to connect.
      </p>

      <Show when={error()}>
        <div class="px-4 py-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg text-[0.85rem] text-[#ef4444] w-full">
          {error()}
        </div>
      </Show>

      <Show when={loading()}>
        <div class="w-[240px] h-[240px] flex items-center justify-center bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg">
          <span class="text-muted-foreground text-[0.9rem]">
            Loading QR code...
          </span>
        </div>
      </Show>

      <Show when={!loading() && qrData()}>
        <div class="p-4 bg-white rounded-lg">
          <img
            src={qrData() ?? ""}
            alt={`${props.platform.name} QR code`}
            class="w-[200px] h-[200px]"
          />
        </div>
      </Show>

      <Show when={polling() && !loading()}>
        <p class="m-0 text-[0.8rem] text-muted-foreground">
          Waiting for scan...
        </p>
      </Show>

      <button
        type="button"
        class="px-4 py-2 bg-transparent border border-[rgba(148,163,184,0.3)] rounded-md text-[0.85rem] text-muted-foreground cursor-pointer transition-all duration-150 hover:bg-[rgba(148,163,184,0.1)]"
        onClick={fetchQr}
      >
        Refresh QR Code
      </button>
    </div>
  );
};

// ============================================================================
// Token Input Flow (Telegram, Discord, Slack, etc.)
// ============================================================================

const TokenFlow: Component<{
  platform: PlatformDef;
  onConnected: () => void;
}> = (props) => {
  const [token, setToken] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [connecting, setConnecting] = createSignal(false);

  const handleConnect = async () => {
    const value = token().trim();
    if (!value) return;

    setConnecting(true);
    setError(null);
    try {
      await moltbotStore.connectChannel(props.platform.id, { token: value });
      props.onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <p class="m-0 text-[0.9rem] text-muted-foreground">
        Enter your {props.platform.tokenLabel ?? "API token"} to connect{" "}
        {props.platform.name}.
      </p>

      <Show when={error()}>
        <div class="px-4 py-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg text-[0.85rem] text-[#ef4444]">
          {error()}
        </div>
      </Show>

      <label class="flex flex-col gap-1.5">
        <span class="text-[0.85rem] font-medium text-foreground">
          {props.platform.tokenLabel ?? "API Token"}
        </span>
        <input
          type="password"
          placeholder={props.platform.tokenPlaceholder ?? "Paste token here..."}
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          class="px-3 py-2.5 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] font-mono focus:outline-none focus:border-accent"
        />
      </label>

      <button
        type="button"
        class="px-4 py-2.5 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={handleConnect}
        disabled={!token().trim() || connecting()}
      >
        {connecting() ? "Connecting..." : "Connect"}
      </button>
    </div>
  );
};

// ============================================================================
// Phone Number Flow (Signal)
// ============================================================================

const PhoneFlow: Component<{
  platform: PlatformDef;
  onConnected: () => void;
}> = (props) => {
  const [phone, setPhone] = createSignal("");
  const [verificationCode, setVerificationCode] = createSignal("");
  const [step, setStep] = createSignal<"phone" | "verify">("phone");
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const handleRequestCode = async () => {
    const value = phone().trim();
    if (!value) return;

    setLoading(true);
    setError(null);
    try {
      await moltbotStore.connectChannel(props.platform.id, {
        phone: value,
        step: "request",
      });
      setStep("verify");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    const code = verificationCode().trim();
    if (!code) return;

    setLoading(true);
    setError(null);
    try {
      await moltbotStore.connectChannel(props.platform.id, {
        phone: phone().trim(),
        code,
        step: "verify",
      });
      props.onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <Show when={error()}>
        <div class="px-4 py-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg text-[0.85rem] text-[#ef4444]">
          {error()}
        </div>
      </Show>

      <Show when={step() === "phone"}>
        <p class="m-0 text-[0.9rem] text-muted-foreground">
          Enter your phone number to link {props.platform.name}. A verification
          code will be sent to your device.
        </p>

        <label class="flex flex-col gap-1.5">
          <span class="text-[0.85rem] font-medium text-foreground">
            Phone Number
          </span>
          <input
            type="tel"
            placeholder="+1 (555) 123-4567"
            value={phone()}
            onInput={(e) => setPhone(e.currentTarget.value)}
            class="px-3 py-2.5 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] focus:outline-none focus:border-accent"
          />
        </label>

        <button
          type="button"
          class="px-4 py-2.5 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleRequestCode}
          disabled={!phone().trim() || loading()}
        >
          {loading() ? "Requesting..." : "Send Verification Code"}
        </button>
      </Show>

      <Show when={step() === "verify"}>
        <p class="m-0 text-[0.9rem] text-muted-foreground">
          Enter the verification code sent to {phone()}.
        </p>

        <label class="flex flex-col gap-1.5">
          <span class="text-[0.85rem] font-medium text-foreground">
            Verification Code
          </span>
          <input
            type="text"
            placeholder="123456"
            value={verificationCode()}
            onInput={(e) => setVerificationCode(e.currentTarget.value)}
            class="px-3 py-2.5 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-center tracking-[0.3em] font-mono focus:outline-none focus:border-accent"
          />
        </label>

        <button
          type="button"
          class="px-4 py-2.5 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleVerify}
          disabled={!verificationCode().trim() || loading()}
        >
          {loading() ? "Verifying..." : "Verify & Connect"}
        </button>
      </Show>
    </div>
  );
};

// ============================================================================
// Instructions Flow (iMessage)
// ============================================================================

const InstructionsFlow: Component<{
  platform: PlatformDef;
  onConnected: () => void;
}> = (props) => {
  return (
    <div class="flex flex-col gap-4">
      <p class="m-0 text-[0.9rem] text-muted-foreground leading-relaxed">
        {props.platform.instructions}
      </p>

      <div class="px-4 py-3 bg-[rgba(234,179,8,0.1)] border border-[rgba(234,179,8,0.3)] rounded-lg text-[0.85rem] text-[#eab308]">
        After configuring the external bridge, restart Moltbot and the channel
        will appear automatically.
      </div>

      <button
        type="button"
        class="px-4 py-2.5 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:opacity-80"
        onClick={props.onConnected}
      >
        Done
      </button>
    </div>
  );
};

export default MoltbotChannelConnect;
