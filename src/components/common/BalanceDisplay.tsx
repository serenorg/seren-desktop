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

  const stateClasses = () => {
    switch (balanceState()) {
      case "critical":
        return "text-destructive";
      case "low":
        return "text-warning";
      case "unknown":
        return "text-muted-foreground";
      default:
        return "text-foreground";
    }
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
      <div class="flex items-center gap-1">
        <button
          type="button"
          class={`flex items-center gap-1.5 py-1 px-2 bg-transparent border-none rounded-md text-sm font-medium cursor-pointer transition-colors duration-100 hover:bg-surface-2 ${stateClasses()}`}
          onClick={handleClick}
          title={lastUpdatedText()}
          aria-label={`SerenBucks balance: ${walletStore.formattedBalance}. Click to add funds.`}
        >
          {/* Refresh is silent - last-known balance stays visible. */}
          <Show when={!walletState.isLoading && walletState.error}>
            <span class="text-destructive mr-1" title={walletState.error || ""}>
              &#9888;
            </span>
          </Show>
          <span class="text-base" aria-hidden="true">
            &#128176;
          </span>
          <span class="tabular-nums">{walletStore.formattedBalance}</span>
        </button>

        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 p-0 bg-transparent border-none rounded text-base text-secondary-foreground cursor-pointer transition-colors duration-100 hover:bg-surface-2 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
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
