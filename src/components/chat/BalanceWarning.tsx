// ABOUTME: Friendly inline warning for insufficient balance errors in chat.
// ABOUTME: Replaces ugly JSON error wall with actionable top-up prompt.

import { type Component, createSignal, Show } from "solid-js";
import { initiateTopUp, openCheckout } from "@/services/wallet";
import { settingsStore } from "@/stores/settings.store";

export interface BalanceInfo {
  currentBalance: number;
  requiredAmount: number;
  deficit: number;
}

interface BalanceWarningProps {
  balanceInfo?: BalanceInfo;
  onDismiss?: () => void;
}

/**
 * Parse a 402 error response to extract balance information.
 * Returns null if the error is not a balance error or can't be parsed.
 */
export function parseBalanceError(errorMessage: string): BalanceInfo | null {
  // Check if this is a 402 insufficient balance error
  if (!errorMessage.includes("402") || !errorMessage.includes("Insufficient")) {
    return null;
  }

  try {
    // Try to extract JSON from the error message
    const jsonMatch = errorMessage.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const errorData = JSON.parse(jsonMatch[0]);

    // Extract balance info from the error payload
    const availableBalance =
      errorData.extra?.availableBalance ?? errorData.availableBalance ?? 0;
    const requiredAmount =
      errorData.extra?.requiredAmount ?? errorData.requiredAmount ?? 0;
    const deficit =
      errorData.extra?.deficit ??
      errorData.deficit ??
      requiredAmount - availableBalance;

    return {
      currentBalance: availableBalance,
      requiredAmount,
      deficit: Math.abs(deficit),
    };
  } catch {
    // If parsing fails, return a generic balance info
    return {
      currentBalance: 0,
      requiredAmount: 0,
      deficit: 0,
    };
  }
}

/**
 * Check if an error message is a balance-related error.
 */
export function isBalanceError(errorMessage: string): boolean {
  return (
    errorMessage.includes("402") ||
    errorMessage.toLowerCase().includes("insufficient") ||
    (errorMessage.toLowerCase().includes("balance") &&
      errorMessage.toLowerCase().includes("prepaid"))
  );
}

export const BalanceWarning: Component<BalanceWarningProps> = (props) => {
  const [isTopUpLoading, setIsTopUpLoading] = createSignal(false);
  const [topUpError, setTopUpError] = createSignal<string | null>(null);

  const formatCurrency = (amount: number) => {
    return `$${amount.toFixed(2)}`;
  };

  const handleTopUp = async () => {
    setIsTopUpLoading(true);
    setTopUpError(null);

    try {
      const topUpAmount = settingsStore.get("autoTopUpAmount");
      const checkout = await initiateTopUp(topUpAmount);
      await openCheckout(checkout.checkout_url);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to initiate top-up";
      setTopUpError(message);
    } finally {
      setIsTopUpLoading(false);
    }
  };

  return (
    <div class="mx-5 my-4 bg-[rgba(227,179,65,0.1)] border border-[rgba(227,179,65,0.4)] rounded-lg overflow-hidden">
      <div class="flex items-start gap-3 p-4">
        {/* Warning icon */}
        <div class="shrink-0 w-8 h-8 rounded-full bg-[rgba(227,179,65,0.2)] flex items-center justify-center">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#e3b341"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            role="img"
            aria-label="Warning"
          >
            <title>Warning</title>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>

        <div class="flex-1 min-w-0">
          <h4 class="m-0 mb-1 text-sm font-semibold text-[#e3b341]">
            Insufficient Balance
          </h4>
          <p class="m-0 mb-3 text-sm text-[#c9d1d9] leading-relaxed">
            Your SerenBucks balance is too low to complete this request. Top up
            your wallet to continue chatting.
          </p>

          <Show when={props.balanceInfo}>
            {(info) => (
              <div class="flex flex-wrap gap-4 mb-3 text-xs text-[#8b949e]">
                <div>
                  <span class="text-[#6e7681]">Current: </span>
                  <span class="text-[#c9d1d9] font-medium">
                    {formatCurrency(info().currentBalance)}
                  </span>
                </div>
                <Show when={info().requiredAmount > 0}>
                  <div>
                    <span class="text-[#6e7681]">Required: </span>
                    <span class="text-[#c9d1d9] font-medium">
                      {formatCurrency(info().requiredAmount)}
                    </span>
                  </div>
                </Show>
                <Show when={info().deficit > 0}>
                  <div>
                    <span class="text-[#6e7681]">Need: </span>
                    <span class="text-[#e3b341] font-medium">
                      +{formatCurrency(info().deficit)}
                    </span>
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <Show when={topUpError()}>
            <div class="mb-3 text-xs text-[#f85149] p-2 bg-[rgba(248,81,73,0.1)] rounded">
              {topUpError()}
            </div>
          </Show>

          <div class="flex gap-2">
            <button
              type="button"
              onClick={handleTopUp}
              disabled={isTopUpLoading()}
              class="bg-[#e3b341] text-[#0d1117] border-none px-4 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors hover:bg-[#f0c351] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isTopUpLoading() ? "Loading..." : "Top Up Wallet"}
            </button>
            <Show when={props.onDismiss}>
              <button
                type="button"
                onClick={props.onDismiss}
                class="bg-transparent border border-[rgba(227,179,65,0.4)] text-[#e3b341] px-3 py-1.5 rounded-md text-xs cursor-pointer transition-colors hover:bg-[rgba(227,179,65,0.1)]"
              >
                Dismiss
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
};
