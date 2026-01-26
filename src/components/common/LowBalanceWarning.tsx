// ABOUTME: Low balance warning component that appears when SerenBucks is low.
// ABOUTME: Shows in status bar and as a modal when balance first drops.

import { type Component, createEffect, createSignal, Show } from "solid-js";
import { initiateTopUp, openCheckout } from "@/services/wallet";
import { settingsStore } from "@/stores/settings.store";
import {
  dismissLowBalanceWarning,
  shouldShowLowBalanceWarning,
  walletState,
} from "@/stores/wallet.store";

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

  const containerClasses = () => {
    const base = "flex flex-col";
    return variant() === "inline"
      ? `${base} gap-3 py-3 px-4 bg-warning/10 border border-warning/30 rounded-lg`
      : `${base} gap-4`;
  };

  return (
    <Show when={shouldShow()}>
      <div class={containerClasses()} role="alert" aria-live="polite">
        <div class="flex items-start gap-3">
          <span class="text-xl text-warning shrink-0" aria-hidden="true">
            &#9888;
          </span>
          <div class="flex flex-col gap-1 min-w-0">
            <span class="text-sm font-semibold text-foreground">
              Low Balance
            </span>
            <span class="text-[13px] text-muted-foreground">
              Your SerenBucks balance (${walletState.balance?.toFixed(2)}) is
              below ${threshold().toFixed(2)}.
            </span>
          </div>
        </div>

        <Show when={topUpError()}>
          <div class="text-xs text-destructive p-2 bg-destructive/10 rounded">
            {topUpError()}
          </div>
        </Show>

        <div class="flex justify-end gap-2">
          <button
            class="py-1.5 px-3 text-[13px] font-medium rounded-md cursor-pointer transition-all duration-150 bg-transparent text-muted-foreground border border-border hover:bg-secondary hover:text-foreground disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={handleDismiss}
            disabled={isTopUpLoading()}
          >
            Dismiss
          </button>
          <button
            class="py-1.5 px-3 text-[13px] font-medium rounded-md cursor-pointer transition-all duration-150 bg-primary text-primary-foreground border-none hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
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
      <div
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] animate-[fadeIn_0.2s_ease-out]"
        onClick={handleClose}
      >
        <div
          class="bg-card border border-border rounded-xl p-6 max-w-[400px] w-[90%] shadow-xl animate-[slideUp_0.2s_ease-out]"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="low-balance-modal-title"
        >
          <h2
            id="low-balance-modal-title"
            class="text-lg font-semibold text-foreground m-0 mb-4"
          >
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
      <span
        class="inline-flex items-center justify-center w-5 h-5 text-sm text-warning cursor-pointer rounded transition-colors duration-150 hover:bg-secondary"
        title="Low balance - click to top up"
      >
        &#9888;
      </span>
    </Show>
  );
};
