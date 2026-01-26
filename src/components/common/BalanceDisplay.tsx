// ABOUTME: Balance display component for header showing SerenBucks.
// ABOUTME: Shows balance with color coding and click to open deposit modal.

import { type Component, createSignal, Show } from "solid-js";
import { DepositModal } from "@/components/wallet/DepositModal";
import { settingsStore } from "@/stores/settings.store";
import {
  refreshBalance,
  walletState,
  walletStore,
} from "@/stores/wallet.store";
import "./BalanceDisplay.css";

/**
 * Balance display component for the header.
 * Shows current balance with visual states based on amount.
 */
export const BalanceDisplay: Component = () => {
  const [showDepositModal, setShowDepositModal] = createSignal(false);

  const showBalance = () => settingsStore.get("showBalance");
  const lowThreshold = () => settingsStore.get("lowBalanceThreshold");

  // Determine balance state for styling
  const balanceState = () => {
    const balance = walletState.balance;
    if (balance === null) return "unknown";
    if (balance < 0.1) return "critical";
    if (balance < lowThreshold()) return "low";
    return "normal";
  };

  // Format last updated time for tooltip
  const lastUpdatedText = () => {
    const lastUpdated = walletState.lastUpdated;
    if (!lastUpdated) return "Never updated";
    const date = new Date(lastUpdated);
    return `Last updated: ${date.toLocaleTimeString()}`;
  };

  const handleClick = () => {
    setShowDepositModal(true);
  };

  const handleRefresh = (e: MouseEvent) => {
    e.stopPropagation();
    refreshBalance();
  };

  return (
    <Show when={showBalance()}>
      <div class="balance-display-wrapper">
        <button
          class={`balance-display balance-display--${balanceState()}`}
          onClick={handleClick}
          title={lastUpdatedText()}
          aria-label={`SerenBucks balance: ${walletStore.formattedBalance}. Click to add funds.`}
        >
          <Show when={walletState.isLoading}>
            <span class="balance-loading">
              <span class="balance-spinner" />
            </span>
          </Show>

          <Show when={!walletState.isLoading && walletState.error}>
            <span class="balance-error-icon" title={walletState.error || ""}>
              &#9888;
            </span>
          </Show>

          <Show when={!walletState.isLoading}>
            <span class="balance-icon" aria-hidden="true">
              &#128176;
            </span>
            <span class="balance-amount">{walletStore.formattedBalance}</span>
          </Show>
        </button>

        <button
          class="balance-refresh"
          onClick={handleRefresh}
          title="Refresh balance"
          aria-label="Refresh balance"
          disabled={walletState.isLoading}
        >
          &#8635;
        </button>

        <Show when={showDepositModal()}>
          <DepositModal onClose={() => setShowDepositModal(false)} />
        </Show>
      </div>
    </Show>
  );
};
