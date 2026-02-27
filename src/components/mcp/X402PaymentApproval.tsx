// ABOUTME: Modal dialog for approving x402 USDC payments to MCP servers.
// ABOUTME: Shows payment method choices (SerenBucks or crypto) with balances.

import { type Component, createSignal, For, Show } from "solid-js";
import { hasX402Option, isInsufficientCredit } from "@/lib/x402";
import { x402Service } from "@/services/x402";
import { cryptoWalletStore } from "@/stores/crypto-wallet.store";
import { settingsState } from "@/stores/settings.store";
import { walletState } from "@/stores/wallet.store";

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
          : "Not connected",
        available: configured,
        reason: configured ? undefined : "Wallet not connected",
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
          <div class="fixed inset-0 bg-black/70 flex items-center justify-center z-[2000] backdrop-blur-[4px]">
            <div class="bg-popover border border-border-strong rounded-2xl p-6 max-w-[420px] w-[90%] shadow-[0_16px_48px_rgba(0,0,0,0.4)]">
              <div class="flex items-center gap-3 mb-4">
                <span class="text-2xl">💳</span>
                <h3 class="m-0 text-[1.2rem] font-semibold text-foreground">
                  Payment Required
                </h3>
              </div>

              <div class="mb-5">
                <p class="m-0 mb-4 text-muted-foreground leading-normal text-[0.95rem]">
                  The tool{" "}
                  <strong class="text-foreground">{p().toolName}</strong> on{" "}
                  <strong class="text-foreground">{p().serverName}</strong>{" "}
                  requires payment to proceed.
                </p>

                <div class="bg-black/20 border border-border-medium rounded-xl p-4 mb-4">
                  <div class="flex justify-between items-center py-2 border-b border-border">
                    <span class="text-[0.9rem] text-muted-foreground">
                      Amount
                    </span>
                    <span class="text-[1.1rem] text-success font-semibold">
                      {p().amountFormatted}
                    </span>
                  </div>
                  <Show when={selectedMethod() === "crypto"}>
                    <div class="flex justify-between items-center py-2 border-b border-border">
                      <span class="text-[0.9rem] text-muted-foreground">
                        Network
                      </span>
                      <span class="text-[0.9rem] text-foreground font-medium">
                        {p().chainName}
                      </span>
                    </div>
                    <div class="flex justify-between items-center py-2">
                      <span class="text-[0.9rem] text-muted-foreground">
                        Recipient
                      </span>
                      <span
                        class="text-[0.85rem] text-foreground font-medium font-mono"
                        title={p().recipient}
                      >
                        {formatAddress(p().recipient)}
                      </span>
                    </div>
                  </Show>
                </div>

                <Show when={availableMethods().length > 1}>
                  <div class="my-4">
                    <span class="block text-[0.9rem] text-muted-foreground mb-3">
                      Pay with:
                    </span>
                    <div class="flex gap-3 max-sm:flex-col">
                      <For each={availableMethods()}>
                        {(method) => (
                          <button
                            type="button"
                            class={`relative flex-1 flex items-center gap-3 px-4 py-3.5 bg-black/20 border-2 rounded-[10px] cursor-pointer transition-all duration-150 text-left ${
                              selectedMethod() === method.id
                                ? "border-accent bg-primary/10"
                                : "border-border-hover hover:not-disabled:border-muted-foreground/40"
                            } ${!method.available ? "opacity-50 cursor-not-allowed" : ""}`}
                            onClick={() =>
                              method.available && setSelectedMethod(method.id)
                            }
                            disabled={!method.available}
                            title={method.reason}
                          >
                            <span class="text-[1.3rem]">{method.icon}</span>
                            <div class="flex flex-col gap-0.5 flex-1">
                              <span class="text-[0.9rem] font-medium text-foreground">
                                {method.label}
                              </span>
                              <span class="text-[0.8rem] text-muted-foreground font-mono">
                                {method.balance}
                              </span>
                            </div>
                            <Show when={!method.available}>
                              <span class="absolute bottom-1 right-2 text-[0.75rem] text-destructive">
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
                  <p class="m-0 p-3 bg-warning/10 border border-warning/30 rounded-lg text-[0.85rem] text-warning/85 leading-relaxed">
                    This payment will be signed with your crypto wallet and
                    submitted to {p().chainName}. Your wallet will prompt you to
                    confirm the signature.
                  </p>
                </Show>

                <Show when={selectedMethod() === "serenbucks"}>
                  <p class="m-0 p-3 bg-primary/10 border border-primary/30 rounded-lg text-[0.85rem] text-accent leading-relaxed">
                    This will be charged to your SerenBucks balance.
                  </p>
                </Show>
              </div>

              <div class="flex gap-3 justify-end">
                <button
                  type="button"
                  class="px-5 py-2.5 rounded-lg text-[0.95rem] font-medium cursor-pointer transition-all duration-150 bg-transparent border border-border-strong text-muted-foreground hover:not-disabled:bg-border hover:not-disabled:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleDecline}
                  disabled={isProcessing()}
                >
                  Decline
                </button>
                <button
                  type="button"
                  class="px-5 py-2.5 rounded-lg text-[0.95rem] font-medium cursor-pointer transition-all duration-150 bg-success border-none text-white hover:not-disabled:bg-success/85 disabled:opacity-50 disabled:cursor-not-allowed"
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
