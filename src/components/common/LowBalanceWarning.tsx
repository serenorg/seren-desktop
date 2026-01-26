// ABOUTME: Low balance warning component that appears when SerenBucks is low.
// ABOUTME: Shows in status bar and as a modal when balance first drops.

import { Component, Show, createSignal, createEffect } from "solid-js";
import {
  walletState,
  dismissLowBalanceWarning,
  shouldShowLowBalanceWarning,
} from "@/stores/wallet.store";
import { settingsStore } from "@/stores/settings.store";
import { initiateTopUp, openCheckout } from "@/services/wallet";
import "./LowBalanceWarning.css";

interface LowBalanceWarningProps {
  variant?: "inline" | "modal";
  onTopUp?: () => void;
}

/**
 * Low balance warning component.
 * Shows when balance falls below the configured threshold.
 */
export const LowBalanceWarning: Component<LowBalanceWarningProps> = (props) => {
  const variant = () => props.variant ?? "inline";
  const [isTopUpLoading, setIsTopUpLoading] = createSignal(false);
  const [topUpError, setTopUpError] = createSignal<string | null>(null);

  const threshold = () => settingsStore.get("lowBalanceThreshold");

  const shouldShow = () => shouldShowLowBalanceWarning(threshold());

  const handleDismiss = () => {
    dismissLowBalanceWarning();
  };

  const handleTopUp = async () => {
    setIsTopUpLoading(true);
    setTopUpError(null);

    try {
      const topUpAmount = settingsStore.get("autoTopUpAmount");
      const checkout = await initiateTopUp(topUpAmount);
      await openCheckout(checkout.checkout_url);
      props.onTopUp?.();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to initiate top-up";
      setTopUpError(message);
    } finally {
      setIsTopUpLoading(false);
    }
  };

  return (
    <Show when={shouldShow()}>
      <div
        class={`low-balance-warning low-balance-warning--${variant()}`}
        role="alert"
        aria-live="polite"
      >
        <div class="low-balance-content">
          <span class="low-balance-icon" aria-hidden="true">
            &#9888;
          </span>
          <div class="low-balance-text">
            <span class="low-balance-title">Low Balance</span>
            <span class="low-balance-message">
              Your SerenBucks balance (${walletState.balance?.toFixed(2)}) is
              below ${threshold().toFixed(2)}.
            </span>
          </div>
        </div>

        <Show when={topUpError()}>
          <div class="low-balance-error">{topUpError()}</div>
        </Show>

        <div class="low-balance-actions">
          <button
            class="btn-secondary"
            onClick={handleDismiss}
            disabled={isTopUpLoading()}
          >
            Dismiss
          </button>
          <button
            class="btn-primary"
            onClick={handleTopUp}
            disabled={isTopUpLoading()}
          >
            {isTopUpLoading() ? "Loading..." : "Top Up"}
          </button>
        </div>
      </div>
    </Show>
  );
};

/**
 * Low balance modal that shows when balance first drops below threshold.
 */
export const LowBalanceModal: Component = () => {
  const [isVisible, setIsVisible] = createSignal(false);
  const [lastNotifiedBalance, setLastNotifiedBalance] = createSignal<
    number | null
  >(null);

  const threshold = () => settingsStore.get("lowBalanceThreshold");

  // Show modal when balance drops below threshold for the first time
  createEffect(() => {
    const balance = walletState.balance;
    const thresh = threshold();
    const lastNotified = lastNotifiedBalance();

    if (balance === null) return;

    // Show if balance dropped below threshold and we haven't shown for this level
    if (balance < thresh) {
      if (lastNotified === null || balance < lastNotified) {
        setIsVisible(true);
        setLastNotifiedBalance(balance);
      }
    } else {
      // Reset when balance goes above threshold
      setLastNotifiedBalance(null);
    }
  });

  const handleClose = () => {
    setIsVisible(false);
    dismissLowBalanceWarning();
  };

  return (
    <Show when={isVisible()}>
      <div class="low-balance-modal-backdrop" onClick={handleClose}>
        <div
          class="low-balance-modal"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="low-balance-modal-title"
        >
          <h2 id="low-balance-modal-title" class="low-balance-modal-title">
            Low Balance Warning
          </h2>
          <LowBalanceWarning variant="modal" onTopUp={handleClose} />
        </div>
      </div>
    </Show>
  );
};

/**
 * Status bar indicator for low balance.
 */
export const LowBalanceIndicator: Component = () => {
  const threshold = () => settingsStore.get("lowBalanceThreshold");
  const showBalance = () => settingsStore.get("showBalance");

  const isLow = () => {
    const balance = walletState.balance;
    return balance !== null && balance < threshold();
  };

  return (
    <Show when={showBalance() && isLow()}>
      <span class="low-balance-indicator" title="Low balance - click to top up">
        &#9888;
      </span>
    </Show>
  );
};
