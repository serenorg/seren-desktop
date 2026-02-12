// ABOUTME: Modal popup for claiming daily SerenBucks credits after login.
// ABOUTME: Shows eligibility, handles claim action, and supports dismissal.

import { type Component, createSignal, Show } from "solid-js";
import type { DailyClaimResponse } from "@/services/dailyClaim";
import {
  claimDaily,
  dismissDailyClaim,
  walletState,
} from "@/stores/wallet.store";

/**
 * Daily SerenBucks claim popup modal.
 * Appears after login when user is eligible to claim.
 */
export const DailyClaimPopup: Component = () => {
  const [claiming, setClaiming] = createSignal(false);
  const [claimResult, setClaimResult] = createSignal<DailyClaimResponse | null>(
    null,
  );
  const [error, setError] = createSignal<string | null>(null);

  const shouldShow = () => {
    const claim = walletState.dailyClaim;
    return (
      claim?.can_claim && !walletState.dailyClaimDismissed && !claimResult()
    );
  };

  const showSuccess = () => claimResult() !== null;

  const handleClaim = async () => {
    setClaiming(true);
    setError(null);
    try {
      const result = await claimDaily();
      setClaimResult(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to claim daily credits",
      );
    } finally {
      setClaiming(false);
    }
  };

  const handleDismiss = () => {
    dismissDailyClaim();
  };

  const handleCloseSuccess = () => {
    setClaimResult(null);
  };

  const handleBackdropClick = () => {
    if (showSuccess()) {
      handleCloseSuccess();
    } else {
      handleDismiss();
    }
  };

  return (
    <Show when={shouldShow() || showSuccess()}>
      <div
        class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] animate-[fadeIn_200ms_ease-out]"
        onClick={handleBackdropClick}
      >
        <div
          class="bg-card border border-border rounded-xl p-6 max-w-[400px] w-[90%] shadow-[0_8px_32px_rgba(0,0,0,0.4)] animate-[slideUp_200ms_ease-out]"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="daily-claim-title"
        >
          <Show
            when={!showSuccess()}
            fallback={
              <div class="flex flex-col items-center gap-2 text-center py-3">
                <span class="text-[2rem] text-success">&#10003;</span>
                <span class="text-xl font-semibold text-foreground">
                  +{claimResult()?.amount_usd}
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  New balance: {claimResult()?.balance_usd}
                </span>
                <span class="text-[0.8rem] text-muted-foreground">
                  {claimResult()?.claims_remaining_this_month} claims remaining
                  this month
                </span>
                <button
                  class="px-3.5 py-1.5 text-[0.8125rem] font-medium rounded-md cursor-pointer transition-all duration-150 border-none disabled:opacity-60 disabled:cursor-not-allowed bg-primary text-primary-foreground hover:opacity-90"
                  onClick={handleCloseSuccess}
                >
                  Done
                </button>
              </div>
            }
          >
            <div class="flex items-center gap-2.5 mb-4">
              <span class="text-2xl">&#128176;</span>
              <h2
                id="daily-claim-title"
                class="text-lg font-semibold text-foreground m-0"
              >
                Daily SerenBucks
              </h2>
            </div>

            <div class="mb-5">
              <p class="text-sm text-muted-foreground leading-relaxed m-0 mb-2">
                {walletState.dailyClaim?.claim_amount_usd
                  ? `You have ${walletState.dailyClaim.claim_amount_usd} unclaimed SerenBucks today! Claim your ${walletState.dailyClaim.claim_amount_usd} of SerenBucks to use with AI models and publisher tools.`
                  : "You have unclaimed SerenBucks today! Claim your free daily credits to use with AI models and publisher tools."}
              </p>
              <Show when={walletState.dailyClaim}>
                <p class="text-[0.8rem] text-muted-foreground m-0">
                  {walletState.dailyClaim?.claims_remaining_this_month} claims
                  remaining this month
                </p>
              </Show>
            </div>

            <Show when={error()}>
              <div class="text-[0.8rem] text-destructive bg-[rgba(239,68,68,0.1)] p-2 rounded-md mb-3">
                {error()}
              </div>
            </Show>

            <div class="flex justify-end gap-2">
              <button
                class="px-3.5 py-1.5 text-[0.8125rem] font-medium rounded-md cursor-pointer transition-all duration-150 border-none disabled:opacity-60 disabled:cursor-not-allowed bg-transparent text-muted-foreground border border-border hover:bg-secondary hover:text-foreground"
                onClick={handleDismiss}
                disabled={claiming()}
              >
                Dismiss
              </button>
              <button
                class="px-3.5 py-1.5 text-[0.8125rem] font-medium rounded-md cursor-pointer transition-all duration-150 border-none disabled:opacity-60 disabled:cursor-not-allowed bg-primary text-primary-foreground hover:opacity-90"
                onClick={handleClaim}
                disabled={claiming()}
              >
                {claiming() ? "Claiming..." : "Claim Now"}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};
