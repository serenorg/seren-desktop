// ABOUTME: Modal popup for claiming daily SerenBucks credits after login.
// ABOUTME: Shows eligibility, handles claim action, and supports dismissal.

import { type Component, createSignal, Show } from "solid-js";
import type { DailyClaimResponse } from "@/services/dailyClaim";
import {
  claimDaily,
  dismissDailyClaim,
  walletState,
} from "@/stores/wallet.store";
import "./DailyClaimPopup.css";

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
      <div class="daily-claim-overlay" onClick={handleBackdropClick}>
        <div
          class="daily-claim-dialog"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="daily-claim-title"
        >
          <Show
            when={!showSuccess()}
            fallback={
              <div class="daily-claim-success">
                <span class="daily-claim-success-icon">&#10003;</span>
                <span class="daily-claim-success-amount">
                  +{claimResult()?.amount_usd}
                </span>
                <span class="daily-claim-success-balance">
                  New balance: {claimResult()?.balance_usd}
                </span>
                <span class="daily-claim-remaining">
                  {claimResult()?.claims_remaining_this_month} claims remaining
                  this month
                </span>
                <button
                  class="daily-claim-btn daily-claim-btn-claim"
                  onClick={handleCloseSuccess}
                >
                  Done
                </button>
              </div>
            }
          >
            <div class="daily-claim-header">
              <span class="daily-claim-icon">&#128176;</span>
              <h2 id="daily-claim-title" class="daily-claim-title">
                Daily SerenBucks
              </h2>
            </div>

            <div class="daily-claim-body">
              <p class="daily-claim-message">
                {walletState.dailyClaim?.claim_amount_usd
                  ? `You have ${walletState.dailyClaim.claim_amount_usd} unclaimed SerenBucks today! Claim your ${walletState.dailyClaim.claim_amount_usd} of SerenBucks to use with AI models and publisher tools.`
                  : "You have unclaimed SerenBucks today! Claim your free daily credits to use with AI models and publisher tools."}
              </p>
              <Show when={walletState.dailyClaim}>
                <p class="daily-claim-remaining">
                  {walletState.dailyClaim?.claims_remaining_this_month} claims
                  remaining this month
                </p>
              </Show>
            </div>

            <Show when={error()}>
              <div class="daily-claim-error">{error()}</div>
            </Show>

            <div class="daily-claim-footer">
              <button
                class="daily-claim-btn daily-claim-btn-dismiss"
                onClick={handleDismiss}
                disabled={claiming()}
              >
                Dismiss
              </button>
              <button
                class="daily-claim-btn daily-claim-btn-claim"
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
