// ABOUTME: Modal dialog for approving x402 USDC payments to MCP servers.
// ABOUTME: Shows payment method choices (SerenBucks or crypto) with balances.

import { type Component, createSignal, For, Show } from "solid-js";
import { hasX402Option, isInsufficientCredit } from "@/lib/x402";
import { x402Service } from "@/services/x402";
import { cryptoWalletStore } from "@/stores/crypto-wallet.store";
import { settingsState } from "@/stores/settings.store";
import { walletState } from "@/stores/wallet.store";
import "./X402PaymentApproval.css";

type PaymentMethodChoice = "serenbucks" | "crypto";

export const X402PaymentApproval: Component = () => {
  const payment = () => x402Service.pendingPayment();
  const isProcessing = () => x402Service.isProcessing();

  // Selected payment method - defaults to user preference
  const [selectedMethod, setSelectedMethod] = createSignal<PaymentMethodChoice>(
    settingsState.app.preferredPaymentMethod,
  );

  // Check which payment methods are available
  const hasPrepaidOption = () => {
    const p = payment();
    if (!p) return false;
    return p.requirements.accepts.some((a) => a.type === "prepaid");
  };

  const hasCryptoOption = () => {
    const p = payment();
    if (!p) return false;
    return hasX402Option(p.requirements);
  };

  const isCryptoWalletConfigured = () => cryptoWalletStore.state().isConfigured;

  // Check if SerenBucks has insufficient balance
  const isSerenBucksInsufficient = () => {
    const p = payment();
    if (!p) return false;
    return isInsufficientCredit(p.requirements);
  };

  // Get SerenBucks balance
  const serenBucksBalance = () => walletState.balance;

  // Format balance for display
  const formatBalance = (balance: number | null): string => {
    if (balance === null) return "...";
    return `$${balance.toFixed(2)}`;
  };

  const handleApprove = () => {
    // Pass the selected method to the service
    x402Service.approveWithMethod(selectedMethod());
  };

  const handleDecline = () => {
    x402Service.declinePendingPayment();
  };

  const formatAddress = (address: string): string => {
    if (address.length <= 16) return address;
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
  };

  // Determine which methods to show
  const availableMethods = (): Array<{
    id: PaymentMethodChoice;
    label: string;
    icon: string;
    balance: string;
    available: boolean;
    reason?: string;
  }> => {
    const methods: Array<{
      id: PaymentMethodChoice;
      label: string;
      icon: string;
      balance: string;
      available: boolean;
      reason?: string;
    }> = [];

    // Always show SerenBucks if prepaid option is available
    if (hasPrepaidOption()) {
      const balance = serenBucksBalance();
      const insufficient = isSerenBucksInsufficient();
      methods.push({
        id: "serenbucks",
        label: "SerenBucks",
        icon: "💰",
        balance: formatBalance(balance),
        available: !insufficient && balance !== null && balance > 0,
        reason: insufficient ? "Insufficient balance" : undefined,
      });
    }

    // Show crypto if x402 option is available
    if (hasCryptoOption()) {
      const configured = isCryptoWalletConfigured();
      methods.push({
        id: "crypto",
        label: "Crypto Wallet",
        icon: "🔐",
        balance: configured
          ? `${cryptoWalletStore.state().address?.slice(0, 10)}...`
          : "Not configured",
        available: configured,
        reason: configured ? undefined : "Wallet not configured",
      });
    }

    return methods;
  };

  // Auto-select best available method
  const autoSelectMethod = () => {
    const methods = availableMethods();
    const preferred = settingsState.app.preferredPaymentMethod;

    // Try preferred method first
    const preferredMethod = methods.find(
      (m) => m.id === preferred && m.available,
    );
    if (preferredMethod) {
      setSelectedMethod(preferred);
      return;
    }

    // Fallback if enabled
    if (settingsState.app.enablePaymentFallback) {
      const fallback = methods.find((m) => m.available);
      if (fallback) {
        setSelectedMethod(fallback.id);
        return;
      }
    }

    // Default to first available or preferred
    const firstAvailable = methods.find((m) => m.available);
    if (firstAvailable) {
      setSelectedMethod(firstAvailable.id);
    }
  };

  return (
    <Show when={payment()}>
      {(p) => {
        // Auto-select on mount
        autoSelectMethod();

        return (
          <div class="x402-modal-overlay">
            <div class="x402-modal">
              <div class="x402-modal-header">
                <span class="x402-icon">💳</span>
                <h3>Payment Required</h3>
              </div>

              <div class="x402-modal-body">
                <p class="x402-description">
                  The tool <strong>{p().toolName}</strong> on{" "}
                  <strong>{p().serverName}</strong> requires payment to proceed.
                </p>

                <div class="x402-details">
                  <div class="x402-detail-row">
                    <span class="x402-label">Amount</span>
                    <span class="x402-value x402-amount">
                      {p().amountFormatted}
                    </span>
                  </div>
                  <Show when={selectedMethod() === "crypto"}>
                    <div class="x402-detail-row">
                      <span class="x402-label">Network</span>
                      <span class="x402-value">{p().chainName}</span>
                    </div>
                    <div class="x402-detail-row">
                      <span class="x402-label">Recipient</span>
                      <span
                        class="x402-value x402-address"
                        title={p().recipient}
                      >
                        {formatAddress(p().recipient)}
                      </span>
                    </div>
                  </Show>
                </div>

                <Show when={availableMethods().length > 1}>
                  <div class="x402-method-selection">
                    <span class="x402-method-label">Pay with:</span>
                    <div class="x402-method-options">
                      <For each={availableMethods()}>
                        {(method) => (
                          <button
                            type="button"
                            class={`x402-method-option ${selectedMethod() === method.id ? "selected" : ""} ${!method.available ? "disabled" : ""}`}
                            onClick={() =>
                              method.available && setSelectedMethod(method.id)
                            }
                            disabled={!method.available}
                            title={method.reason}
                          >
                            <span class="x402-method-icon">{method.icon}</span>
                            <div class="x402-method-info">
                              <span class="x402-method-name">
                                {method.label}
                              </span>
                              <span class="x402-method-balance">
                                {method.balance}
                              </span>
                            </div>
                            <Show when={!method.available}>
                              <span class="x402-method-unavailable">
                                {method.reason}
                              </span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={selectedMethod() === "crypto"}>
                  <p class="x402-warning">
                    This payment will be signed with your crypto wallet and
                    submitted to {p().chainName}.
                  </p>
                </Show>

                <Show when={selectedMethod() === "serenbucks"}>
                  <p class="x402-info">
                    This will be charged to your SerenBucks balance.
                  </p>
                </Show>
              </div>

              <div class="x402-modal-actions">
                <button
                  type="button"
                  class="x402-btn x402-btn-secondary"
                  onClick={handleDecline}
                  disabled={isProcessing()}
                >
                  Decline
                </button>
                <button
                  type="button"
                  class="x402-btn x402-btn-primary"
                  onClick={handleApprove}
                  disabled={
                    isProcessing() ||
                    !availableMethods().some(
                      (m) => m.id === selectedMethod() && m.available,
                    )
                  }
                >
                  {isProcessing()
                    ? "Processing..."
                    : `Pay with ${selectedMethod() === "serenbucks" ? "SerenBucks" : "Crypto"}`}
                </button>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default X402PaymentApproval;
