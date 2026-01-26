// ABOUTME: Wallet status component for status bar.
// ABOUTME: Displays current balance with low balance indicator.

import { type Component, Show } from "solid-js";
import { settingsStore } from "@/stores/settings.store";
import { walletState, walletStore } from "@/stores/wallet.store";
import { LowBalanceIndicator } from "./LowBalanceWarning";

/**
 * Wallet status display for the status bar.
 */
export const WalletStatus: Component = () => {
  const showBalance = () => settingsStore.get("showBalance");

  return (
    <Show when={showBalance()}>
      <div class="flex items-center gap-1 px-2 text-xs text-secondary-foreground" title="SerenBucks Balance">
        <Show when={walletState.isLoading}>
          <span class="text-muted-foreground">...</span>
        </Show>
        <Show when={!walletState.isLoading && walletState.error}>
          <span class="text-destructive cursor-help" title={walletState.error || ""}>
            &#9888;
          </span>
        </Show>
        <Show when={!walletState.isLoading && !walletState.error}>
          <span class="tabular-nums text-foreground">{walletStore.formattedBalance}</span>
          <LowBalanceIndicator />
        </Show>
      </div>
    </Show>
  );
};
