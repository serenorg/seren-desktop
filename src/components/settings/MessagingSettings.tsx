// ABOUTME: Settings panel for Telegram, Discord, and WhatsApp messaging transports.
// ABOUTME: Each platform card has token input, start/stop toggle, and status display.

import { type Component, createSignal, For, onMount } from "solid-js";
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
  hasPhoneField: boolean;
}

const PLATFORMS: PlatformConfig[] = [
  {
    id: "telegram",
    label: "Telegram",
    tokenLabel: "Bot Token",
    placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    helpUrl: "https://t.me/BotFather",
    helpText: "Get a token from @BotFather",
    hasPhoneField: false,
  },
  {
    id: "discord",
    label: "Discord",
    tokenLabel: "Bot Token",
    placeholder: "MTI3ODk5Nzk...",
    helpUrl: "https://discord.com/developers/applications",
    helpText: "Create a bot at discord.dev",
    hasPhoneField: false,
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    tokenLabel: "Access Token",
    placeholder: "EAAG...",
    helpUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
    helpText: "Set up WhatsApp Business API",
    hasPhoneField: true,
  },
];

export const MessagingSettings: Component = () => {
  const [statuses, setStatuses] = createSignal<Record<string, PlatformStatus>>(
    {},
  );
  const [tokens, setTokens] = createSignal<Record<string, string>>({});
  const [phoneIds, setPhoneIds] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal<Record<string, boolean>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});

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

  onMount(() => {
    void refreshStatuses();
  });

  const handleStart = async (platformId: string) => {
    setLoading((prev) => ({ ...prev, [platformId]: true }));
    setErrors((prev) => ({ ...prev, [platformId]: "" }));
    try {
      const token = tokens()[platformId] || "";
      if (!token.trim()) {
        setErrors((prev) => ({ ...prev, [platformId]: "Token is required" }));
        return;
      }
      await invoke("messaging_start", {
        platform: platformId,
        token: token.trim(),
        allowedUserId: null,
        phoneNumberId: phoneIds()[platformId] || null,
      });
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
                    <span class="font-medium text-sm">{platform.label}</span>
                    <span
                      class={`inline-block w-2 h-2 rounded-full ${
                        isRunning() ? "bg-green-500" : "bg-muted-foreground/30"
                      }`}
                    />
                    {isRunning() && status()?.bot_username && (
                      <span class="text-xs text-muted-foreground">
                        {platform.id === "whatsapp"
                          ? status()!.bot_username
                          : `@${status()!.bot_username}`}
                      </span>
                    )}
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
                        : "Start"}
                  </button>
                </div>

                {!isRunning() && (
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

                    {platform.hasPhoneField && (
                      <>
                        <label class="text-xs text-muted-foreground">
                          Phone Number ID
                        </label>
                        <input
                          type="text"
                          placeholder="123456789012345"
                          value={phoneIds()[platform.id] ?? ""}
                          onInput={(e) =>
                            setPhoneIds((prev) => ({
                              ...prev,
                              [platform.id]: e.currentTarget.value,
                            }))
                          }
                          class="w-full px-3 py-2 text-sm rounded-md border border-border bg-surface-1 text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-accent"
                        />
                      </>
                    )}

                    <a
                      href={platform.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-xs text-accent hover:underline"
                    >
                      {platform.helpText}
                    </a>
                  </div>
                )}

                {error() && (
                  <p class="mt-2 text-xs text-red-400">{error()}</p>
                )}
              </div>
            );
          }}
        </For>
      </div>
    </section>
  );
};
