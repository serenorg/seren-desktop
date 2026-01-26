// ABOUTME: Settings panel component for user preferences.
// ABOUTME: Provides UI for editor, completion, wallet, and auto top-up settings.

import { type Component, For, Show } from "solid-js";
import { logout } from "@/services/auth";
import { settingsStore } from "@/stores/settings.store";

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
    <div class="flex flex-col h-full p-3 bg-card text-foreground overflow-y-auto">
      <div class="flex justify-between items-center mb-4 pb-2 border-b border-border">
        <h2 class="m-0 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Settings
        </h2>
        <button
          class="px-2 py-1 bg-transparent text-muted-foreground border border-border rounded text-[11px] cursor-pointer transition-all hover:bg-destructive/20 hover:text-destructive hover:border-destructive"
          onClick={handleResetAll}
        >
          Reset All
        </button>
      </div>

      {/* Editor Settings */}
      <section class="mb-5 pb-4 border-b border-border last:border-b-0">
        <h3 class="m-0 mb-3 text-[13px] font-semibold text-foreground">
          Editor
        </h3>

        <div class="flex justify-between items-center mb-3 last:mb-0">
          <label for="font-size" class="text-[13px] text-foreground">
            Font Size
          </label>
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
            class="w-[100px] px-2 py-1.5 bg-muted border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring"
          />
        </div>

        <div class="flex justify-between items-center mb-3 last:mb-0">
          <label for="tab-size" class="text-[13px] text-foreground">
            Tab Size
          </label>
          <select
            id="tab-size"
            value={settingsStore.get("editorTabSize")}
            onChange={(e) =>
              settingsStore.set(
                "editorTabSize",
                parseInt(e.currentTarget.value, 10),
              )
            }
            class="w-[100px] px-2 py-1.5 bg-muted border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring"
          >
            <option value="2">2 spaces</option>
            <option value="4">4 spaces</option>
            <option value="8">8 spaces</option>
          </select>
        </div>

        <div class="flex justify-start items-center mb-3 last:mb-0">
          <label class="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={settingsStore.get("editorWordWrap")}
              onChange={(e) =>
                settingsStore.set("editorWordWrap", e.currentTarget.checked)
              }
              class="w-4 h-4 m-0 cursor-pointer"
            />
            Word Wrap
          </label>
        </div>
      </section>

      {/* Completion Settings */}
      <section class="mb-5 pb-4 border-b border-border last:border-b-0">
        <h3 class="m-0 mb-3 text-[13px] font-semibold text-foreground">
          AI Completions
        </h3>

        <div class="flex justify-start items-center mb-3 last:mb-0">
          <label class="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={settingsStore.get("completionEnabled")}
              onChange={(e) =>
                settingsStore.set("completionEnabled", e.currentTarget.checked)
              }
              class="w-4 h-4 m-0 cursor-pointer"
            />
            Enable Inline Completions
          </label>
        </div>

        <Show when={settingsStore.get("completionEnabled")}>
          <div class="flex justify-between items-center mb-3 last:mb-0">
            <label for="completion-delay" class="text-[13px] text-foreground">
              Delay (ms)
            </label>
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
              class="w-[100px] px-2 py-1.5 bg-muted border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring"
            />
          </div>
        </Show>
      </section>

      {/* Wallet Settings */}
      <section class="mb-5 pb-4 border-b border-border last:border-b-0">
        <h3 class="m-0 mb-3 text-[13px] font-semibold text-foreground">
          Wallet
        </h3>

        <div class="flex justify-start items-center mb-3 last:mb-0">
          <label class="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={settingsStore.get("showBalance")}
              onChange={(e) =>
                settingsStore.set("showBalance", e.currentTarget.checked)
              }
              class="w-4 h-4 m-0 cursor-pointer"
            />
            Show Balance in Status Bar
          </label>
        </div>

        <div class="flex justify-between items-center mb-3 last:mb-0">
          <label for="low-balance" class="text-[13px] text-foreground">
            Low Balance Warning ($)
          </label>
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
            class="w-[100px] px-2 py-1.5 bg-muted border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring"
          />
        </div>
      </section>

      {/* Auto Top-Up Settings */}
      <section class="mb-5 pb-4 border-b border-border last:border-b-0">
        <h3 class="m-0 mb-3 text-[13px] font-semibold text-foreground">
          Auto Top-Up
        </h3>

        <div class="flex justify-start items-center mb-3 last:mb-0">
          <label class="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={settingsStore.get("autoTopUpEnabled")}
              onChange={(e) =>
                settingsStore.set("autoTopUpEnabled", e.currentTarget.checked)
              }
              class="w-4 h-4 m-0 cursor-pointer"
            />
            Enable Automatic Top-Up
          </label>
        </div>

        <Show when={settingsStore.get("autoTopUpEnabled")}>
          <div class="flex justify-between items-center mb-3 last:mb-0">
            <label for="auto-threshold" class="text-[13px] text-foreground">
              When balance falls below ($)
            </label>
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
              class="w-[100px] px-2 py-1.5 bg-muted border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring"
            />
          </div>

          <div class="flex justify-between items-center mb-3 last:mb-0">
            <label for="auto-amount" class="text-[13px] text-foreground">
              Top-up Amount
            </label>
            <select
              id="auto-amount"
              value={settingsStore.get("autoTopUpAmount")}
              onChange={(e) =>
                settingsStore.set(
                  "autoTopUpAmount",
                  parseFloat(e.currentTarget.value),
                )
              }
              class="w-[100px] px-2 py-1.5 bg-muted border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring"
            >
              <For each={TOP_UP_AMOUNTS}>
                {(amount) => (
                  <option value={amount.value}>{amount.label}</option>
                )}
              </For>
            </select>
          </div>

          <p class="mt-2 mb-0 p-2 bg-blue-500/10 rounded text-[11px] text-blue-400 leading-snug">
            When your balance drops below the threshold, you'll be redirected to
            Stripe to complete the top-up.
          </p>
        </Show>
      </section>

      {/* Theme Settings */}
      <section class="mb-5 pb-4 border-b border-border last:border-b-0">
        <h3 class="m-0 mb-3 text-[13px] font-semibold text-foreground">
          Appearance
        </h3>

        <div class="flex justify-between items-center mb-3 last:mb-0">
          <label for="theme" class="text-[13px] text-foreground">
            Theme
          </label>
          <select
            id="theme"
            value={settingsStore.get("theme")}
            onChange={(e) =>
              settingsStore.set(
                "theme",
                e.currentTarget.value as "dark" | "light" | "system",
              )
            }
            class="w-[100px] px-2 py-1.5 bg-muted border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </div>
      </section>

      {/* Account Section */}
      <section class="mb-5 pb-4 border-b border-border last:border-b-0">
        <h3 class="m-0 mb-3 text-[13px] font-semibold text-foreground">
          Account
        </h3>

        <button
          class="w-full py-2.5 bg-transparent text-destructive border border-destructive rounded text-[13px] cursor-pointer transition-all hover:bg-destructive/20"
          onClick={handleLogout}
        >
          Sign Out
        </button>
      </section>
    </div>
  );
};
