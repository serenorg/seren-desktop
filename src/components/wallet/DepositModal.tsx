// ABOUTME: Deposit modal for adding SerenBucks via Stripe checkout.
// ABOUTME: Shows preset amounts and custom input with current balance.

import { Component, createSignal, For, Show } from "solid-js";
import { walletState, walletStore, refreshBalance } from "@/stores/wallet.store";
import { initiateTopUp, openCheckout } from "@/services/wallet";
import "./DepositModal.css";

interface DepositModalProps {
  onClose: () => void;
}

const PRESET_AMOUNTS = [5, 10, 25, 50];

/**
 * Deposit modal for adding funds to wallet.
 */
export const DepositModal: Component<DepositModalProps> = (props) => {
  const [selectedAmount, setSelectedAmount] = createSignal<number | null>(25);
  const [customAmount, setCustomAmount] = createSignal("");
  const [isCustom, setIsCustom] = createSignal(false);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const effectiveAmount = () => {
    if (isCustom()) {
      const parsed = parseFloat(customAmount());
      return isNaN(parsed) ? 0 : parsed;
    }
    return selectedAmount() ?? 0;
  };

  const isValidAmount = () => {
    const amount = effectiveAmount();
    return amount >= 5 && amount <= 500;
  };

  const handlePresetClick = (amount: number) => {
    setSelectedAmount(amount);
    setIsCustom(false);
    setCustomAmount("");
  };

  const handleCustomClick = () => {
    setIsCustom(true);
    setSelectedAmount(null);
  };

  const handleCustomInput = (value: string) => {
    // Only allow valid number input
    const cleaned = value.replace(/[^0-9.]/g, "");
    // Prevent multiple decimals
    const parts = cleaned.split(".");
    if (parts.length > 2) return;
    if (parts[1]?.length > 2) return;
    setCustomAmount(cleaned);
  };

  const handleDeposit = async () => {
    const amount = effectiveAmount();
    if (!isValidAmount()) {
      setError("Amount must be between $5 and $500");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const checkout = await initiateTopUp(amount);
      await openCheckout(checkout.checkoutUrl);

      // Start polling for balance update
      const pollInterval = setInterval(() => {
        refreshBalance();
      }, 5000);

      // Stop polling after 2 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
      }, 120000);

      props.onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to initiate deposit";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  return (
    <div class="deposit-modal-backdrop" onClick={handleBackdropClick}>
      <div
        class="deposit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-modal-title"
      >
        <header class="deposit-modal-header">
          <h2 id="deposit-modal-title">Add SerenBucks</h2>
          <button
            class="deposit-modal-close"
            onClick={props.onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </header>

        <div class="deposit-modal-body">
          <div class="deposit-current-balance">
            <span class="deposit-balance-label">Current Balance</span>
            <span class="deposit-balance-value">{walletStore.formattedBalance}</span>
          </div>

          <div class="deposit-amounts">
            <label class="deposit-amounts-label">Select Amount</label>
            <div class="deposit-preset-amounts">
              <For each={PRESET_AMOUNTS}>
                {(amount) => (
                  <button
                    class={`deposit-amount-btn ${!isCustom() && selectedAmount() === amount ? "selected" : ""}`}
                    onClick={() => handlePresetClick(amount)}
                  >
                    ${amount}
                  </button>
                )}
              </For>
              <button
                class={`deposit-amount-btn ${isCustom() ? "selected" : ""}`}
                onClick={handleCustomClick}
              >
                Custom
              </button>
            </div>

            <Show when={isCustom()}>
              <div class="deposit-custom-input">
                <span class="deposit-currency">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Enter amount"
                  value={customAmount()}
                  onInput={(e) => handleCustomInput(e.currentTarget.value)}
                  aria-label="Custom amount in dollars"
                  autofocus
                />
              </div>
              <p class="deposit-custom-hint">Minimum $5, maximum $500</p>
            </Show>
          </div>

          <Show when={effectiveAmount() > 0}>
            <div class="deposit-summary">
              <span>New balance after deposit:</span>
              <span class="deposit-new-balance">
                ${((walletState.balance ?? 0) + effectiveAmount()).toFixed(2)}
              </span>
            </div>
          </Show>

          <Show when={error()}>
            <div class="deposit-error" role="alert">
              {error()}
            </div>
          </Show>
        </div>

        <footer class="deposit-modal-footer">
          <button class="btn-secondary" onClick={props.onClose} disabled={isLoading()}>
            Cancel
          </button>
          <button
            class="btn-primary"
            onClick={handleDeposit}
            disabled={isLoading() || !isValidAmount()}
          >
            {isLoading() ? "Processing..." : `Add $${effectiveAmount().toFixed(2)}`}
          </button>
        </footer>
      </div>
    </div>
  );
};
