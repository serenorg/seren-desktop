// ABOUTME: Settings panel component for user preferences.
// ABOUTME: Provides UI for editor, completion, wallet, and auto top-up settings.

import { type Component, For, Show } from "solid-js";
import { logout } from "@/services/auth";
import { settingsStore } from "@/stores/settings.store";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  onLogout?: () => void;
}

const TOP_UP_AMOUNTS = [
  { value: 10, label: "$10" },
  { value: 25, label: "$25" },
  { value: 50, label: "$50" },
  { value: 100, label: "$100" },
];

export const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const handleLogout = async () => {
    try {
      await logout();
      if (props.onLogout) {
        props.onLogout();
      }
    } catch {
      // Error handling
    }
  };

  const handleResetAll = () => {
    if (confirm("Reset all settings to defaults?")) {
      settingsStore.reset();
    }
  };

  return (
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="reset-all-btn" onClick={handleResetAll}>
          Reset All
        </button>
      </div>

      {/* Editor Settings */}
      <section class="settings-section">
        <h3>Editor</h3>

        <div class="setting-item">
          <label for="font-size">Font Size</label>
          <input
            id="font-size"
            type="number"
            min="8"
            max="32"
            value={settingsStore.get("editorFontSize")}
            onInput={(e) =>
              settingsStore.set(
                "editorFontSize",
                parseInt(e.currentTarget.value, 10) || 14,
              )
            }
          />
        </div>

        <div class="setting-item">
          <label for="tab-size">Tab Size</label>
          <select
            id="tab-size"
            value={settingsStore.get("editorTabSize")}
            onChange={(e) =>
              settingsStore.set(
                "editorTabSize",
                parseInt(e.currentTarget.value, 10),
              )
            }
          >
            <option value="2">2 spaces</option>
            <option value="4">4 spaces</option>
            <option value="8">8 spaces</option>
          </select>
        </div>

        <div class="setting-item checkbox">
          <label>
            <input
              type="checkbox"
              checked={settingsStore.get("editorWordWrap")}
              onChange={(e) =>
                settingsStore.set("editorWordWrap", e.currentTarget.checked)
              }
            />
            Word Wrap
          </label>
        </div>
      </section>

      {/* Completion Settings */}
      <section class="settings-section">
        <h3>AI Completions</h3>

        <div class="setting-item checkbox">
          <label>
            <input
              type="checkbox"
              checked={settingsStore.get("completionEnabled")}
              onChange={(e) =>
                settingsStore.set("completionEnabled", e.currentTarget.checked)
              }
            />
            Enable Inline Completions
          </label>
        </div>

        <Show when={settingsStore.get("completionEnabled")}>
          <div class="setting-item">
            <label for="completion-delay">Delay (ms)</label>
            <input
              id="completion-delay"
              type="number"
              min="100"
              max="2000"
              step="100"
              value={settingsStore.get("completionDelay")}
              onInput={(e) =>
                settingsStore.set(
                  "completionDelay",
                  parseInt(e.currentTarget.value, 10) || 300,
                )
              }
            />
          </div>
        </Show>
      </section>

      {/* Wallet Settings */}
      <section class="settings-section">
        <h3>Wallet</h3>

        <div class="setting-item checkbox">
          <label>
            <input
              type="checkbox"
              checked={settingsStore.get("showBalance")}
              onChange={(e) =>
                settingsStore.set("showBalance", e.currentTarget.checked)
              }
            />
            Show Balance in Status Bar
          </label>
        </div>

        <div class="setting-item">
          <label for="low-balance">Low Balance Warning ($)</label>
          <input
            id="low-balance"
            type="number"
            min="0"
            step="0.5"
            value={settingsStore.get("lowBalanceThreshold")}
            onInput={(e) =>
              settingsStore.set(
                "lowBalanceThreshold",
                parseFloat(e.currentTarget.value) || 1,
              )
            }
          />
        </div>
      </section>

      {/* Auto Top-Up Settings */}
      <section class="settings-section">
        <h3>Auto Top-Up</h3>

        <div class="setting-item checkbox">
          <label>
            <input
              type="checkbox"
              checked={settingsStore.get("autoTopUpEnabled")}
              onChange={(e) =>
                settingsStore.set("autoTopUpEnabled", e.currentTarget.checked)
              }
            />
            Enable Automatic Top-Up
          </label>
        </div>

        <Show when={settingsStore.get("autoTopUpEnabled")}>
          <div class="setting-item">
            <label for="auto-threshold">When balance falls below ($)</label>
            <input
              id="auto-threshold"
              type="number"
              min="1"
              step="1"
              value={settingsStore.get("autoTopUpThreshold")}
              onInput={(e) =>
                settingsStore.set(
                  "autoTopUpThreshold",
                  parseFloat(e.currentTarget.value) || 5,
                )
              }
            />
          </div>

          <div class="setting-item">
            <label for="auto-amount">Top-up Amount</label>
            <select
              id="auto-amount"
              value={settingsStore.get("autoTopUpAmount")}
              onChange={(e) =>
                settingsStore.set(
                  "autoTopUpAmount",
                  parseFloat(e.currentTarget.value),
                )
              }
            >
              <For each={TOP_UP_AMOUNTS}>
                {(amount) => (
                  <option value={amount.value}>{amount.label}</option>
                )}
              </For>
            </select>
          </div>

          <p class="setting-hint">
            When your balance drops below the threshold, you'll be redirected to
            Stripe to complete the top-up.
          </p>
        </Show>
      </section>

      {/* Theme Settings */}
      <section class="settings-section">
        <h3>Appearance</h3>

        <div class="setting-item">
          <label for="theme">Theme</label>
          <select
            id="theme"
            value={settingsStore.get("theme")}
            onChange={(e) =>
              settingsStore.set(
                "theme",
                e.currentTarget.value as "dark" | "light" | "system",
              )
            }
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </div>
      </section>

      {/* Account Section */}
      <section class="settings-section">
        <h3>Account</h3>

        <button class="logout-btn" onClick={handleLogout}>
          Sign Out
        </button>
      </section>
    </div>
  );
};
