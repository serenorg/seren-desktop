// ABOUTME: Deposit modal for adding SerenBucks via Stripe or crypto.
// ABOUTME: Shows preset amounts and supports multiple payment methods.

import { Component, createSignal, For, Show } from "solid-js";
import { walletState, walletStore, refreshBalance } from "@/stores/wallet.store";
import { initiateTopUp, openCheckout, initiateCryptoDeposit, type CryptoDepositInfo } from "@/services/wallet";
import { cryptoWalletStore } from "@/stores/crypto-wallet.store";
import "./DepositModal.css";

interface DepositModalProps {
  onClose: () => void;
}

type PaymentMethod = "stripe" | "crypto";

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
  const [paymentMethod, setPaymentMethod] = createSignal<PaymentMethod>("stripe");
  const [cryptoDepositInfo, setCryptoDepositInfo] = createSignal<CryptoDepositInfo | null>(null);
  const [copied, setCopied] = createSignal(false);

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

  const handleCopyAddress = async () => {
    const info = cryptoDepositInfo();
    if (!info) return;

    try {
      await navigator.clipboard.writeText(info.depositAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Failed to copy address");
    }
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
      if (paymentMethod() === "stripe") {
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
      } else {
        // Crypto deposit - get deposit address
        const depositInfo = await initiateCryptoDeposit(amount);
        setCryptoDepositInfo(depositInfo);

        // Start polling for balance update while user sends payment
        const pollInterval = setInterval(() => {
          refreshBalance();
        }, 10000);

        // Stop polling after 30 minutes (crypto can take longer)
        setTimeout(() => {
          clearInterval(pollInterval);
        }, 1800000);
      }
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

          <Show when={!cryptoDepositInfo()}>
            <div class="deposit-method-selector">
              <label class="deposit-method-label">Payment Method</label>
              <div class="deposit-method-options">
                <button
                  type="button"
                  class={`deposit-method-btn ${paymentMethod() === "stripe" ? "selected" : ""}`}
                  onClick={() => setPaymentMethod("stripe")}
                >
                  <span class="method-icon">💳</span>
                  <span class="method-name">Card (Stripe)</span>
                </button>
                <button
                  type="button"
                  class={`deposit-method-btn ${paymentMethod() === "crypto" ? "selected" : ""}`}
                  onClick={() => setPaymentMethod("crypto")}
                  disabled={!cryptoWalletStore.state().isConfigured}
                  title={!cryptoWalletStore.state().isConfigured ? "Configure crypto wallet in Settings first" : ""}
                >
                  <span class="method-icon">🔐</span>
                  <span class="method-name">USDC (Crypto)</span>
                </button>
              </div>
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
          </Show>

          <Show when={cryptoDepositInfo()}>
            {(info) => (
              <div class="crypto-deposit-info">
                <div class="crypto-deposit-header">
                  <span class="crypto-icon">🔐</span>
                  <h3>Send USDC to Complete Deposit</h3>
                </div>

                <div class="crypto-deposit-details">
                  <div class="crypto-detail-row">
                    <span class="crypto-label">Amount</span>
                    <span class="crypto-value">{info().amount} USDC</span>
                  </div>
                  <div class="crypto-detail-row">
                    <span class="crypto-label">Network</span>
                    <span class="crypto-value">{info().network}</span>
                  </div>
                  <div class="crypto-detail-row">
                    <span class="crypto-label">Deposit Address</span>
                    <div class="crypto-address-row">
                      <code class="crypto-address">{info().depositAddress}</code>
                      <button
                        type="button"
                        class="copy-btn"
                        onClick={handleCopyAddress}
                        title="Copy address"
                      >
                        {copied() ? "✓" : "📋"}
                      </button>
                    </div>
                  </div>
                </div>

                <div class="crypto-deposit-warning">
                  <p>Send exactly <strong>{info().amount} USDC</strong> to the address above.</p>
                  <p class="crypto-warning-text">Only send USDC on <strong>{info().network}</strong>. Sending other tokens or using the wrong network will result in permanent loss.</p>
                </div>

                <div class="crypto-deposit-status">
                  <span class="status-dot" />
                  <span>Waiting for payment...</span>
                </div>
              </div>
            )}
          </Show>

          <Show when={error()}>
            <div class="deposit-error" role="alert">
              {error()}
            </div>
          </Show>
        </div>

        <footer class="deposit-modal-footer">
          <Show
            when={!cryptoDepositInfo()}
            fallback={
              <button type="button" class="btn-primary" onClick={props.onClose}>
                Done
              </button>
            }
          >
            <button type="button" class="btn-secondary" onClick={props.onClose} disabled={isLoading()}>
              Cancel
            </button>
            <button
              type="button"
              class="btn-primary"
              onClick={handleDeposit}
              disabled={isLoading() || !isValidAmount()}
            >
              {isLoading() ? "Processing..." : paymentMethod() === "crypto" ? `Pay with USDC` : `Add $${effectiveAmount().toFixed(2)}`}
            </button>
          </Show>
        </footer>
      </div>
    </div>
  );
};
