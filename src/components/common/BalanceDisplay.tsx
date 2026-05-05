// ABOUTME: Balance display component for header showing SerenBucks.
// ABOUTME: Quiet text figure - no chrome, no spinner, no manual refresh.

import { type Component, createSignal, Show } from "solid-js";
import { DepositModal } from "@/components/wallet/DepositModal";
import { settingsStore } from "@/stores/settings.store";
import { walletState, walletStore } from "@/stores/wallet.store";

export const BalanceDisplay: Component = () => {
  const [showDepositModal, setShowDepositModal] = createSignal(false);

  const showBalance = () => settingsStore.get("showBalance");
  const lowThreshold = () => settingsStore.get("lowBalanceThreshold");

  const balanceState = () => {
    const balance = walletState.balance;
    if (balance === null) return "unknown";
    if (balance < 0.1) return "critical";
    if (balance < lowThreshold()) return "low";
    return "normal";
  };

  // Frame stays; severity tints the border. No pulse - the figure
  // updates silently when a refresh lands.
  const stateClasses = () => {
    switch (balanceState()) {
      case "critical":
        return "text-destructive border-destructive";
      case "low":
        return "text-warning border-warning";
      case "unknown":
        return "text-muted-foreground";
      default:
        return "text-foreground";
    }
  };

  const lastUpdatedText = () => {
    const lastUpdated = walletState.lastUpdated;
    if (!lastUpdated) return "Never updated";
    const date = new Date(lastUpdated);
    return `Last updated: ${date.toLocaleTimeString()}`;
  };

  const handleClick = () => {
    setShowDepositModal(true);
  };

  return (
    <Show when={showBalance()}>
      <button
        type="button"
        class={`flex items-center gap-1.5 py-1.5 px-3 bg-muted border border-border rounded-md text-sm font-medium cursor-pointer transition-colors duration-150 hover:bg-secondary hover:border-secondary ${stateClasses()}`}
        onClick={handleClick}
        title={lastUpdatedText()}
        aria-label={`SerenBucks balance: ${walletStore.formattedBalance}. Click to add funds.`}
      >
        {/* Refresh is silent: the displayed value updates when the new
            figure arrives. The error glyph still shows because that's
            a meaningful state, not chrome. */}
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

      <Show when={showDepositModal()}>
        <DepositModal onClose={() => setShowDepositModal(false)} />
      </Show>
    </Show>
  );
};
