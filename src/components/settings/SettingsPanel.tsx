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
import "./SettingsPanel.css";

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
    <div class="settings-panel">
      <aside class="settings-sidebar">
        <h2 class="settings-title">Settings</h2>
        <nav class="settings-nav">
          <For each={sections}>
            {(section) => (
              <button
                type="button"
                class={`settings-nav-item ${activeSection() === section.id ? "active" : ""}`}
                onClick={() => setActiveSection(section.id)}
              >
                <span class="settings-nav-icon">{section.icon}</span>
                {section.label}
              </button>
            )}
          </For>
        </nav>
        <div class="settings-sidebar-footer">
          <button
            type="button"
            class="settings-reset-btn"
            onClick={() => setShowResetConfirm(true)}
          >
            Reset All Settings
          </button>
        </div>
      </aside>

      <main class="settings-content">
        <Show when={activeSection() === "chat"}>
          <section class="settings-section">
            <h3>Chat Settings</h3>
            <p class="settings-description">
              Configure AI chat behavior and conversation history.
            </p>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Default Model</span>
                <span class="label-hint">AI model for chat conversations</span>
              </label>
              <SearchableModelSelect
                value={settingsState.app.chatDefaultModel}
                onChange={handleDefaultModelChange}
                placeholder="Select a model"
              />
            </div>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">History Limit</span>
                <span class="label-hint">
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
              />
            </div>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.chatEnterToSend}
                  onChange={(e) =>
                    handleBooleanChange(
                      "chatEnterToSend",
                      e.currentTarget.checked,
                    )
                  }
                />
                <span class="checkbox-label">
                  <span class="label-text">Enter to Send</span>
                  <span class="label-hint">
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
            <h3>Editor Settings</h3>
            <p class="settings-description">
              Customize your code editing experience.
            </p>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Font Size</span>
                <span class="label-hint">Size of text in the editor (px)</span>
              </label>
              <input
                type="number"
                min="10"
                max="32"
                value={settingsState.app.editorFontSize}
                onInput={(e) =>
                  handleNumberChange("editorFontSize", e.currentTarget.value)
                }
              />
            </div>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Tab Size</span>
                <span class="label-hint">Number of spaces per tab</span>
              </label>
              <input
                type="number"
                min="1"
                max="8"
                value={settingsState.app.editorTabSize}
                onInput={(e) =>
                  handleNumberChange("editorTabSize", e.currentTarget.value)
                }
              />
            </div>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.editorWordWrap}
                  onChange={(e) =>
                    handleBooleanChange(
                      "editorWordWrap",
                      e.currentTarget.checked,
                    )
                  }
                />
                <span class="checkbox-label">
                  <span class="label-text">Word Wrap</span>
                  <span class="label-hint">
                    Wrap long lines instead of scrolling
                  </span>
                </span>
              </label>
            </div>

            <h4>Code Completion</h4>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.completionEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "completionEnabled",
                      e.currentTarget.checked,
                    )
                  }
                />
                <span class="checkbox-label">
                  <span class="label-text">Enable AI Completions</span>
                  <span class="label-hint">
                    Show AI-powered code suggestions while typing
                  </span>
                </span>
              </label>
            </div>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Completion Delay</span>
                <span class="label-hint">
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
              />
            </div>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Completion Model</span>
                <span class="label-hint">AI model for code completions</span>
              </label>
              <SearchableModelSelect
                value={settingsState.app.completionModelId}
                onChange={(value) =>
                  handleStringChange("completionModelId", value)
                }
                placeholder="Select a model"
              />
            </div>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Max Suggestion Lines</span>
                <span class="label-hint">
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
              />
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "wallet"}>
          <section class="settings-section">
            <h3>Wallet Settings</h3>
            <p class="settings-description">
              Configure your SerenBucks balance display and auto top-up.
            </p>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.showBalance}
                  onChange={(e) =>
                    handleBooleanChange("showBalance", e.currentTarget.checked)
                  }
                />
                <span class="checkbox-label">
                  <span class="label-text">Show Balance in Status Bar</span>
                  <span class="label-hint">
                    Display your SerenBucks balance at the bottom of the app
                  </span>
                </span>
              </label>
            </div>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Low Balance Warning</span>
                <span class="label-hint">
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
              />
            </div>

            <h4>Payment Method</h4>
            <p class="settings-hint">
              Choose your preferred payment method for MCP server tools.
            </p>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Preferred Method</span>
                <span class="label-hint">
                  Default payment method for MCP tool usage
                </span>
              </label>
              <div class="payment-method-selector">
                <button
                  type="button"
                  class={`payment-method-option ${settingsState.app.preferredPaymentMethod === "serenbucks" ? "active" : ""}`}
                  onClick={() =>
                    handleStringChange("preferredPaymentMethod", "serenbucks")
                  }
                >
                  <span class="payment-method-icon">💰</span>
                  <span class="payment-method-label">SerenBucks</span>
                </button>
                <button
                  type="button"
                  class={`payment-method-option ${settingsState.app.preferredPaymentMethod === "crypto" ? "active" : ""}`}
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
                  <span class="payment-method-icon">🔐</span>
                  <span class="payment-method-label">Crypto Wallet</span>
                </button>
              </div>
            </div>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.enablePaymentFallback}
                  onChange={(e) =>
                    handleBooleanChange(
                      "enablePaymentFallback",
                      e.currentTarget.checked,
                    )
                  }
                />
                <span class="checkbox-label">
                  <span class="label-text">Enable Fallback Payment</span>
                  <span class="label-hint">
                    Use alternate method if preferred has insufficient funds
                  </span>
                </span>
              </label>
            </div>

            <h4>Auto Top-Up</h4>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.autoTopUpEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "autoTopUpEnabled",
                      e.currentTarget.checked,
                    )
                  }
                />
                <span class="checkbox-label">
                  <span class="label-text">Enable Auto Top-Up</span>
                  <span class="label-hint">
                    Automatically add funds when balance is low
                  </span>
                </span>
              </label>
            </div>

            <Show when={settingsState.app.autoTopUpEnabled}>
              <div class="settings-group">
                <label class="settings-label">
                  <span class="label-text">Top-Up Threshold</span>
                  <span class="label-hint">
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
                />
              </div>

              <div class="settings-group">
                <label class="settings-label">
                  <span class="label-text">Top-Up Amount</span>
                  <span class="label-hint">
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
                />
              </div>
            </Show>

            <h4>Crypto Wallet (USDC Payments)</h4>
            <p class="settings-hint">
              Configure your crypto wallet for x402 USDC payments to MCP
              servers.
            </p>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Auto-Approve Limit</span>
                <span class="label-hint">
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
              />
            </div>

            <Show
              when={cryptoWalletStore.state().isConfigured}
              fallback={
                <div class="settings-group">
                  <label class="settings-label">
                    <span class="label-text">Private Key</span>
                    <span class="label-hint">
                      Enter your wallet private key (64 hex characters)
                    </span>
                  </label>
                  <div class="crypto-key-input-group">
                    <input
                      type="password"
                      placeholder="0x... or 64 hex characters"
                      value={privateKeyInput()}
                      onInput={(e) => setPrivateKeyInput(e.currentTarget.value)}
                      class={
                        privateKeyInput() &&
                        !isValidPrivateKeyFormat(privateKeyInput())
                          ? "invalid"
                          : ""
                      }
                    />
                    <button
                      type="button"
                      class="primary"
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
                    <span class="settings-error">
                      Invalid key format. Must be 64 hex characters.
                    </span>
                  </Show>
                  <Show when={cryptoWalletStore.state().error}>
                    <span class="settings-error">
                      {cryptoWalletStore.state().error}
                    </span>
                  </Show>
                </div>
              }
            >
              <div class="crypto-wallet-configured">
                <div class="settings-group">
                  <label class="settings-label">
                    <span class="label-text">Wallet Address</span>
                    <span class="label-hint">
                      Your configured wallet for USDC payments
                    </span>
                  </label>
                  <div class="crypto-address-display">
                    <code class="wallet-address">
                      {cryptoWalletStore.state().address}
                    </code>
                    <button
                      type="button"
                      class="danger-outline"
                      onClick={() => setShowClearConfirm(true)}
                    >
                      Remove Wallet
                    </button>
                  </div>
                </div>

                <div class="settings-group">
                  <label class="settings-label">
                    <span class="label-text">USDC Balance (Base)</span>
                    <span class="label-hint">
                      Your current USDC balance on Base mainnet
                    </span>
                  </label>
                  <div class="crypto-balance-display">
                    <Show
                      when={!cryptoWalletStore.state().balanceLoading}
                      fallback={
                        <span class="balance-loading">Loading balance...</span>
                      }
                    >
                      <span class="balance-value">
                        {cryptoWalletStore.state().usdcBalance !== null
                          ? `${cryptoWalletStore.state().usdcBalance} USDC`
                          : "—"}
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="refresh-balance-btn"
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
            <h3>Appearance</h3>
            <p class="settings-description">
              Customize how Seren Desktop looks.
            </p>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Theme</span>
                <span class="label-hint">
                  Choose your preferred color scheme
                </span>
              </label>
              <div class="theme-selector">
                <For each={["dark", "light", "system"] as const}>
                  {(theme) => (
                    <button
                      type="button"
                      class={`theme-option ${settingsState.app.theme === theme ? "active" : ""}`}
                      onClick={() => handleThemeChange(theme)}
                    >
                      <span class="theme-icon">
                        {theme === "dark"
                          ? "🌙"
                          : theme === "light"
                            ? "☀️"
                            : "💻"}
                      </span>
                      <span class="theme-label">
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
            <h3>General Settings</h3>
            <p class="settings-description">
              Configure application behavior and privacy options.
            </p>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.telemetryEnabled}
                  onChange={(e) =>
                    handleBooleanChange(
                      "telemetryEnabled",
                      e.currentTarget.checked,
                    )
                  }
                />
                <span class="checkbox-label">
                  <span class="label-text">Enable Telemetry</span>
                  <span class="label-hint">
                    Help improve Seren by sharing anonymous usage data
                  </span>
                </span>
              </label>
            </div>
          </section>
        </Show>

        <Show when={activeSection() === "mcp"}>
          <section class="settings-section">
            <h3>MCP Servers</h3>
            <p class="settings-description">
              Manage Model Context Protocol server connections for enhanced AI
              capabilities.
            </p>

            <Show
              when={mcpSettings().servers.length > 0}
              fallback={
                <div class="settings-empty">
                  <span class="empty-icon">🔌</span>
                  <p>No MCP servers configured</p>
                  <p class="empty-hint">
                    MCP servers extend AI capabilities with tools like file
                    access, web browsing, and more.
                  </p>
                </div>
              }
            >
              <div class="mcp-server-list">
                <For each={mcpSettings().servers}>
                  {(server) => (
                    <div
                      class={`mcp-server-item ${server.enabled ? "" : "disabled"}`}
                    >
                      <div class="mcp-server-info">
                        <div class="mcp-server-header">
                          <span class="mcp-server-name">{server.name}</span>
                          <Show when={server.autoConnect}>
                            <span class="mcp-badge">Auto-connect</span>
                          </Show>
                        </div>
                        <span class="mcp-server-transport">
                          {isLocalServer(server)
                            ? `Command: ${server.command} ${server.args.join(" ")}`
                            : isBuiltinServer(server)
                              ? server.description || "Built-in server"
                              : "Unknown type"}
                        </span>
                      </div>
                      <div class="mcp-server-actions">
                        <button
                          type="button"
                          class={`mcp-toggle ${server.enabled ? "enabled" : ""}`}
                          onClick={() => handleToggleMcpServer(server.name)}
                          title={server.enabled ? "Disable" : "Enable"}
                        >
                          {server.enabled ? "On" : "Off"}
                        </button>
                        <button
                          type="button"
                          class="mcp-remove"
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
          class="settings-modal-overlay"
          onClick={() => setShowResetConfirm(false)}
        >
          <div class="settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset All Settings?</h3>
            <p>
              This will restore all settings to their default values. This
              cannot be undone.
            </p>
            <div class="settings-modal-actions">
              <button
                type="button"
                class="secondary"
                onClick={() => setShowResetConfirm(false)}
              >
                Cancel
              </button>
              <button type="button" class="danger" onClick={handleResetAll}>
                Reset All
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={showClearConfirm()}>
        <div
          class="settings-modal-overlay"
          onClick={() => setShowClearConfirm(false)}
        >
          <div class="settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Remove Crypto Wallet?</h3>
            <p>
              This will delete your private key from this device. You will need
              to re-enter it to make USDC payments.
            </p>
            <div class="settings-modal-actions">
              <button
                type="button"
                class="secondary"
                onClick={() => setShowClearConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="danger"
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
