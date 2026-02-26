// ABOUTME: Settings panel UI for managing user preferences.
// ABOUTME: Provides controls for editor, wallet, theme, and MCP settings.

import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { isBuiltinServer, isLocalServer } from "@/lib/mcp/types";
import { authStore } from "@/stores/auth.store";
import { chatStore } from "@/stores/chat.store";
import { cryptoWalletStore } from "@/stores/crypto-wallet.store";
import { providerStore } from "@/stores/provider.store";
import {
  mcpSettings,
  removeMcpServer,
  type Settings,
  settingsState,
  settingsStore,
  toggleMcpServer,
} from "@/stores/settings.store";
import { claimDaily, walletState } from "@/stores/wallet.store";
import { OAuthLogins } from "./OAuthLogins";
import { OpenClawSettings } from "./OpenClawSettings";
import { ProviderSettings } from "./ProviderSettings";
import { SearchableModelSelect } from "./SearchableModelSelect";
import { ToolsetsSettings } from "./ToolsetsSettings";

type SettingsSection =
  | "chat"
  | "agent"
  | "providers"
  | "logins"
  | "toolsets"
  | "editor"
  | "wallet"
  | "indexing"
  | "appearance"
  | "general"
  | "mcp"
  | "openclaw";

interface SettingsPanelProps {
  onSignInClick?: () => void;
  onLogout?: () => void;
}

export const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const [activeSection, setActiveSection] =
    createSignal<SettingsSection>("chat");
  const [showResetConfirm, setShowResetConfirm] = createSignal(false);
  const [privateKeyInput, setPrivateKeyInput] = createSignal("");
  const [showClearConfirm, setShowClearConfirm] = createSignal(false);

  const handleNumberChange = (key: keyof Settings, value: string) => {
    const num = Number.parseFloat(value);
    if (!Number.isNaN(num)) {
      settingsStore.set(key, num as Settings[typeof key]);
    }
  };

  const handleBooleanChange = (key: keyof Settings, checked: boolean) => {
    settingsStore.set(key, checked as Settings[typeof key]);
  };

  const handleThemeChange = (value: string) => {
    if (value === "dark" || value === "light" || value === "system") {
      settingsStore.set("theme", value);
    }
  };

  const handleStringChange = (key: keyof Settings, value: string) => {
    settingsStore.set(key, value as Settings[typeof key]);
  };

  const handleDefaultModelChange = (modelId: string) => {
    // Update settings store
    settingsStore.set("chatDefaultModel", modelId);
    // Sync to provider store and chat store so it's reflected immediately
    providerStore.setActiveModel(modelId);
    chatStore.setModel(modelId);
  };

  const handleResetAll = () => {
    settingsStore.reset();
    setShowResetConfirm(false);
  };

  const handleRemoveMcpServer = async (name: string) => {
    const confirmRemove = window.confirm(`Remove MCP server "${name}"?`);
    if (confirmRemove) {
      await removeMcpServer(name);
    }
  };

  const handleToggleMcpServer = async (name: string) => {
    await toggleMcpServer(name);
  };

  const handleSavePrivateKey = async () => {
    const key = privateKeyInput().trim();
    if (!key) return;

    try {
      await cryptoWalletStore.storeKey(key);
      setPrivateKeyInput("");
    } catch {
      // Error is handled by the store
    }
  };

  const handleClearCryptoWallet = async () => {
    await cryptoWalletStore.clearWallet();
    setShowClearConfirm(false);
  };

  const isValidPrivateKeyFormat = (key: string): boolean => {
    const cleaned = key.startsWith("0x") ? key.slice(2) : key;
    return /^[0-9a-fA-F]{64}$/.test(cleaned);
  };

  const sections: { id: SettingsSection; label: string; icon: string }[] = [
    { id: "chat", label: "Window", icon: "🪟" },
    { id: "agent", label: "Agent", icon: "🛡️" },
    { id: "providers", label: "AI Providers", icon: "🤖" },
    { id: "logins", label: "Logins", icon: "🔐" },
    { id: "toolsets", label: "Toolsets", icon: "📦" },
    { id: "editor", label: "Editor", icon: "📝" },
    { id: "wallet", label: "Wallet", icon: "💳" },
    { id: "indexing", label: "Code Indexing", icon: "🔍" },
    { id: "appearance", label: "Appearance", icon: "🎨" },
    { id: "general", label: "General", icon: "⚙️" },
    { id: "mcp", label: "MCP Servers", icon: "🔌" },
    { id: "openclaw", label: "OpenClaw", icon: "🦞" },
  ];

  const handleOpenSection = (event: Event) => {
    const custom = event as CustomEvent<SettingsSection>;
    const section = custom.detail;
    if (sections.some((s) => s.id === section)) {
      setActiveSection(section);
    }
  };

  onMount(() => {
    window.addEventListener(
      "seren:open-settings-section",
      handleOpenSection as EventListener,
    );
  });

  onCleanup(() => {
    window.removeEventListener(
      "seren:open-settings-section",
      handleOpenSection as EventListener,
    );
  });

  return (
    <div class="flex h-full bg-surface text-foreground">
      <aside class="w-[220px] min-w-[180px] flex flex-col bg-popover border-r border-border-strong">
        <h2 class="px-4 pt-5 pb-3 m-0 text-[1.1rem] font-semibold text-foreground">
          Settings
        </h2>
        <nav class="flex-1 flex flex-col px-2 py-1 gap-0.5">
          <For each={sections}>
            {(section) => (
              <button
                type="button"
                class={`flex items-center gap-2.5 px-3 py-2.5 bg-transparent border-none rounded-md cursor-pointer text-[0.9rem] text-left transition-all duration-150 ${
                  activeSection() === section.id
                    ? "bg-accent text-white"
                    : "text-muted-foreground hover:bg-border hover:text-foreground"
                }`}
                onClick={() => setActiveSection(section.id)}
              >
                <span class="text-[1.1rem]">{section.icon}</span>
                {section.label}
              </button>
            )}
          </For>
        </nav>
        <div class="p-3 border-t border-border-medium">
          <button
            type="button"
            class="w-full py-2 px-2 bg-transparent border border-border-strong rounded-md text-muted-foreground text-[0.85rem] cursor-pointer transition-all duration-150 hover:bg-destructive/10 hover:border-destructive/50 hover:text-destructive"
            onClick={() => setShowResetConfirm(true)}
          >
            Reset All Settings
          </button>
        </div>
      </aside>

      <main class="flex-1 px-8 py-6 overflow-y-auto">
        <Show when={activeSection() === "chat"}>
          <section>
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">
              Window Settings
            </h3>
            <p class="m-0 mb-6 text-muted-foreground leading-normal">
              Configure AI chat behavior and conversation history.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Default Model
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  AI model for chat conversations
                </span>
              </label>
              <SearchableModelSelect
                value={settingsState.app.chatDefaultModel}
                onChange={handleDefaultModelChange}
                placeholder="Select a model"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  History Limit
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Maximum messages to keep in conversation context
                </span>
              </label>
              <input
                type="number"
                min="10"
                max="200"
                step="10"
                value={settingsState.app.chatMaxHistoryMessages}
                onInput={(e) =>
                  handleNumberChange(
                    "chatMaxHistoryMessages",
                    e.currentTarget.value,
                  )
                }
                class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Max Tool Iterations
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  How many times the AI can use tools per message. Higher values
                  allow more complex tasks but use more credits. Set to 0 for
                  unlimited (use with caution).
                </span>
              </label>
              <input
                type="number"
                min="0"
                max="50"
                step="5"
                value={settingsState.app.chatMaxToolIterations}
                onInput={(e) =>
                  handleNumberChange(
                    "chatMaxToolIterations",
                    e.currentTarget.value,
                  )
                }
                class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.chatEnterToSend}
                  onChange={(e) =>
                    handleBooleanChange(
                      "chatEnterToSend",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enter to Send
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Press Enter to send messages (Shift+Enter for new line)
                  </span>
                </span>
              </label>
            </div>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted-foreground border-t border-border-medium pt-5">
              Auto-Compact
            </h4>
            <p class="m-0 mb-4 text-[0.85rem] text-muted-foreground leading-relaxed">
              Automatically summarize older messages when approaching context
              limits.
            </p>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.autoCompactEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "autoCompactEnabled",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable Auto-Compact
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Automatically summarize older messages to manage context
                  </span>
                </span>
              </label>
            </div>

            <Show when={settingsState.app.autoCompactEnabled}>
              <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
                <label class="flex flex-col gap-0.5 flex-1">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Compact Threshold
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Trigger compaction when context usage reaches this % of
                    limit
                  </span>
                </label>
                <input
                  type="number"
                  min="50"
                  max="95"
                  step="5"
                  aria-label="Compact threshold percentage"
                  value={settingsState.app.autoCompactThreshold}
                  onInput={(e) =>
                    handleNumberChange(
                      "autoCompactThreshold",
                      e.currentTarget.value,
                    )
                  }
                  class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
                />
              </div>

              <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
                <label class="flex flex-col gap-0.5 flex-1">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Preserve Messages
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Number of recent messages to keep (not compacted)
                  </span>
                </label>
                <input
                  type="number"
                  min="2"
                  max="50"
                  step="1"
                  aria-label="Number of messages to preserve"
                  value={settingsState.app.autoCompactPreserveMessages}
                  onInput={(e) =>
                    handleNumberChange(
                      "autoCompactPreserveMessages",
                      e.currentTarget.value,
                    )
                  }
                  class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
                />
              </div>
            </Show>
          </section>
        </Show>

        <Show when={activeSection() === "providers"}>
          <ProviderSettings />
        </Show>

        <Show when={activeSection() === "logins"}>
          <OAuthLogins onSignInClick={props.onSignInClick} />
        </Show>

        <Show when={activeSection() === "toolsets"}>
          <ToolsetsSettings />
        </Show>

        <Show when={activeSection() === "editor"}>
          <section>
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">
              Editor Settings
            </h3>
            <p class="m-0 mb-6 text-muted-foreground leading-normal">
              Customize your code editing experience.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Font Size
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Size of text in the editor (px)
                </span>
              </label>
              <input
                type="number"
                min="10"
                max="32"
                value={settingsState.app.editorFontSize}
                onInput={(e) =>
                  handleNumberChange("editorFontSize", e.currentTarget.value)
                }
                class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Tab Size
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Number of spaces per tab
                </span>
              </label>
              <input
                type="number"
                min="1"
                max="8"
                value={settingsState.app.editorTabSize}
                onInput={(e) =>
                  handleNumberChange("editorTabSize", e.currentTarget.value)
                }
                class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.editorWordWrap}
                  onChange={(e) =>
                    handleBooleanChange(
                      "editorWordWrap",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Word Wrap
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Wrap long lines instead of scrolling
                  </span>
                </span>
              </label>
            </div>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted-foreground border-t border-border-medium pt-5">
              Code Completion
            </h4>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.completionEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "completionEnabled",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable AI Completions
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Show AI-powered code suggestions while typing
                  </span>
                </span>
              </label>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Completion Delay
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Milliseconds to wait before showing suggestions
                </span>
              </label>
              <input
                type="number"
                min="100"
                max="2000"
                step="100"
                value={settingsState.app.completionDelay}
                onInput={(e) =>
                  handleNumberChange("completionDelay", e.currentTarget.value)
                }
                class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Completion Model
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  AI model for code completions
                </span>
              </label>
              <SearchableModelSelect
                value={settingsState.app.completionModelId}
                onChange={(value) =>
                  handleStringChange("completionModelId", value)
                }
                placeholder="Select a model"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Max Suggestion Lines
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Maximum lines in code completion suggestions
                </span>
              </label>
              <input
                type="number"
                min="1"
                max="20"
                value={settingsState.app.completionMaxSuggestionLines}
                onInput={(e) =>
                  handleNumberChange(
                    "completionMaxSuggestionLines",
                    e.currentTarget.value,
                  )
                }
                class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "wallet"}>
          <section>
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">
              Wallet Settings
            </h3>
            <p class="m-0 mb-6 text-muted-foreground leading-normal">
              Configure your SerenBucks balance display and auto top-up.
            </p>

            <DailyClaimBanner />

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.showBalance}
                  onChange={(e) =>
                    handleBooleanChange("showBalance", e.currentTarget.checked)
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Show Balance in Status Bar
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Display your SerenBucks balance at the bottom of the app
                  </span>
                </span>
              </label>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Low Balance Warning
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Show warning when balance falls below this amount ($)
                </span>
              </label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={settingsState.app.lowBalanceThreshold}
                onInput={(e) =>
                  handleNumberChange(
                    "lowBalanceThreshold",
                    e.currentTarget.value,
                  )
                }
                class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted-foreground border-t border-border-medium pt-5">
              Payment Method
            </h4>
            <p class="m-0 mb-4 text-[0.85rem] text-muted-foreground leading-relaxed">
              Choose your preferred payment method for MCP server tools.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Preferred Method
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Default payment method for MCP tool usage
                </span>
              </label>
              <div class="flex gap-3">
                <button
                  type="button"
                  class={`flex flex-col items-center gap-2 px-6 py-4 bg-surface-3/60 border-2 rounded-lg cursor-pointer transition-all duration-150 min-w-[120px] ${
                    settingsState.app.preferredPaymentMethod === "serenbucks"
                      ? "border-accent bg-primary/10"
                      : "border-border-hover hover:border-muted-foreground/40"
                  }`}
                  onClick={() =>
                    handleStringChange("preferredPaymentMethod", "serenbucks")
                  }
                >
                  <span class="text-2xl">💰</span>
                  <span
                    class={`text-[0.85rem] ${settingsState.app.preferredPaymentMethod === "serenbucks" ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    SerenBucks
                  </span>
                </button>
                <button
                  type="button"
                  class={`flex flex-col items-center gap-2 px-6 py-4 bg-surface-3/60 border-2 rounded-lg cursor-pointer transition-all duration-150 min-w-[120px] disabled:opacity-50 disabled:cursor-not-allowed ${
                    settingsState.app.preferredPaymentMethod === "crypto"
                      ? "border-accent bg-primary/10"
                      : "border-border-hover hover:not-disabled:border-muted-foreground/40"
                  }`}
                  onClick={() =>
                    handleStringChange("preferredPaymentMethod", "crypto")
                  }
                  disabled={!cryptoWalletStore.state().isConfigured}
                  title={
                    !cryptoWalletStore.state().isConfigured
                      ? "Configure crypto wallet first"
                      : ""
                  }
                >
                  <span class="text-2xl">🔐</span>
                  <span
                    class={`text-[0.85rem] ${settingsState.app.preferredPaymentMethod === "crypto" ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    Crypto Wallet
                  </span>
                </button>
              </div>
            </div>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.enablePaymentFallback}
                  onChange={(e) =>
                    handleBooleanChange(
                      "enablePaymentFallback",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable Fallback Payment
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Use alternate method if preferred has insufficient funds
                  </span>
                </span>
              </label>
            </div>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted-foreground border-t border-border-medium pt-5">
              Auto Top-Up
            </h4>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.autoTopUpEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "autoTopUpEnabled",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable Auto Top-Up
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Automatically add funds when balance is low
                  </span>
                </span>
              </label>
            </div>

            <Show when={settingsState.app.autoTopUpEnabled}>
              <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
                <label class="flex flex-col gap-0.5 flex-1">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Top-Up Threshold
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Trigger top-up when balance falls below ($)
                  </span>
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={settingsState.app.autoTopUpThreshold}
                  onInput={(e) =>
                    handleNumberChange(
                      "autoTopUpThreshold",
                      e.currentTarget.value,
                    )
                  }
                  class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
                />
              </div>

              <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
                <label class="flex flex-col gap-0.5 flex-1">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Top-Up Amount
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Amount to add when auto top-up triggers ($)
                  </span>
                </label>
                <input
                  type="number"
                  min="10"
                  step="5"
                  value={settingsState.app.autoTopUpAmount}
                  onInput={(e) =>
                    handleNumberChange("autoTopUpAmount", e.currentTarget.value)
                  }
                  class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
                />
              </div>
            </Show>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted-foreground border-t border-border-medium pt-5">
              Crypto Wallet (USDC Payments)
            </h4>
            <p class="m-0 mb-4 text-[0.85rem] text-muted-foreground leading-relaxed">
              Configure your crypto wallet for x402 USDC payments to MCP
              servers.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Auto-Approve Limit
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Auto-approve payments up to this amount (USD)
                </span>
              </label>
              <input
                type="number"
                min="0"
                max="10"
                step="0.01"
                aria-label="Auto-approve limit in USD"
                value={settingsState.app.cryptoAutoApproveLimit}
                onInput={(e) =>
                  handleNumberChange(
                    "cryptoAutoApproveLimit",
                    e.currentTarget.value,
                  )
                }
                class="w-[100px] px-3 py-2 bg-surface-3/80 border border-border-strong rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <Show
              when={cryptoWalletStore.state().isConfigured}
              fallback={
                <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
                  <label class="flex flex-col gap-0.5 flex-1">
                    <span class="text-[0.95rem] font-medium text-foreground">
                      Private Key
                    </span>
                    <span class="text-[0.8rem] text-muted-foreground">
                      Enter your wallet private key (64 hex characters)
                    </span>
                  </label>
                  <div class="flex flex-col gap-2 w-full max-w-md">
                    <div class="flex gap-2">
                      <input
                        type="password"
                        placeholder="0x... or 64 hex characters"
                        value={privateKeyInput()}
                        onInput={(e) =>
                          setPrivateKeyInput(e.currentTarget.value)
                        }
                        class={`flex-1 px-3 py-2.5 bg-surface-3/80 border rounded-md text-foreground text-[0.9rem] font-mono focus:outline-none focus:border-accent ${
                          privateKeyInput() &&
                          !isValidPrivateKeyFormat(privateKeyInput())
                            ? "border-destructive"
                            : "border-border-strong"
                        }`}
                      />
                      <button
                        type="button"
                        class="px-5 py-2.5 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 whitespace-nowrap hover:not-disabled:bg-primary/85 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={
                          !isValidPrivateKeyFormat(privateKeyInput()) ||
                          cryptoWalletStore.state().isLoading
                        }
                        onClick={handleSavePrivateKey}
                      >
                        {cryptoWalletStore.state().isLoading
                          ? "Saving..."
                          : "Save"}
                      </button>
                    </div>
                    <Show
                      when={
                        privateKeyInput() &&
                        !isValidPrivateKeyFormat(privateKeyInput())
                      }
                    >
                      <span class="text-[0.8rem] text-destructive">
                        Invalid key format. Must be 64 hex characters.
                      </span>
                    </Show>
                    <Show when={cryptoWalletStore.state().error}>
                      <span class="text-[0.8rem] text-destructive">
                        {cryptoWalletStore.state().error}
                      </span>
                    </Show>
                  </div>
                </div>
              }
            >
              <div class="mt-2">
                <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
                  <label class="flex flex-col gap-0.5 flex-1">
                    <span class="text-[0.95rem] font-medium text-foreground">
                      Wallet Address
                    </span>
                    <span class="text-[0.8rem] text-muted-foreground">
                      Your configured wallet for USDC payments
                    </span>
                  </label>
                  <div class="flex items-center gap-3 flex-wrap">
                    <code class="flex-1 px-3 py-2.5 bg-surface-3/60 border border-border-hover rounded-md text-[0.85rem] text-foreground font-mono break-all">
                      {cryptoWalletStore.state().address}
                    </code>
                    <button
                      type="button"
                      class="px-4 py-2.5 bg-transparent border border-destructive/50 rounded-md text-destructive text-[0.9rem] cursor-pointer transition-all duration-150 whitespace-nowrap hover:bg-destructive/10 hover:border-destructive"
                      onClick={() => setShowClearConfirm(true)}
                    >
                      Remove Wallet
                    </button>
                  </div>
                </div>

                <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
                  <label class="flex flex-col gap-0.5 flex-1">
                    <span class="text-[0.95rem] font-medium text-foreground">
                      USDC Balance (Base)
                    </span>
                    <span class="text-[0.8rem] text-muted-foreground">
                      Your current USDC balance on Base mainnet
                    </span>
                  </label>
                  <div class="flex items-center gap-3">
                    <Show
                      when={!cryptoWalletStore.state().balanceLoading}
                      fallback={
                        <span class="px-4 py-2.5 bg-surface-3/60 border border-border-hover rounded-md text-[0.9rem] text-muted-foreground min-w-[140px]">
                          Loading balance...
                        </span>
                      }
                    >
                      <span class="px-4 py-2.5 bg-surface-3/60 border border-border-hover rounded-md text-[1.1rem] font-semibold text-foreground font-mono min-w-[140px]">
                        {cryptoWalletStore.state().usdcBalance !== null
                          ? `${cryptoWalletStore.state().usdcBalance} USDC`
                          : "—"}
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="w-9 h-9 flex items-center justify-center bg-surface-3/60 border border-border-hover rounded-md text-[1.2rem] text-muted-foreground cursor-pointer transition-all duration-150 hover:not-disabled:bg-border hover:not-disabled:border-muted-foreground/40 hover:not-disabled:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => cryptoWalletStore.fetchBalance()}
                      disabled={cryptoWalletStore.state().balanceLoading}
                      title="Refresh balance"
                    >
                      ↻
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          </section>
        </Show>

        <Show when={activeSection() === "agent"}>
          <section>
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Agent</h3>
            <p class="m-0 mb-6 text-muted-foreground leading-normal">
              Configure sandbox security and permissions for AI agent sessions.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Sandbox Mode
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Controls what the agent can access on your system
                </span>
              </label>
              <div class="flex gap-3">
                <For
                  each={
                    [
                      {
                        value: "read-only",
                        label: "Read Only",
                        desc: "Read files only, no writes or network",
                      },
                      {
                        value: "workspace-write",
                        label: "Workspace Write",
                        desc: "Write workspace, network, secrets blocked",
                      },
                      {
                        value: "full-access",
                        label: "Full Access",
                        desc: "No restrictions at all",
                      },
                    ] as const
                  }
                >
                  {(mode) => (
                    <button
                      type="button"
                      class={`flex flex-col items-center gap-2 px-6 py-4 bg-surface-3/60 border-2 rounded-lg cursor-pointer transition-all duration-150 ${
                        settingsState.app.agentSandboxMode === mode.value
                          ? "border-accent bg-primary/10"
                          : "border-border-hover hover:border-muted-foreground/40"
                      }`}
                      onClick={() =>
                        handleStringChange("agentSandboxMode", mode.value)
                      }
                    >
                      <span class="text-2xl">
                        {mode.value === "read-only"
                          ? "\u{1F512}"
                          : mode.value === "workspace-write"
                            ? "\u{1F4DD}"
                            : "\u26A0\uFE0F"}
                      </span>
                      <span
                        class={`text-[0.85rem] ${settingsState.app.agentSandboxMode === mode.value ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {mode.label}
                      </span>
                      <span class="text-[0.7rem] text-muted-foreground text-center">
                        {mode.desc}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Approval Policy
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  When the agent requires human approval before executing
                  commands
                </span>
              </label>
              <div class="flex gap-3">
                <For
                  each={
                    [
                      {
                        value: "untrusted",
                        label: "Untrusted",
                        desc: "Approve all untrusted commands",
                      },
                      {
                        value: "on-failure",
                        label: "On Failure",
                        desc: "Approve only when commands fail",
                      },
                      {
                        value: "on-request",
                        label: "On Request",
                        desc: "Model decides when to ask",
                      },
                      {
                        value: "never",
                        label: "Never",
                        desc: "Fully autonomous, no approval",
                      },
                    ] as const
                  }
                >
                  {(mode) => (
                    <button
                      type="button"
                      title={
                        mode.value === "untrusted"
                          ? "Only run trusted commands (ls, cat, sed) without approval. Escalates for untrusted commands."
                          : mode.value === "on-failure"
                            ? "Run all commands without approval. Only asks if a command fails to execute."
                            : mode.value === "on-request"
                              ? "The model decides when to ask the user for approval."
                              : "Never ask for approval. Execution failures are returned directly to the model."
                      }
                      class={`flex flex-col items-center gap-2 px-4 py-3 bg-surface-3/60 border-2 rounded-lg cursor-pointer transition-all duration-150 ${
                        settingsState.app.agentApprovalPolicy === mode.value
                          ? "border-accent bg-primary/10"
                          : "border-border-hover hover:border-muted-foreground/40"
                      }`}
                      onClick={() =>
                        handleStringChange("agentApprovalPolicy", mode.value)
                      }
                    >
                      <span
                        class={`text-[0.85rem] ${settingsState.app.agentApprovalPolicy === mode.value ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {mode.label}
                      </span>
                      <span class="text-[0.7rem] text-muted-foreground text-center">
                        {mode.desc}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Quick Presets
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Apply common sandbox + approval combinations
                </span>
              </label>
              <div class="flex gap-3">
                <button
                  type="button"
                  title="Convenience preset: workspace-write sandbox + on-request approval"
                  class={`px-4 py-2 text-[0.85rem] rounded-lg border-2 cursor-pointer transition-all duration-150 ${
                    settingsState.app.agentSandboxMode === "workspace-write" &&
                    settingsState.app.agentApprovalPolicy === "on-request"
                      ? "border-accent bg-primary/10 text-foreground"
                      : "border-border-hover bg-surface-3/60 text-muted-foreground hover:border-muted-foreground/40"
                  }`}
                  onClick={() => {
                    handleStringChange("agentSandboxMode", "workspace-write");
                    handleStringChange("agentApprovalPolicy", "on-request");
                  }}
                >
                  Recommended
                </button>
                <button
                  type="button"
                  title="DANGEROUS: Removes all sandbox restrictions and approval requirements"
                  class={`px-4 py-2 text-[0.85rem] rounded-lg border-2 cursor-pointer transition-all duration-150 ${
                    settingsState.app.agentSandboxMode === "full-access" &&
                    settingsState.app.agentApprovalPolicy === "never"
                      ? "border-red-500 bg-destructive/10 text-red-400"
                      : "border-red-500/30 bg-surface-3/60 text-red-400/70 hover:border-red-500/60"
                  }`}
                  onClick={() => {
                    handleStringChange("agentSandboxMode", "full-access");
                    handleStringChange("agentApprovalPolicy", "never");
                  }}
                >
                  Bypass All Safety
                </button>
              </div>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.agentSearchEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "agentSearchEnabled",
                      e.currentTarget.checked,
                    )
                  }
                  class="mt-1 w-4 h-4 accent-[var(--color-primary,#6366f1)]"
                />
                <div class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable Web Search
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Allow the agent to search the web during sessions
                  </span>
                </div>
              </label>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.agentNetworkEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "agentNetworkEnabled",
                      e.currentTarget.checked,
                    )
                  }
                  class="mt-1 w-4 h-4 accent-[var(--color-primary,#6366f1)]"
                />
                <div class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable Network Access
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Allow the agent to make network requests (disabling
                    restricts to workspace-write sandbox)
                  </span>
                </div>
              </label>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.agentAutoApproveReads}
                  onChange={(e) =>
                    handleBooleanChange(
                      "agentAutoApproveReads",
                      e.currentTarget.checked,
                    )
                  }
                  class="mt-1 w-4 h-4 accent-[var(--color-primary,#6366f1)]"
                />
                <div class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Auto-approve read operations
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Automatically approve file read requests without prompting
                  </span>
                </div>
              </label>
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "appearance"}>
          <section>
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Appearance</h3>
            <p class="m-0 mb-6 text-muted-foreground leading-normal">
              Customize how Seren Desktop looks.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">
                  Theme
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  Choose your preferred color scheme
                </span>
              </label>
              <div class="flex gap-3">
                <For each={["dark", "light", "system"] as const}>
                  {(theme) => (
                    <button
                      type="button"
                      class={`flex flex-col items-center gap-2 px-6 py-4 bg-surface-3/60 border-2 rounded-lg cursor-pointer transition-all duration-150 ${
                        settingsState.app.theme === theme
                          ? "border-accent bg-primary/10"
                          : "border-border-hover hover:border-muted-foreground/40"
                      }`}
                      onClick={() => handleThemeChange(theme)}
                    >
                      <span class="text-2xl">
                        {theme === "dark"
                          ? "🌙"
                          : theme === "light"
                            ? "☀️"
                            : "💻"}
                      </span>
                      <span
                        class={`text-[0.85rem] ${settingsState.app.theme === theme ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {theme.charAt(0).toUpperCase() + theme.slice(1)}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "indexing"}>
          <section>
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">
              Semantic Code Indexing
            </h3>
            <p class="m-0 mb-6 text-muted-foreground leading-normal">
              Enable semantic search across your codebase. Powered by
              SerenEmbed.
            </p>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.semanticIndexingEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "semanticIndexingEnabled",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable Semantic Indexing
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Index your codebase for AI-powered semantic code search.
                    Embeddings are generated via SerenEmbed (paid via
                    SerenBucks) and stored locally for instant retrieval.
                  </span>
                </span>
              </label>
            </div>

            <div class="mt-6 p-4 bg-primary/10 border border-primary/30 rounded">
              <h4 class="m-0 mb-2 text-sm font-semibold text-foreground">
                How It Works
              </h4>
              <ul class="m-0 pl-4 text-[0.8rem] text-muted-foreground space-y-2">
                <li>Your code is chunked at function/class boundaries</li>
                <li>
                  SerenEmbed generates embeddings (charged via SerenBucks)
                </li>
                <li>
                  Embeddings are stored locally in sqlite-vec for instant search
                </li>
                <li>
                  AI automatically retrieves relevant code when you ask
                  questions
                </li>
              </ul>
            </div>

            <div class="mt-6 p-4 bg-warning/10 border border-warning/30 rounded">
              <h4 class="m-0 mb-2 text-sm font-semibold text-foreground">
                Cost Estimate
              </h4>
              <p class="m-0 text-[0.8rem] text-muted-foreground">
                Indexing cost depends on your codebase size. A typical project
                with 100 files (~50k lines) costs approximately 100-200k tokens.
                Use the "Start Indexing" button in the editor sidebar to see the
                exact estimate before proceeding.
              </p>
            </div>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted-foreground border-t border-border-medium pt-5">
              Persistent Memory
            </h4>
            <p class="m-0 mb-4 text-[0.85rem] text-muted-foreground leading-relaxed">
              Store and recall context across sessions. Requires a SerenDB
              account.
            </p>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.memoryEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "memoryEnabled",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable Memory
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Persist conversations, preferences, and knowledge across
                    sessions. Memory data is stored in your SerenDB project. You
                    must be logged in to SerenDB to use this feature.
                  </span>
                </span>
              </label>
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "general"}>
          <section>
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">
              General Settings
            </h3>
            <p class="m-0 mb-6 text-muted-foreground leading-normal">
              Configure application behavior and privacy options.
            </p>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-border">
              <label class="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsState.app.telemetryEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "telemetryEnabled",
                      e.currentTarget.checked,
                    )
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Enable Telemetry
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Help improve Seren by sharing anonymous usage data
                  </span>
                </span>
              </label>
            </div>

            <Show when={authStore.isAuthenticated}>
              <div class="flex items-center justify-between py-3 border-b border-border">
                <span class="flex flex-col gap-0.5">
                  <span class="text-[0.95rem] font-medium text-foreground">
                    Sign Out
                  </span>
                  <span class="text-[0.8rem] text-muted-foreground">
                    Sign out of your Seren account
                  </span>
                </span>
                <button
                  type="button"
                  class="px-4 py-1.5 border border-red-500/30 rounded-md bg-red-500/10 text-red-400 text-[0.85rem] font-medium cursor-pointer transition-all duration-100 hover:bg-red-500/20 hover:border-red-500/50 active:scale-95"
                  onClick={props.onLogout}
                >
                  Sign Out
                </button>
              </div>
            </Show>
          </section>
        </Show>

        <Show when={activeSection() === "mcp"}>
          <section>
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">MCP Servers</h3>
            <p class="m-0 mb-6 text-muted-foreground leading-normal">
              Manage Model Context Protocol server connections for enhanced AI
              capabilities.
            </p>

            <Show
              when={mcpSettings().servers.length > 0}
              fallback={
                <div class="text-center py-10 px-6 text-muted-foreground">
                  <span class="text-[2.5rem] block mb-3 opacity-60">🔌</span>
                  <p class="m-0">No MCP servers configured</p>
                  <p class="m-0 mt-2 text-[0.85rem] text-muted-foreground">
                    MCP servers extend AI capabilities with tools like file
                    access, web browsing, and more.
                  </p>
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={mcpSettings().servers}>
                  {(server) => (
                    <div
                      class={`flex items-center justify-between px-4 py-3 bg-surface-3/60 border border-border-hover rounded-lg ${
                        !server.enabled ? "opacity-60" : ""
                      }`}
                    >
                      <div class="flex flex-col gap-1">
                        <div class="flex items-center gap-2">
                          <span class="font-medium text-foreground">
                            {server.name}
                          </span>
                          <Show
                            when={
                              server.autoConnect && server.name !== "Seren MCP"
                            }
                          >
                            <span class="px-1.5 py-0.5 bg-primary/20 rounded text-[0.7rem] text-accent">
                              Auto-connect
                            </span>
                          </Show>
                        </div>
                        <span class="text-[0.8rem] text-muted-foreground">
                          {server.name === "Seren MCP"
                            ? "Connected to Seren MCP Gateway"
                            : isLocalServer(server)
                              ? `Command: ${server.command} ${server.args.join(" ")}`
                              : isBuiltinServer(server)
                                ? server.description || "Built-in server"
                                : "Unknown type"}
                        </span>
                      </div>
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          class={`px-3 py-1 border-none rounded text-[0.8rem] cursor-pointer transition-all duration-150 hover:opacity-80 ${
                            server.enabled
                              ? "bg-success/20 text-success"
                              : "bg-border-hover text-muted-foreground"
                          }`}
                          onClick={() => handleToggleMcpServer(server.name)}
                          title={server.enabled ? "Disable" : "Enable"}
                        >
                          {server.enabled ? "On" : "Off"}
                        </button>
                        <button
                          type="button"
                          class="w-7 h-7 flex items-center justify-center bg-transparent border-none rounded text-[1.2rem] text-muted-foreground cursor-pointer transition-all duration-150 hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => handleRemoveMcpServer(server.name)}
                          title="Remove server"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Show>

        <Show when={activeSection() === "openclaw"}>
          <OpenClawSettings />
        </Show>
      </main>

      <Show when={showResetConfirm()}>
        <div
          class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]"
          onClick={() => setShowResetConfirm(false)}
        >
          <div
            class="bg-popover border border-border-strong rounded-xl p-6 max-w-[400px] w-[90%]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 class="m-0 mb-3 text-[1.1rem]">Reset All Settings?</h3>
            <p class="m-0 mb-5 text-muted-foreground leading-normal">
              This will restore all settings to their default values. This
              cannot be undone.
            </p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="px-4 py-2 bg-transparent border border-border-strong rounded-md text-muted-foreground text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-border"
                onClick={() => setShowResetConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="px-4 py-2 bg-destructive border-none rounded-md text-white text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-destructive/85"
                onClick={handleResetAll}
              >
                Reset All
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={showClearConfirm()}>
        <div
          class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]"
          onClick={() => setShowClearConfirm(false)}
        >
          <div
            class="bg-popover border border-border-strong rounded-xl p-6 max-w-[400px] w-[90%]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 class="m-0 mb-3 text-[1.1rem]">Remove Crypto Wallet?</h3>
            <p class="m-0 mb-5 text-muted-foreground leading-normal">
              This will delete your private key from this device. You will need
              to re-enter it to make USDC payments.
            </p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="px-4 py-2 bg-transparent border border-border-strong rounded-md text-muted-foreground text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-border"
                onClick={() => setShowClearConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="px-4 py-2 bg-destructive border-none rounded-md text-white text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-destructive/85"
                onClick={handleClearCryptoWallet}
              >
                Remove Wallet
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

/**
 * Banner shown in wallet settings when daily claim was dismissed but is still available.
 */
const DailyClaimBanner: Component = () => {
  const [claiming, setClaiming] = createSignal(false);
  const [claimedAmount, setClaimedAmount] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const canClaim = () => {
    const claim = walletState.dailyClaim;
    return claim?.can_claim;
  };

  const handleClaim = async () => {
    setClaiming(true);
    setError(null);
    try {
      const result = await claimDaily();
      setClaimedAmount(result.amount_usd);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to claim daily credits",
      );
    } finally {
      setClaiming(false);
    }
  };

  return (
    <Show when={canClaim() && !claimedAmount()}>
      <div class="flex items-center justify-between gap-4 py-3 px-4 mb-4 rounded-lg border border-primary/30 bg-primary/[0.08]">
        <div class="flex flex-col gap-0.5">
          <span class="text-[0.95rem] font-medium text-foreground">
            {walletState.dailyClaim?.claim_amount_usd
              ? `${walletState.dailyClaim.claim_amount_usd} SerenBucks Available`
              : "Daily SerenBucks Available"}
          </span>
          <span class="text-[0.8rem] text-muted-foreground">
            {walletState.dailyClaim?.claim_amount_usd
              ? `Claim your ${walletState.dailyClaim.claim_amount_usd} of SerenBucks`
              : "Claim your free daily credits"}
          </span>
          <Show when={error()}>
            <span class="text-[0.75rem] text-destructive">{error()}</span>
          </Show>
        </div>
        <button
          class="py-1.5 px-4 text-[0.8125rem] font-medium rounded-md cursor-pointer bg-primary text-white border-none hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150"
          onClick={handleClaim}
          disabled={claiming()}
        >
          {claiming() ? "Claiming..." : "Claim Now"}
        </button>
      </div>
    </Show>
  );
};

export default SettingsPanel;
