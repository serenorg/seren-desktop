// ABOUTME: Settings panel UI for managing user preferences.
// ABOUTME: Provides controls for editor, wallet, theme, and MCP settings.

import { type Component, createSignal, For, Show } from "solid-js";
import { isBuiltinServer, isLocalServer } from "@/lib/mcp/types";
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
import { ProviderSettings } from "./ProviderSettings";
import { SearchableModelSelect } from "./SearchableModelSelect";

type SettingsSection =
  | "chat"
  | "providers"
  | "editor"
  | "wallet"
  | "appearance"
  | "general"
  | "mcp";

export const SettingsPanel: Component = () => {
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
    { id: "chat", label: "Chat", icon: "💬" },
    { id: "providers", label: "AI Providers", icon: "🤖" },
    { id: "editor", label: "Editor", icon: "📝" },
    { id: "wallet", label: "Wallet", icon: "💳" },
    { id: "appearance", label: "Appearance", icon: "🎨" },
    { id: "general", label: "General", icon: "⚙️" },
    { id: "mcp", label: "MCP Servers", icon: "🔌" },
  ];

  return (
    <div class="flex h-full bg-surface text-foreground">
      <aside class="w-[220px] min-w-[180px] flex flex-col bg-popover border-r border-[rgba(148,163,184,0.25)]">
        <h2 class="px-4 pt-5 pb-3 m-0 text-[1.1rem] font-semibold text-foreground">Settings</h2>
        <nav class="flex-1 flex flex-col px-2 py-1 gap-0.5">
          <For each={sections}>
            {(section) => (
              <button
                type="button"
                class={`flex items-center gap-2.5 px-3 py-2.5 bg-transparent border-none rounded-md cursor-pointer text-[0.9rem] text-left transition-all duration-150 ${
                  activeSection() === section.id
                    ? "bg-accent text-white"
                    : "text-muted hover:bg-[rgba(148,163,184,0.1)] hover:text-foreground"
                }`}
                onClick={() => setActiveSection(section.id)}
              >
                <span class="text-[1.1rem]">{section.icon}</span>
                {section.label}
              </button>
            )}
          </For>
        </nav>
        <div class="p-3 border-t border-[rgba(148,163,184,0.15)]">
          <button
            type="button"
            class="w-full py-2 px-2 bg-transparent border border-[rgba(148,163,184,0.3)] rounded-md text-muted text-[0.85rem] cursor-pointer transition-all duration-150 hover:bg-[rgba(239,68,68,0.1)] hover:border-[rgba(239,68,68,0.5)] hover:text-[#ef4444]"
            onClick={() => setShowResetConfirm(true)}
          >
            Reset All Settings
          </button>
        </div>
      </aside>

      <main class="flex-1 px-8 py-6 overflow-y-auto">
        <Show when={activeSection() === "chat"}>
          <section class="settings-section">
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Chat Settings</h3>
            <p class="m-0 mb-6 text-muted leading-normal">
              Configure AI chat behavior and conversation history.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Default Model</span>
                <span class="text-[0.8rem] text-muted">AI model for chat conversations</span>
              </label>
              <SearchableModelSelect
                value={settingsState.app.chatDefaultModel}
                onChange={handleDefaultModelChange}
                placeholder="Select a model"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">History Limit</span>
                <span class="text-[0.8rem] text-muted">
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
                class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
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
                  <span class="text-[0.95rem] font-medium text-foreground">Enter to Send</span>
                  <span class="text-[0.8rem] text-muted">
                    Press Enter to send messages (Shift+Enter for new line)
                  </span>
                </span>
              </label>
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "providers"}>
          <ProviderSettings />
        </Show>

        <Show when={activeSection() === "editor"}>
          <section class="settings-section">
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Editor Settings</h3>
            <p class="m-0 mb-6 text-muted leading-normal">
              Customize your code editing experience.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Font Size</span>
                <span class="text-[0.8rem] text-muted">Size of text in the editor (px)</span>
              </label>
              <input
                type="number"
                min="10"
                max="32"
                value={settingsState.app.editorFontSize}
                onInput={(e) =>
                  handleNumberChange("editorFontSize", e.currentTarget.value)
                }
                class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Tab Size</span>
                <span class="text-[0.8rem] text-muted">Number of spaces per tab</span>
              </label>
              <input
                type="number"
                min="1"
                max="8"
                value={settingsState.app.editorTabSize}
                onInput={(e) =>
                  handleNumberChange("editorTabSize", e.currentTarget.value)
                }
                class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
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
                  <span class="text-[0.95rem] font-medium text-foreground">Word Wrap</span>
                  <span class="text-[0.8rem] text-muted">
                    Wrap long lines instead of scrolling
                  </span>
                </span>
              </label>
            </div>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted border-t border-[rgba(148,163,184,0.15)] pt-5">Code Completion</h4>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
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
                  <span class="text-[0.95rem] font-medium text-foreground">Enable AI Completions</span>
                  <span class="text-[0.8rem] text-muted">
                    Show AI-powered code suggestions while typing
                  </span>
                </span>
              </label>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Completion Delay</span>
                <span class="text-[0.8rem] text-muted">
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
                class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Completion Model</span>
                <span class="text-[0.8rem] text-muted">AI model for code completions</span>
              </label>
              <SearchableModelSelect
                value={settingsState.app.completionModelId}
                onChange={(value) =>
                  handleStringChange("completionModelId", value)
                }
                placeholder="Select a model"
              />
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Max Suggestion Lines</span>
                <span class="text-[0.8rem] text-muted">
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
                class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "wallet"}>
          <section class="settings-section">
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Wallet Settings</h3>
            <p class="m-0 mb-6 text-muted leading-normal">
              Configure your SerenBucks balance display and auto top-up.
            </p>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
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
                  <span class="text-[0.95rem] font-medium text-foreground">Show Balance in Status Bar</span>
                  <span class="text-[0.8rem] text-muted">
                    Display your SerenBucks balance at the bottom of the app
                  </span>
                </span>
              </label>
            </div>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Low Balance Warning</span>
                <span class="text-[0.8rem] text-muted">
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
                class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted border-t border-[rgba(148,163,184,0.15)] pt-5">Payment Method</h4>
            <p class="m-0 mb-4 text-[0.85rem] text-muted leading-relaxed">
              Choose your preferred payment method for MCP server tools.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Preferred Method</span>
                <span class="text-[0.8rem] text-muted">
                  Default payment method for MCP tool usage
                </span>
              </label>
              <div class="flex gap-3">
                <button
                  type="button"
                  class={`flex flex-col items-center gap-2 px-6 py-4 bg-[rgba(30,30,30,0.6)] border-2 rounded-lg cursor-pointer transition-all duration-150 min-w-[120px] ${
                    settingsState.app.preferredPaymentMethod === "serenbucks"
                      ? "border-accent bg-[rgba(99,102,241,0.1)]"
                      : "border-[rgba(148,163,184,0.2)] hover:border-[rgba(148,163,184,0.4)]"
                  }`}
                  onClick={() =>
                    handleStringChange("preferredPaymentMethod", "serenbucks")
                  }
                >
                  <span class="text-2xl">💰</span>
                  <span class={`text-[0.85rem] ${settingsState.app.preferredPaymentMethod === "serenbucks" ? "text-foreground" : "text-muted"}`}>SerenBucks</span>
                </button>
                <button
                  type="button"
                  class={`flex flex-col items-center gap-2 px-6 py-4 bg-[rgba(30,30,30,0.6)] border-2 rounded-lg cursor-pointer transition-all duration-150 min-w-[120px] disabled:opacity-50 disabled:cursor-not-allowed ${
                    settingsState.app.preferredPaymentMethod === "crypto"
                      ? "border-accent bg-[rgba(99,102,241,0.1)]"
                      : "border-[rgba(148,163,184,0.2)] hover:not-disabled:border-[rgba(148,163,184,0.4)]"
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
                  <span class={`text-[0.85rem] ${settingsState.app.preferredPaymentMethod === "crypto" ? "text-foreground" : "text-muted"}`}>Crypto Wallet</span>
                </button>
              </div>
            </div>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
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
                  <span class="text-[0.95rem] font-medium text-foreground">Enable Fallback Payment</span>
                  <span class="text-[0.8rem] text-muted">
                    Use alternate method if preferred has insufficient funds
                  </span>
                </span>
              </label>
            </div>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted border-t border-[rgba(148,163,184,0.15)] pt-5">Auto Top-Up</h4>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
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
                  <span class="text-[0.95rem] font-medium text-foreground">Enable Auto Top-Up</span>
                  <span class="text-[0.8rem] text-muted">
                    Automatically add funds when balance is low
                  </span>
                </span>
              </label>
            </div>

            <Show when={settingsState.app.autoTopUpEnabled}>
              <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
                <label class="flex flex-col gap-0.5 flex-1">
                  <span class="text-[0.95rem] font-medium text-foreground">Top-Up Threshold</span>
                  <span class="text-[0.8rem] text-muted">
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
                  class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
                />
              </div>

              <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
                <label class="flex flex-col gap-0.5 flex-1">
                  <span class="text-[0.95rem] font-medium text-foreground">Top-Up Amount</span>
                  <span class="text-[0.8rem] text-muted">
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
                  class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
                />
              </div>
            </Show>

            <h4 class="mt-6 mb-3 text-base font-semibold text-muted border-t border-[rgba(148,163,184,0.15)] pt-5">Crypto Wallet (USDC Payments)</h4>
            <p class="m-0 mb-4 text-[0.85rem] text-muted leading-relaxed">
              Configure your crypto wallet for x402 USDC payments to MCP
              servers.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Auto-Approve Limit</span>
                <span class="text-[0.8rem] text-muted">
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
                class="w-[100px] px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-[0.9rem] text-right focus:outline-none focus:border-accent"
              />
            </div>

            <Show
              when={cryptoWalletStore.state().isConfigured}
              fallback={
                <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
                  <label class="flex flex-col gap-0.5 flex-1">
                    <span class="text-[0.95rem] font-medium text-foreground">Private Key</span>
                    <span class="text-[0.8rem] text-muted">
                      Enter your wallet private key (64 hex characters)
                    </span>
                  </label>
                  <div class="flex flex-col gap-2 w-full max-w-md">
                    <div class="flex gap-2">
                      <input
                        type="password"
                        placeholder="0x... or 64 hex characters"
                        value={privateKeyInput()}
                        onInput={(e) => setPrivateKeyInput(e.currentTarget.value)}
                        class={`flex-1 px-3 py-2.5 bg-[rgba(30,30,30,0.8)] border rounded-md text-foreground text-[0.9rem] font-mono focus:outline-none focus:border-accent ${
                          privateKeyInput() && !isValidPrivateKeyFormat(privateKeyInput())
                            ? "border-[#ef4444]"
                            : "border-[rgba(148,163,184,0.3)]"
                        }`}
                      />
                      <button
                        type="button"
                        class="px-5 py-2.5 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 whitespace-nowrap hover:not-disabled:bg-[#4f46e5] disabled:opacity-50 disabled:cursor-not-allowed"
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
                      <span class="text-[0.8rem] text-[#ef4444]">
                        Invalid key format. Must be 64 hex characters.
                      </span>
                    </Show>
                    <Show when={cryptoWalletStore.state().error}>
                      <span class="text-[0.8rem] text-[#ef4444]">
                        {cryptoWalletStore.state().error}
                      </span>
                    </Show>
                  </div>
                </div>
              }
            >
              <div class="mt-2">
                <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
                  <label class="flex flex-col gap-0.5 flex-1">
                    <span class="text-[0.95rem] font-medium text-foreground">Wallet Address</span>
                    <span class="text-[0.8rem] text-muted">
                      Your configured wallet for USDC payments
                    </span>
                  </label>
                  <div class="flex items-center gap-3 flex-wrap">
                    <code class="flex-1 px-3 py-2.5 bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-md text-[0.85rem] text-foreground font-mono break-all">
                      {cryptoWalletStore.state().address}
                    </code>
                    <button
                      type="button"
                      class="px-4 py-2.5 bg-transparent border border-[rgba(239,68,68,0.5)] rounded-md text-[#ef4444] text-[0.9rem] cursor-pointer transition-all duration-150 whitespace-nowrap hover:bg-[rgba(239,68,68,0.1)] hover:border-[#ef4444]"
                      onClick={() => setShowClearConfirm(true)}
                    >
                      Remove Wallet
                    </button>
                  </div>
                </div>

                <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
                  <label class="flex flex-col gap-0.5 flex-1">
                    <span class="text-[0.95rem] font-medium text-foreground">USDC Balance (Base)</span>
                    <span class="text-[0.8rem] text-muted">
                      Your current USDC balance on Base mainnet
                    </span>
                  </label>
                  <div class="flex items-center gap-3">
                    <Show
                      when={!cryptoWalletStore.state().balanceLoading}
                      fallback={
                        <span class="px-4 py-2.5 bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-md text-[0.9rem] text-muted min-w-[140px]">Loading balance...</span>
                      }
                    >
                      <span class="px-4 py-2.5 bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-md text-[1.1rem] font-semibold text-foreground font-mono min-w-[140px]">
                        {cryptoWalletStore.state().usdcBalance !== null
                          ? `${cryptoWalletStore.state().usdcBalance} USDC`
                          : "—"}
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="w-9 h-9 flex items-center justify-center bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-md text-[1.2rem] text-muted cursor-pointer transition-all duration-150 hover:not-disabled:bg-[rgba(148,163,184,0.1)] hover:not-disabled:border-[rgba(148,163,184,0.4)] hover:not-disabled:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
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

        <Show when={activeSection() === "appearance"}>
          <section class="settings-section">
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Appearance</h3>
            <p class="m-0 mb-6 text-muted leading-normal">
              Customize how Seren Desktop looks.
            </p>

            <div class="flex items-start justify-between gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
              <label class="flex flex-col gap-0.5 flex-1">
                <span class="text-[0.95rem] font-medium text-foreground">Theme</span>
                <span class="text-[0.8rem] text-muted">
                  Choose your preferred color scheme
                </span>
              </label>
              <div class="flex gap-3">
                <For each={["dark", "light", "system"] as const}>
                  {(theme) => (
                    <button
                      type="button"
                      class={`flex flex-col items-center gap-2 px-6 py-4 bg-[rgba(30,30,30,0.6)] border-2 rounded-lg cursor-pointer transition-all duration-150 ${
                        settingsState.app.theme === theme
                          ? "border-accent bg-[rgba(99,102,241,0.1)]"
                          : "border-[rgba(148,163,184,0.2)] hover:border-[rgba(148,163,184,0.4)]"
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
                      <span class={`text-[0.85rem] ${settingsState.app.theme === theme ? "text-foreground" : "text-muted"}`}>
                        {theme.charAt(0).toUpperCase() + theme.slice(1)}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "general"}>
          <section class="settings-section">
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">General Settings</h3>
            <p class="m-0 mb-6 text-muted leading-normal">
              Configure application behavior and privacy options.
            </p>

            <div class="flex items-start justify-start gap-4 py-3 border-b border-[rgba(148,163,184,0.1)]">
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
                  <span class="text-[0.95rem] font-medium text-foreground">Enable Telemetry</span>
                  <span class="text-[0.8rem] text-muted">
                    Help improve Seren by sharing anonymous usage data
                  </span>
                </span>
              </label>
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "mcp"}>
          <section class="settings-section">
            <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">MCP Servers</h3>
            <p class="m-0 mb-6 text-muted leading-normal">
              Manage Model Context Protocol server connections for enhanced AI
              capabilities.
            </p>

            <Show
              when={mcpSettings().servers.length > 0}
              fallback={
                <div class="text-center py-10 px-6 text-muted">
                  <span class="text-[2.5rem] block mb-3 opacity-60">🔌</span>
                  <p class="m-0">No MCP servers configured</p>
                  <p class="m-0 mt-2 text-[0.85rem] text-muted">
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
                      class={`flex items-center justify-between px-4 py-3 bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg ${
                        !server.enabled ? "opacity-60" : ""
                      }`}
                    >
                      <div class="flex flex-col gap-1">
                        <div class="flex items-center gap-2">
                          <span class="font-medium text-foreground">{server.name}</span>
                          <Show when={server.autoConnect}>
                            <span class="px-1.5 py-0.5 bg-[rgba(99,102,241,0.2)] rounded text-[0.7rem] text-accent">Auto-connect</span>
                          </Show>
                        </div>
                        <span class="text-[0.8rem] text-muted font-mono">
                          {isLocalServer(server)
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
                              ? "bg-[rgba(34,197,94,0.2)] text-[#22c55e]"
                              : "bg-[rgba(148,163,184,0.2)] text-muted"
                          }`}
                          onClick={() => handleToggleMcpServer(server.name)}
                          title={server.enabled ? "Disable" : "Enable"}
                        >
                          {server.enabled ? "On" : "Off"}
                        </button>
                        <button
                          type="button"
                          class="w-7 h-7 flex items-center justify-center bg-transparent border-none rounded text-[1.2rem] text-muted cursor-pointer transition-all duration-150 hover:bg-[rgba(239,68,68,0.1)] hover:text-[#ef4444]"
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
      </main>

      <Show when={showResetConfirm()}>
        <div
          class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]"
          onClick={() => setShowResetConfirm(false)}
        >
          <div class="bg-popover border border-[rgba(148,163,184,0.25)] rounded-xl p-6 max-w-[400px] w-[90%]" onClick={(e) => e.stopPropagation()}>
            <h3 class="m-0 mb-3 text-[1.1rem]">Reset All Settings?</h3>
            <p class="m-0 mb-5 text-muted leading-normal">
              This will restore all settings to their default values. This
              cannot be undone.
            </p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="px-4 py-2 bg-transparent border border-[rgba(148,163,184,0.3)] rounded-md text-muted text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-[rgba(148,163,184,0.1)]"
                onClick={() => setShowResetConfirm(false)}
              >
                Cancel
              </button>
              <button type="button" class="px-4 py-2 bg-[#ef4444] border-none rounded-md text-white text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-[#dc2626]" onClick={handleResetAll}>
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
          <div class="bg-popover border border-[rgba(148,163,184,0.25)] rounded-xl p-6 max-w-[400px] w-[90%]" onClick={(e) => e.stopPropagation()}>
            <h3 class="m-0 mb-3 text-[1.1rem]">Remove Crypto Wallet?</h3>
            <p class="m-0 mb-5 text-muted leading-normal">
              This will delete your private key from this device. You will need
              to re-enter it to make USDC payments.
            </p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="px-4 py-2 bg-transparent border border-[rgba(148,163,184,0.3)] rounded-md text-muted text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-[rgba(148,163,184,0.1)]"
                onClick={() => setShowClearConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="px-4 py-2 bg-[#ef4444] border-none rounded-md text-white text-[0.9rem] cursor-pointer transition-all duration-150 hover:bg-[#dc2626]"
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

export default SettingsPanel;
