// ABOUTME: Wallet status component for status bar.
// ABOUTME: Displays current balance with low balance indicator.

import { Component, Show } from "solid-js";
import { walletState, walletStore } from "@/stores/wallet.store";
import { settingsStore } from "@/stores/settings.store";
import { LowBalanceIndicator } from "./LowBalanceWarning";
import "./WalletStatus.css";

/**
 * Wallet status display for the status bar.
 */
export const WalletStatus: Component = () => {
  const showBalance = () => settingsStore.get("showBalance");

  return (
    <Show when={showBalance()}>
      <div class="wallet-status" title="SerenBucks Balance">
        <Show when={walletState.isLoading}>
          <span class="wallet-loading">...</span>
        </Show>
        <Show when={!walletState.isLoading && walletState.error}>
          <span class="wallet-error" title={walletState.error || ""}>
            &#9888;
          </span>
        </Show>
        <Show when={!walletState.isLoading && !walletState.error}>
          <span class="wallet-balance">{walletStore.formattedBalance}</span>
          <LowBalanceIndicator />
        </Show>
      </div>
    </Show>
  );
};
