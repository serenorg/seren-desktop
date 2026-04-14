// ABOUTME: Settings panel for Telegram, Discord, and WhatsApp messaging transports.
// ABOUTME: Token input for Telegram/Discord; QR code pairing for WhatsApp.

import {
  type Component,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface PlatformStatus {
  platform: string;
  running: boolean;
  bot_username: string | null;
}

interface PlatformConfig {
  id: string;
  label: string;
  tokenLabel: string;
  placeholder: string;
  helpUrl: string;
  helpText: string;
  useQrPairing: boolean;
}

const PLATFORMS: PlatformConfig[] = [
  {
    id: "telegram",
    label: "Telegram",
    tokenLabel: "Bot Token",
    placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    helpUrl: "https://t.me/BotFather",
    helpText: "Get a token from @BotFather",
    useQrPairing: false,
  },
  {
    id: "discord",
    label: "Discord",
    tokenLabel: "Bot Token",
    placeholder: "MTI3ODk5Nzk...",
    helpUrl: "https://discord.com/developers/applications",
    helpText: "Create a bot at discord.dev",
    useQrPairing: false,
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    tokenLabel: "",
    placeholder: "",
    helpUrl: "",
    helpText: "",
    useQrPairing: true,
  },
];

export const MessagingSettings: Component = () => {
  const [statuses, setStatuses] = createSignal<Record<string, PlatformStatus>>(
    {},
  );
  const [tokens, setTokens] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal<Record<string, boolean>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [whatsappQr, setWhatsappQr] = createSignal<string | null>(null);
  let qrPollInterval: ReturnType<typeof setInterval> | undefined;

  const refreshStatuses = async () => {
    try {
      const all: PlatformStatus[] = await invoke("messaging_status_all");
      const map: Record<string, PlatformStatus> = {};
      for (const s of all) {
        map[s.platform] = s;
      }
      setStatuses(map);
    } catch {
      // Messaging commands may not be available if built without features
    }
  };

  const pollWhatsAppQr = async () => {
    try {
      const qr: string | null = await invoke("messaging_whatsapp_qr");
      setWhatsappQr(qr);
      if (!qr && statuses().whatsapp?.running) {
        stopQrPolling();
      }
    } catch {
      // Not available or not started
    }
  };

  const startQrPolling = () => {
    stopQrPolling();
    qrPollInterval = setInterval(() => void pollWhatsAppQr(), 2000);
  };

  const stopQrPolling = () => {
    if (qrPollInterval) {
      clearInterval(qrPollInterval);
      qrPollInterval = undefined;
    }
  };

  onMount(() => {
    void refreshStatuses();
  });

  onCleanup(() => {
    stopQrPolling();
  });

  const handleStart = async (platformId: string) => {
    setLoading((prev) => ({ ...prev, [platformId]: true }));
    setErrors((prev) => ({ ...prev, [platformId]: "" }));
    try {
      if (platformId === "whatsapp") {
        await invoke("messaging_start", {
          platform: "whatsapp",
          token: "qr-pairing",
          allowedUserId: null,
          phoneNumberId: null,
        });
        startQrPolling();
      } else {
        const token = tokens()[platformId] || "";
        if (!token.trim()) {
          setErrors((prev) => ({
            ...prev,
            [platformId]: "Token is required",
          }));
          return;
        }
        await invoke("messaging_start", {
          platform: platformId,
          token: token.trim(),
          allowedUserId: null,
          phoneNumberId: null,
        });
      }
      await refreshStatuses();
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [platformId]: String(err),
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [platformId]: false }));
    }
  };

  const handleStop = async (platformId: string) => {
    setLoading((prev) => ({ ...prev, [platformId]: true }));
    try {
      await invoke("messaging_stop", { platform: platformId });
      if (platformId === "whatsapp") {
        stopQrPolling();
        setWhatsappQr(null);
      }
      await refreshStatuses();
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [platformId]: String(err),
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [platformId]: false }));
    }
  };

  const qrCodeUrl = (qrString: string) =>
    `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrString)}`;

  return (
    <section>
      <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Messaging</h3>
      <p class="m-0 mb-6 text-muted-foreground leading-normal">
        Connect Seren to messaging platforms. Bots run locally inside the
        desktop app using your existing auth and tools.
      </p>

      <div class="flex flex-col gap-4">
        <For each={PLATFORMS}>
          {(platform) => {
            const status = () => statuses()[platform.id];
            const isRunning = () => status()?.running ?? false;
            const isLoading = () => loading()[platform.id] ?? false;
            const error = () => errors()[platform.id] ?? "";

            return (
              <div class="rounded-lg border border-border bg-surface-2 p-4">
                <div class="flex items-center justify-between mb-3">
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-sm">
                      {platform.label}
                      {platform.useQrPairing && (
                        <span class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-yellow-600/20 text-yellow-400 font-normal">
                          Beta
                        </span>
                      )}
                    </span>
                    <span
                      class={`inline-block w-2 h-2 rounded-full ${
                        isRunning() ? "bg-green-500" : "bg-muted-foreground/30"
                      }`}
                    />
                    <Show when={isRunning() && status()?.bot_username}>
                      <span class="text-xs text-muted-foreground">
                        {platform.id === "whatsapp"
                          ? status()!.bot_username
                          : `@${status()!.bot_username}`}
                      </span>
                    </Show>
                  </div>
                  <button
                    type="button"
                    disabled={isLoading()}
                    class={`px-3 py-1.5 text-xs font-medium rounded-md border-none cursor-pointer transition-colors ${
                      isRunning()
                        ? "bg-red-600/20 text-red-400 hover:bg-red-600/30"
                        : "bg-accent/20 text-accent hover:bg-accent/30"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                    onClick={() =>
                      isRunning()
                        ? handleStop(platform.id)
                        : handleStart(platform.id)
                    }
                  >
                    {isLoading()
                      ? "..."
                      : isRunning()
                        ? "Stop"
                        : platform.useQrPairing
                          ? "Link Account"
                          : "Start"}
                  </button>
                </div>

                <Show when={!isRunning() && !platform.useQrPairing}>
                  <div class="flex flex-col gap-2">
                    <label class="text-xs text-muted-foreground">
                      {platform.tokenLabel}
                    </label>
                    <input
                      type="password"
                      placeholder={platform.placeholder}
                      value={tokens()[platform.id] ?? ""}
                      onInput={(e) =>
                        setTokens((prev) => ({
                          ...prev,
                          [platform.id]: e.currentTarget.value,
                        }))
                      }
                      class="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-1 text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-accent"
                    />
                    <a
                      href={platform.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-xs text-accent hover:underline"
                    >
                      {platform.helpText}
                    </a>
                  </div>
                </Show>

                <Show when={!isRunning() && platform.useQrPairing}>
                  <div class="flex flex-col gap-2 items-center">
                    <Show
                      when={whatsappQr()}
                      fallback={
                        <p class="text-xs text-muted-foreground text-center py-2">
                          Click "Link Account" to generate a QR code.
                          <br />
                          Open WhatsApp on your phone &gt; Linked Devices &gt;
                          Link a Device.
                        </p>
                      }
                    >
                      <p class="text-xs text-muted-foreground text-center">
                        Scan this QR code with WhatsApp on your phone
                      </p>
                      <img
                        src={qrCodeUrl(whatsappQr()!)}
                        alt="WhatsApp QR Code"
                        width={200}
                        height={200}
                        class="rounded-lg border border-border"
                      />
                      <p class="text-[10px] text-muted-foreground/60 text-center">
                        QR code refreshes automatically
                      </p>
                    </Show>
                  </div>
                </Show>

                <Show when={error()}>
                  <p class="mt-2 text-xs text-red-400">{error()}</p>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </section>
  );
};
