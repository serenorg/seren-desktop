// ABOUTME: Wallet store for managing SerenBucks balance state.
// ABOUTME: Provides reactive balance updates with automatic refresh.

import { createStore } from "solid-js/store";
import { fetchBalance, type WalletBalance } from "@/services/wallet";

/**
 * Wallet state interface.
 * Uses balance_usd from API for display, balance_atomic for calculations.
 */
interface WalletState {
  /** Balance in USD (computed from atomic for component compatibility) */
  balance: number | null;
  /** Balance in atomic units (for precise calculations) */
  balance_atomic: number | null;
  /** Balance formatted as USD string (for display) */
  balance_usd: string | null;
  /** Last refresh timestamp */
  lastUpdated: string | null;
  isLoading: boolean;
  error: string | null;
  /** For dismissing low balance warning */
  lastDismissedBalanceAtomic: number | null;
}

/**
 * Initial wallet state.
 */
const initialState: WalletState = {
  balance: null,
  balance_atomic: null,
  balance_usd: null,
  lastUpdated: null,
  isLoading: false,
  error: null,
  lastDismissedBalanceAtomic: null,
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
    console.log("[Wallet Store] Skipping refresh - already loading");
    return;
  }

  console.log("[Wallet Store] Setting isLoading = true");
  setWalletState("isLoading", true);
  setWalletState("error", null);

  try {
    const data: WalletBalance = await fetchBalance();
    console.log("[Wallet Store] Setting isLoading = false (success)");
    setWalletState({
      balance: data.balance_atomic / 1_000_000,
      balance_atomic: data.balance_atomic,
      balance_usd: data.balance_usd,
      lastUpdated: new Date().toISOString(),
      isLoading: false,
    });
    console.log("[Wallet Store] State updated, isLoading:", walletState.isLoading);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch balance";
    console.error("[Wallet Store] Error refreshing balance:", message);
    // Stop auto-refresh on auth errors to prevent 401 spam
    if (
      message.includes("expired") ||
      message.includes("401") ||
      message.includes("Authentication")
    ) {
      stopAutoRefresh();
    }
    console.log("[Wallet Store] Setting isLoading = false (error)");
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
    console.log("[Wallet Store] Auto-refresh already running");
    return;
  }

  console.log("[Wallet Store] Starting auto-refresh");
  // Fetch immediately (but only if not already loading)
  if (!walletState.isLoading) {
    refreshBalance();
  }

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
  setWalletState("lastDismissedBalanceAtomic", walletState.balance_atomic);
}

/**
 * Check if low balance warning should show.
 * @param threshold The low balance threshold in USD
 */
function shouldShowLowBalanceWarning(threshold: number): boolean {
  const { balance_atomic, lastDismissedBalanceAtomic } = walletState;

  // Don't show if balance unknown
  if (balance_atomic === null) {
    return false;
  }

  // Convert threshold to atomic (1 USD = 1,000,000 atomic)
  const thresholdAtomic = threshold * 1_000_000;

  // Don't show if above threshold
  if (balance_atomic >= thresholdAtomic) {
    return false;
  }

  // Show if never dismissed
  if (lastDismissedBalanceAtomic === null) {
    return true;
  }

  // Show if balance dropped further since dismissal
  return balance_atomic < lastDismissedBalanceAtomic;
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
   * Get current balance in USD (atomic / 1_000_000).
   */
  get balance(): number | null {
    return walletState.balance_atomic !== null
      ? walletState.balance_atomic / 1_000_000
      : null;
  },

  /**
   * Get balance as formatted USD string from API.
   */
  get balanceUsd(): string | null {
    return walletState.balance_usd;
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
   * Format balance for display (uses API-formatted string).
   */
  get formattedBalance(): string {
    // API already returns balance_usd with $ prefix (e.g., "$3.67")
    return walletState.balance_usd || "--";
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
