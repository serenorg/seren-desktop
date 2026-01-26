// ABOUTME: Settings panel UI for managing user preferences.
// ABOUTME: Provides controls for editor, wallet, theme, and MCP settings.

import { createSignal, For, Show, type Component } from "solid-js";
import {
  settingsStore,
  settingsState,
  mcpSettings,
  removeMcpServer,
  toggleMcpServer,
  type Settings,
} from "@/stores/settings.store";
import "./SettingsPanel.css";

type SettingsSection = "editor" | "wallet" | "appearance" | "mcp";

export const SettingsPanel: Component = () => {
  const [activeSection, setActiveSection] = createSignal<SettingsSection>("editor");
  const [showResetConfirm, setShowResetConfirm] = createSignal(false);

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

  const sections: { id: SettingsSection; label: string; icon: string }[] = [
    { id: "editor", label: "Editor", icon: "📝" },
    { id: "wallet", label: "Wallet", icon: "💳" },
    { id: "appearance", label: "Appearance", icon: "🎨" },
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
                onInput={(e) => handleNumberChange("editorFontSize", e.currentTarget.value)}
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
                onInput={(e) => handleNumberChange("editorTabSize", e.currentTarget.value)}
              />
            </div>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.editorWordWrap}
                  onChange={(e) => handleBooleanChange("editorWordWrap", e.currentTarget.checked)}
                />
                <span class="checkbox-label">
                  <span class="label-text">Word Wrap</span>
                  <span class="label-hint">Wrap long lines instead of scrolling</span>
                </span>
              </label>
            </div>

            <h4>Code Completion</h4>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.completionEnabled}
                  onChange={(e) => handleBooleanChange("completionEnabled", e.currentTarget.checked)}
                />
                <span class="checkbox-label">
                  <span class="label-text">Enable AI Completions</span>
                  <span class="label-hint">Show AI-powered code suggestions while typing</span>
                </span>
              </label>
            </div>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Completion Delay</span>
                <span class="label-hint">Milliseconds to wait before showing suggestions</span>
              </label>
              <input
                type="number"
                min="100"
                max="2000"
                step="100"
                value={settingsState.app.completionDelay}
                onInput={(e) => handleNumberChange("completionDelay", e.currentTarget.value)}
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
                  onChange={(e) => handleBooleanChange("showBalance", e.currentTarget.checked)}
                />
                <span class="checkbox-label">
                  <span class="label-text">Show Balance in Status Bar</span>
                  <span class="label-hint">Display your SerenBucks balance at the bottom of the app</span>
                </span>
              </label>
            </div>

            <div class="settings-group">
              <label class="settings-label">
                <span class="label-text">Low Balance Warning</span>
                <span class="label-hint">Show warning when balance falls below this amount ($)</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={settingsState.app.lowBalanceThreshold}
                onInput={(e) => handleNumberChange("lowBalanceThreshold", e.currentTarget.value)}
              />
            </div>

            <h4>Auto Top-Up</h4>

            <div class="settings-group checkbox">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settingsState.app.autoTopUpEnabled}
                  onChange={(e) => handleBooleanChange("autoTopUpEnabled", e.currentTarget.checked)}
                />
                <span class="checkbox-label">
                  <span class="label-text">Enable Auto Top-Up</span>
                  <span class="label-hint">Automatically add funds when balance is low</span>
                </span>
              </label>
            </div>

            <Show when={settingsState.app.autoTopUpEnabled}>
              <div class="settings-group">
                <label class="settings-label">
                  <span class="label-text">Top-Up Threshold</span>
                  <span class="label-hint">Trigger top-up when balance falls below ($)</span>
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={settingsState.app.autoTopUpThreshold}
                  onInput={(e) => handleNumberChange("autoTopUpThreshold", e.currentTarget.value)}
                />
              </div>

              <div class="settings-group">
                <label class="settings-label">
                  <span class="label-text">Top-Up Amount</span>
                  <span class="label-hint">Amount to add when auto top-up triggers ($)</span>
                </label>
                <input
                  type="number"
                  min="5"
                  step="5"
                  value={settingsState.app.autoTopUpAmount}
                  onInput={(e) => handleNumberChange("autoTopUpAmount", e.currentTarget.value)}
                />
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
                <span class="label-hint">Choose your preferred color scheme</span>
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
                        {theme === "dark" ? "🌙" : theme === "light" ? "☀️" : "💻"}
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

        <Show when={activeSection() === "mcp"}>
          <section class="settings-section">
            <h3>MCP Servers</h3>
            <p class="settings-description">
              Manage Model Context Protocol server connections for enhanced AI capabilities.
            </p>

            <Show
              when={mcpSettings().servers.length > 0}
              fallback={
                <div class="settings-empty">
                  <span class="empty-icon">🔌</span>
                  <p>No MCP servers configured</p>
                  <p class="empty-hint">
                    MCP servers extend AI capabilities with tools like file access,
                    web browsing, and more.
                  </p>
                </div>
              }
            >
              <div class="mcp-server-list">
                <For each={mcpSettings().servers}>
                  {(server) => (
                    <div class={`mcp-server-item ${server.enabled ? "" : "disabled"}`}>
                      <div class="mcp-server-info">
                        <div class="mcp-server-header">
                          <span class="mcp-server-name">{server.name}</span>
                          <Show when={server.autoConnect}>
                            <span class="mcp-badge">Auto-connect</span>
                          </Show>
                        </div>
                        <span class="mcp-server-transport">
                          {server.transport.type === "stdio"
                            ? `Command: ${server.transport.command}`
                            : `URL: ${server.transport.url}`}
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
        <div class="settings-modal-overlay" onClick={() => setShowResetConfirm(false)}>
          <div class="settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset All Settings?</h3>
            <p>This will restore all settings to their default values. This cannot be undone.</p>
            <div class="settings-modal-actions">
              <button type="button" class="secondary" onClick={() => setShowResetConfirm(false)}>
                Cancel
              </button>
              <button type="button" class="danger" onClick={handleResetAll}>
                Reset All
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default SettingsPanel;
