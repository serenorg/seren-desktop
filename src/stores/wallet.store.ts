// ABOUTME: Wallet store for managing SerenBucks balance state.
// ABOUTME: Provides reactive balance updates with automatic refresh.

import { createStore } from "solid-js/store";
import {
  claimDailyCredits,
  type DailyClaimEligibility,
  type DailyClaimResponse,
  fetchDailyEligibility,
} from "@/services/dailyClaim";
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
  /** Track if auto-refresh is active (HMR-resistant) */
  autoRefreshActive: boolean;
  /** Store timer ID in state for HMR safety */
  refreshTimerId: ReturnType<typeof setInterval> | null;
  /** Daily claim eligibility data */
  dailyClaim: DailyClaimEligibility | null;
  /** Whether user dismissed the daily claim popup this session */
  dailyClaimDismissed: boolean;
  /** Whether daily claim check is in progress */
  dailyClaimLoading: boolean;
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
  autoRefreshActive: false,
  refreshTimerId: null,
  dailyClaim: null,
  dailyClaimDismissed: false,
  dailyClaimLoading: false,
};

const [walletState, setWalletState] = createStore<WalletState>(initialState);

// Refresh interval in milliseconds (60 seconds)
const REFRESH_INTERVAL = 60_000;

// Lock to prevent duplicate top-ups
let topUpInProgress = false;

// Track consecutive failures to stop refresh after persistent errors
const MAX_CONSECUTIVE_FAILURES = 5;
let consecutiveFailures = 0;

/**
 * Refresh the wallet balance from the API.
 */
async function refreshBalance(): Promise<void> {
  // Skip if already loading
  if (walletState.isLoading) {
    console.log("[Wallet Store] Skipping refresh - already loading");
    return;
  }

  // Add stack trace to identify caller
  console.log(
    "[Wallet Store] refreshBalance called from:",
    new Error().stack?.split("\n")[2]?.trim(),
  );
  console.log("[Wallet Store] Setting isLoading = true");
  setWalletState("isLoading", true);
  setWalletState("error", null);

  try {
    const data: WalletBalance = await fetchBalance();
    consecutiveFailures = 0;
    console.log("[Wallet Store] Setting isLoading = false (success)");
    setWalletState({
      balance: data.balance_atomic / 1_000_000,
      balance_atomic: data.balance_atomic,
      balance_usd: data.balance_usd,
      lastUpdated: new Date().toISOString(),
      isLoading: false,
    });
    console.log(
      "[Wallet Store] State updated, isLoading:",
      walletState.isLoading,
    );
  } catch (err) {
    consecutiveFailures++;
    const message =
      err instanceof Error ? err.message : "Failed to fetch balance";
    console.error("[Wallet Store] Error refreshing balance:", message);
    // Stop auto-refresh on auth errors or persistent failures
    if (
      message.includes("expired") ||
      message.includes("401") ||
      message.includes("Authentication") ||
      message.includes("Unauthorized") ||
      consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
    ) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `[Wallet Store] Stopping auto-refresh after ${consecutiveFailures} consecutive failures`,
        );
      }
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
  // Check store flag instead of module-level variable (HMR-resistant)
  if (walletState.autoRefreshActive) {
    console.log("[Wallet Store] Auto-refresh already active, skipping");
    return;
  }

  console.log(
    "[Wallet Store] Starting auto-refresh, called from:",
    new Error().stack?.split("\n")[2]?.trim(),
  );
  setWalletState("autoRefreshActive", true);
  consecutiveFailures = 0;

  // Fetch immediately (but only if not already loading)
  if (!walletState.isLoading) {
    console.log("[Wallet Store] Triggering initial balance fetch");
    refreshBalance();
  }

  // Then refresh periodically
  console.log(`[Wallet Store] Setting up ${REFRESH_INTERVAL}ms interval`);
  const timerId = setInterval(() => {
    console.log("[Wallet Store] Interval timer fired");
    refreshBalance();
  }, REFRESH_INTERVAL);

  // Store timer ID in state for HMR safety
  setWalletState("refreshTimerId", timerId);
}

/**
 * Stop automatic balance refresh.
 */
function stopAutoRefresh(): void {
  const timerId = walletState.refreshTimerId;
  if (timerId) {
    console.log("[Wallet Store] Stopping auto-refresh, clearing interval");
    clearInterval(timerId);
  }
  setWalletState({
    autoRefreshActive: false,
    refreshTimerId: null,
  });
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
 * Check if the user is eligible to claim daily credits.
 * Called after login to determine if popup should show.
 */
async function checkDailyClaim(): Promise<void> {
  setWalletState("dailyClaimLoading", true);
  try {
    const eligibility = await fetchDailyEligibility();
    setWalletState("dailyClaim", eligibility);
  } catch (err) {
    console.error("[Wallet Store] Failed to check daily claim:", err);
    setWalletState("dailyClaim", null);
  } finally {
    setWalletState("dailyClaimLoading", false);
  }
}

/**
 * Claim daily credits and refresh balance.
 */
async function claimDaily(): Promise<DailyClaimResponse> {
  const result = await claimDailyCredits();
  // Update wallet balance from claim response
  setWalletState({
    balance: result.balance_atomic / 1_000_000,
    balance_atomic: result.balance_atomic,
    balance_usd: result.balance_usd,
    lastUpdated: new Date().toISOString(),
  });
  // Update eligibility — user just claimed
  setWalletState("dailyClaim", {
    can_claim: false,
    claims_remaining_this_month: result.claims_remaining_this_month,
    reason: "Already claimed today",
    resets_in_seconds: null,
  });
  return result;
}

/**
 * Dismiss the daily claim popup for this session.
 */
function dismissDailyClaim(): void {
  setWalletState("dailyClaimDismissed", true);
}

/**
 * Reset wallet state (e.g., on logout).
 */
function resetWalletState(): void {
  stopAutoRefresh();
  setWalletState(initialState);
  topUpInProgress = false;
  consecutiveFailures = 0;
}

/**
 * Update wallet balance from a 402 error response.
 * This ensures the displayed balance matches reality when an insufficient funds error occurs.
 * @param availableBalanceAtomic The actual balance in atomic units (from 402 error response)
 */
function updateBalanceFromError(availableBalanceAtomic: number): void {
  const balanceUsd = `$${(availableBalanceAtomic / 1_000_000).toFixed(2)}`;
  console.log(
    "[Wallet Store] Updating balance from 402 error:",
    availableBalanceAtomic,
    "->",
    balanceUsd,
  );
  setWalletState({
    balance: availableBalanceAtomic / 1_000_000,
    balance_atomic: availableBalanceAtomic,
    balance_usd: balanceUsd,
    lastUpdated: new Date().toISOString(),
    error: null,
  });
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
  checkDailyClaim,
  claimDaily,
  dismissDailyClaim,
  updateBalanceFromError,
};
