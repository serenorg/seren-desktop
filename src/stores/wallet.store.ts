// ABOUTME: Wallet store for managing SerenBucks balance state.
// ABOUTME: Provides reactive balance updates with automatic refresh.

import { createStore } from "solid-js/store";
import { fetchBalance, WalletBalance } from "@/services/wallet";

/**
 * Wallet state interface.
 */
interface WalletState {
  balance: number | null;
  currency: string;
  lastUpdated: string | null;
  isLoading: boolean;
  error: string | null;
  lastDismissedBalance: number | null;
}

/**
 * Initial wallet state.
 */
const initialState: WalletState = {
  balance: null,
  currency: "USD",
  lastUpdated: null,
  isLoading: false,
  error: null,
  lastDismissedBalance: null,
};

const [walletState, setWalletState] = createStore<WalletState>(initialState);

// Refresh interval in milliseconds (60 seconds)
const REFRESH_INTERVAL = 60_000;

// Timer reference for cleanup
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// Lock to prevent duplicate top-ups
let topUpInProgress = false;

/**
 * Refresh the wallet balance from the API.
 */
async function refreshBalance(): Promise<void> {
  // Skip if already loading
  if (walletState.isLoading) {
    return;
  }

  setWalletState("isLoading", true);
  setWalletState("error", null);

  try {
    const data: WalletBalance = await fetchBalance();
    setWalletState({
      balance: data.balance,
      currency: data.currency || "USD",
      lastUpdated: data.lastUpdated || new Date().toISOString(),
      isLoading: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch balance";
    setWalletState({
      isLoading: false,
      error: message,
    });
  }
}

/**
 * Start automatic balance refresh.
 */
function startAutoRefresh(): void {
  if (refreshTimer) {
    return;
  }

  // Fetch immediately
  refreshBalance();

  // Then refresh periodically
  refreshTimer = setInterval(() => {
    refreshBalance();
  }, REFRESH_INTERVAL);
}

/**
 * Stop automatic balance refresh.
 */
function stopAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Dismiss the low balance warning.
 * Stores the current balance so warning doesn't reappear until balance drops further.
 */
function dismissLowBalanceWarning(): void {
  setWalletState("lastDismissedBalance", walletState.balance);
}

/**
 * Check if low balance warning should show.
 * @param threshold The low balance threshold from settings
 */
function shouldShowLowBalanceWarning(threshold: number): boolean {
  const { balance, lastDismissedBalance } = walletState;

  // Don't show if balance unknown
  if (balance === null) {
    return false;
  }

  // Don't show if above threshold
  if (balance >= threshold) {
    return false;
  }

  // Show if never dismissed
  if (lastDismissedBalance === null) {
    return true;
  }

  // Show if balance dropped further since dismissal
  return balance < lastDismissedBalance;
}

/**
 * Check if auto top-up is in progress.
 */
function isTopUpInProgress(): boolean {
  return topUpInProgress;
}

/**
 * Set top-up in progress lock.
 */
function setTopUpInProgress(inProgress: boolean): void {
  topUpInProgress = inProgress;
}

/**
 * Reset wallet state (e.g., on logout).
 */
function resetWalletState(): void {
  stopAutoRefresh();
  setWalletState(initialState);
  topUpInProgress = false;
}

/**
 * Wallet store with reactive state and actions.
 */
export const walletStore = {
  /**
   * Get current balance.
   */
  get balance(): number | null {
    return walletState.balance;
  },

  /**
   * Get currency code.
   */
  get currency(): string {
    return walletState.currency;
  },

  /**
   * Get loading state.
   */
  get isLoading(): boolean {
    return walletState.isLoading;
  },

  /**
   * Get error message.
   */
  get error(): string | null {
    return walletState.error;
  },

  /**
   * Get last updated timestamp.
   */
  get lastUpdated(): string | null {
    return walletState.lastUpdated;
  },

  /**
   * Format balance for display.
   */
  get formattedBalance(): string {
    if (walletState.balance === null) {
      return "--";
    }
    return `$${walletState.balance.toFixed(2)}`;
  },
};

// Export state and actions
export {
  walletState,
  refreshBalance,
  startAutoRefresh,
  stopAutoRefresh,
  dismissLowBalanceWarning,
  shouldShowLowBalanceWarning,
  isTopUpInProgress,
  setTopUpInProgress,
  resetWalletState,
};
