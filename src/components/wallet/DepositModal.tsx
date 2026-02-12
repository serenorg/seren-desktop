// ABOUTME: Deposit modal for adding SerenBucks via Stripe or crypto.
// ABOUTME: Shows preset amounts and supports multiple payment methods.

import { type Component, createSignal, For, Show } from "solid-js";
import {
  type CryptoDepositInfo,
  initiateCryptoDeposit,
  initiateTopUp,
  openCheckout,
} from "@/services/wallet";
import { cryptoWalletStore } from "@/stores/crypto-wallet.store";
import {
  refreshBalance,
  walletState,
  walletStore,
} from "@/stores/wallet.store";

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
  const [paymentMethod, setPaymentMethod] =
    createSignal<PaymentMethod>("stripe");
  const [cryptoDepositInfo, setCryptoDepositInfo] =
    createSignal<CryptoDepositInfo | null>(null);
  const [copied, setCopied] = createSignal(false);

  const effectiveAmount = () => {
    if (isCustom()) {
      const parsed = parseFloat(customAmount());
      return Number.isNaN(parsed) ? 0 : parsed;
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
        await openCheckout(checkout.checkout_url);

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
      const message =
        err instanceof Error ? err.message : "Failed to initiate deposit";
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
    <div
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] animate-[fadeIn_0.2s_ease-out]"
      onClick={handleBackdropClick}
    >
      <div
        class="bg-surface-2 border border-border-medium rounded-xl w-[90%] max-w-[420px] shadow-[var(--shadow-lg)] animate-[slideUp_0.2s_ease-out]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-modal-title"
      >
        <header class="flex items-center justify-between px-6 py-5 border-b border-border-medium">
          <h2
            id="deposit-modal-title"
            class="text-[18px] font-semibold text-white m-0"
          >
            Add SerenBucks
          </h2>
          <button
            class="flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none rounded-md text-[24px] text-muted-foreground cursor-pointer transition-all hover:bg-border hover:text-white"
            onClick={props.onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </header>

        <div class="p-6 flex flex-col gap-5">
          <div class="flex flex-col items-center gap-1 p-4 bg-background/50 rounded-lg">
            <span class="text-[12px] text-muted-foreground uppercase tracking-wider">
              Current Balance
            </span>
            <span class="text-[28px] font-bold text-white tabular-nums">
              {walletStore.formattedBalance}
            </span>
          </div>

          <Show when={!cryptoDepositInfo()}>
            <div class="flex flex-col gap-2">
              <label class="text-[14px] font-medium text-white">
                Payment Method
              </label>
              <div class="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  class={`flex flex-col items-center gap-1 px-3 py-4 rounded-[10px] cursor-pointer transition-all border-2 ${
                    paymentMethod() === "stripe"
                      ? "border-primary bg-primary/10"
                      : "bg-background/50 border-border-medium hover:bg-surface-1/50 hover:border-border-strong"
                  }`}
                  onClick={() => setPaymentMethod("stripe")}
                >
                  <span class="text-[24px]">💳</span>
                  <span class="text-[13px] font-medium text-white">
                    Card (Stripe)
                  </span>
                </button>
                <button
                  type="button"
                  class={`flex flex-col items-center gap-1 px-3 py-4 rounded-[10px] cursor-pointer transition-all border-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                    paymentMethod() === "crypto"
                      ? "border-primary bg-primary/10"
                      : "bg-background/50 border-border-medium hover:bg-surface-1/50 hover:border-border-strong"
                  }`}
                  onClick={() => setPaymentMethod("crypto")}
                  disabled={!cryptoWalletStore.state().isConfigured}
                  title={
                    !cryptoWalletStore.state().isConfigured
                      ? "Configure crypto wallet in Settings first"
                      : ""
                  }
                >
                  <span class="text-[24px]">🔐</span>
                  <span class="text-[13px] font-medium text-white">
                    USDC (Crypto)
                  </span>
                </button>
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <label class="text-[14px] font-medium text-white">
                Select Amount
              </label>
              <div class="grid grid-cols-5 gap-2">
                <For each={PRESET_AMOUNTS}>
                  {(amount) => (
                    <button
                      class={`py-3 px-2 rounded-lg text-[14px] font-medium cursor-pointer transition-all border ${
                        !isCustom() && selectedAmount() === amount
                          ? "bg-primary border-primary text-white"
                          : "bg-background/50 border-border-medium text-white hover:bg-surface-1/50 hover:border-border-strong"
                      }`}
                      onClick={() => handlePresetClick(amount)}
                    >
                      ${amount}
                    </button>
                  )}
                </For>
                <button
                  class={`py-3 px-2 rounded-lg text-[14px] font-medium cursor-pointer transition-all border ${
                    isCustom()
                      ? "bg-primary border-primary text-white"
                      : "bg-background/50 border-border-medium text-white hover:bg-surface-1/50 hover:border-border-strong"
                  }`}
                  onClick={handleCustomClick}
                >
                  Custom
                </button>
              </div>

              <Show when={isCustom()}>
                <div class="flex items-center gap-2 mt-2">
                  <span class="text-[18px] font-medium text-muted-foreground">
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Enter amount"
                    value={customAmount()}
                    onInput={(e) => handleCustomInput(e.currentTarget.value)}
                    aria-label="Custom amount in dollars"
                    autofocus
                    class="flex-1 px-4 py-3 bg-background/50 border border-border-medium rounded-lg text-[18px] text-white outline-none transition-colors focus:border-primary placeholder:text-muted-foreground"
                  />
                </div>
                <p class="text-[12px] text-muted-foreground mt-1 m-0">
                  Minimum $5, maximum $500
                </p>
              </Show>
            </div>

            <Show when={effectiveAmount() > 0}>
              <div class="flex justify-between items-center px-4 py-3 bg-background/50 rounded-lg text-[14px] text-muted-foreground">
                <span>New balance after deposit:</span>
                <span class="font-semibold text-success">
                  ${((walletState.balance ?? 0) + effectiveAmount()).toFixed(2)}
                </span>
              </div>
            </Show>
          </Show>

          <Show when={cryptoDepositInfo()}>
            {(info) => (
              <div class="flex flex-col gap-4">
                <div class="flex items-center gap-3 pb-3 border-b border-border-medium">
                  <span class="text-[28px]">🔐</span>
                  <h3 class="m-0 text-[16px] font-semibold text-white">
                    Send USDC to Complete Deposit
                  </h3>
                </div>

                <div class="flex flex-col gap-3">
                  <div class="flex flex-col gap-1">
                    <span class="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">
                      Amount
                    </span>
                    <span class="text-[15px] font-medium text-white">
                      {info().amount} USDC
                    </span>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">
                      Network
                    </span>
                    <span class="text-[15px] font-medium text-white">
                      {info().network}
                    </span>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">
                      Deposit Address
                    </span>
                    <div class="flex items-center gap-2">
                      <code class="flex-1 px-3 py-2.5 bg-background/50 border border-border-medium rounded-md text-[12px] font-mono text-white break-all">
                        {info().depositAddress}
                      </code>
                      <button
                        type="button"
                        class="px-3 py-2 bg-background/50 border border-border-medium rounded-md text-[16px] cursor-pointer transition-all hover:bg-surface-1/50 hover:border-border-strong"
                        onClick={handleCopyAddress}
                        title="Copy address"
                      >
                        {copied() ? "✓" : "📋"}
                      </button>
                    </div>
                  </div>
                </div>

                <div class="p-3 bg-warning/10 border border-warning/30 rounded-lg">
                  <p class="m-0 text-[13px] text-white">
                    Send exactly <strong>{info().amount} USDC</strong> to the
                    address above.
                  </p>
                  <p class="mt-2 text-[12px] text-muted-foreground m-0">
                    Only send USDC on <strong>{info().network}</strong>. Sending
                    other tokens or using the wrong network will result in
                    permanent loss.
                  </p>
                </div>

                <div class="flex items-center gap-2 p-3 bg-background/50 rounded-lg text-[13px] text-muted-foreground">
                  <span class="w-2 h-2 bg-primary rounded-full animate-pulse" />
                  <span>Waiting for payment...</span>
                </div>
              </div>
            )}
          </Show>

          <Show when={error()}>
            <div
              class="px-4 py-3 bg-destructive/10 border border-destructive rounded-lg text-[13px] text-destructive"
              role="alert"
            >
              {error()}
            </div>
          </Show>
        </div>

        <footer class="flex justify-end gap-3 px-6 py-4 border-t border-border-medium">
          <Show
            when={!cryptoDepositInfo()}
            fallback={
              <button
                type="button"
                class="px-5 py-2.5 text-[14px] font-medium rounded-lg cursor-pointer transition-all bg-primary text-white border-none hover:bg-primary/85"
                onClick={props.onClose}
              >
                Done
              </button>
            }
          >
            <button
              type="button"
              class="px-5 py-2.5 text-[14px] font-medium rounded-lg cursor-pointer transition-all bg-transparent text-muted-foreground border border-border-medium hover:bg-border hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={props.onClose}
              disabled={isLoading()}
            >
              Cancel
            </button>
            <button
              type="button"
              class="px-5 py-2.5 text-[14px] font-medium rounded-lg cursor-pointer transition-all bg-primary text-white border-none hover:bg-primary/85 disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={handleDeposit}
              disabled={isLoading() || !isValidAmount()}
            >
              {isLoading()
                ? "Processing..."
                : paymentMethod() === "crypto"
                  ? `Pay with USDC`
                  : `Add $${effectiveAmount().toFixed(2)}`}
            </button>
          </Show>
        </footer>
      </div>
    </div>
  );
};
