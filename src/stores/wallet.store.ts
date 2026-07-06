// ABOUTME: Wallet store for managing SerenBucks balance state.
// ABOUTME: Provides reactive balance updates with automatic refresh.

import { createStore } from "solid-js/store";
import {
  claimDailyCredits,
  type DailyClaimEligibility,
  type DailyClaimResponse,
  fetchDailyEligibility,
} from "@/services/dailyClaim";
import {
  fetchBalance,
  markWalletNotificationRead,
  type ReceivedTransferNotificationSummary,
  type WalletBalance,
} from "@/services/wallet";

export type LatestReceivedTransfer = ReceivedTransferNotificationSummary;

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
  /** Timer for periodic daily claim eligibility re-checks */
  dailyClaimTimerId: ReturnType<typeof setInterval> | null;
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
  dailyClaimTimerId: null,
};

const [walletState, setWalletState] = createStore<WalletState>(initialState);

// Refresh interval in milliseconds (60 seconds)
const REFRESH_INTERVAL = 60_000;

// Daily claim re-check interval (30 minutes)
const DAILY_CLAIM_POLL_INTERVAL = 30 * 60 * 1_000;

// Lock to prevent duplicate top-ups
let topUpInProgress = false;

// Track consecutive failures to stop refresh after persistent errors
const MAX_CONSECUTIVE_FAILURES = 5;
let consecutiveFailures = 0;

const receivedTransferStorageKey = (walletAddress: string) =>
  `seren:last-received-transfer:${walletAddress}`;

interface ReceivedTransferSentinel {
  version: 1;
  latestTransferId: string | null;
  initializedAtMs: number;
}

const receivedTransferSentinels = new Map<string, ReceivedTransferSentinel>();

const FIRST_SEEN_RECEIVED_TRANSFER_NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;

function isRecentReceivedTransfer(
  transfer: LatestReceivedTransfer,
  nowMs: number,
): boolean {
  const receivedAtMs = Date.parse(transfer.received_at);
  if (!Number.isFinite(receivedAtMs)) {
    return false;
  }

  return (
    receivedAtMs <= nowMs + CLOCK_SKEW_ALLOWANCE_MS &&
    nowMs - receivedAtMs <= FIRST_SEEN_RECEIVED_TRANSFER_NOTIFY_WINDOW_MS
  );
}

function receivedTransferTimestampMs(
  transfer: LatestReceivedTransfer,
): number | null {
  const receivedAtMs = Date.parse(transfer.received_at);
  return Number.isFinite(receivedAtMs) ? receivedAtMs : null;
}

function readReceivedTransferSentinel(
  key: string,
): ReceivedTransferSentinel | null {
  let raw: string | null = null;
  let storageReadSucceeded = false;
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      raw = storage.getItem(key);
      storageReadSucceeded = true;
    }
  } catch {
    raw = null;
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ReceivedTransferSentinel>;
      if (
        parsed.version === 1 &&
        (typeof parsed.latestTransferId === "string" ||
          parsed.latestTransferId === null) &&
        typeof parsed.initializedAtMs === "number" &&
        Number.isFinite(parsed.initializedAtMs)
      ) {
        const sentinel = {
          version: 1,
          latestTransferId: parsed.latestTransferId,
          initializedAtMs: parsed.initializedAtMs,
        } satisfies ReceivedTransferSentinel;
        receivedTransferSentinels.set(key, sentinel);
        return sentinel;
      }
    } catch {
      const sentinel = {
        version: 1,
        latestTransferId: raw === "none" ? null : raw,
        initializedAtMs: 0,
      } satisfies ReceivedTransferSentinel;
      receivedTransferSentinels.set(key, sentinel);
      return sentinel;
    }
  }

  if (storageReadSucceeded) {
    return null;
  }

  return receivedTransferSentinels.get(key) ?? null;
}

function writeReceivedTransferSentinel(
  key: string,
  sentinel: ReceivedTransferSentinel,
): void {
  receivedTransferSentinels.set(key, sentinel);
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(sentinel));
  } catch {
    // In-memory state still deduplicates during the current app session.
  }
}

function shouldNotifyReceivedTransfer(
  previous: ReceivedTransferSentinel | null,
  transfer: LatestReceivedTransfer,
  nowMs: number,
): boolean {
  if (!previous) {
    return isRecentReceivedTransfer(transfer, nowMs);
  }

  if (previous.latestTransferId === transfer.transfer_id) {
    return false;
  }

  if (previous.initializedAtMs <= 0) {
    return isRecentReceivedTransfer(transfer, nowMs);
  }

  const receivedAtMs = receivedTransferTimestampMs(transfer);
  if (receivedAtMs === null) {
    return false;
  }

  return (
    receivedAtMs >= previous.initializedAtMs - CLOCK_SKEW_ALLOWANCE_MS ||
    isRecentReceivedTransfer(transfer, nowMs)
  );
}

export function markLatestReceivedTransferSeen(
  walletAddress: string,
  transfer: LatestReceivedTransfer | null | undefined,
  nowMs = Date.now(),
): boolean {
  const key = receivedTransferStorageKey(walletAddress);
  const previous = readReceivedTransferSentinel(key);
  if (!transfer) {
    if (!previous) {
      writeReceivedTransferSentinel(key, {
        version: 1,
        latestTransferId: null,
        initializedAtMs: nowMs,
      });
    }
    return false;
  }

  const initializedAtMs =
    previous && previous.initializedAtMs > 0 ? previous.initializedAtMs : nowMs;
  const shouldNotify = shouldNotifyReceivedTransfer(previous, transfer, nowMs);
  writeReceivedTransferSentinel(key, {
    version: 1,
    latestTransferId: transfer.transfer_id,
    initializedAtMs,
  });

  return shouldNotify;
}

async function notifyReceivedTransfer(
  transfer: LatestReceivedTransfer,
): Promise<void> {
  try {
    if (typeof Notification === "undefined") {
      return;
    }

    const title = "SerenBucks received";
    const body = `${transfer.sender_display_name || transfer.sender_email} sent ${transfer.amount_usd}`;

    if (Notification.permission === "granted") {
      new Notification(title, { body });
      return;
    }

    if (Notification.permission !== "denied") {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        new Notification(title, { body });
      }
    }
  } catch (error) {
    console.warn("[Wallet Store] Failed to show transfer notification:", error);
    // Notification support varies by runtime; balance refresh should not fail.
  }
}

async function handleReceivedTransferNotification(
  walletAddress: string,
  transfer: LatestReceivedTransfer,
): Promise<void> {
  const shouldNotify = markLatestReceivedTransferSeen(walletAddress, transfer);
  const markRead = transfer.notification_id
    ? markWalletNotificationRead(transfer.notification_id).catch((error) => {
        console.warn(
          "[Wallet Store] Failed to mark transfer notification read:",
          error,
        );
      })
    : Promise.resolve();

  if (shouldNotify) {
    await notifyReceivedTransfer(transfer);
  }

  await markRead;
}

async function handleReceivedTransferNotifications(
  walletAddress: string,
  transfers: LatestReceivedTransfer[],
): Promise<void> {
  for (const transfer of [...transfers].reverse()) {
    await handleReceivedTransferNotification(walletAddress, transfer);
  }
}

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
    consecutiveFailures = 0;
    setWalletState({
      balance: data.balance_atomic / 1_000_000,
      balance_atomic: data.balance_atomic,
      balance_usd: data.balance_usd,
      lastUpdated: new Date().toISOString(),
      isLoading: false,
    });
    const unreadReceivedTransfers = data.unread_received_transfers ?? [];
    if (unreadReceivedTransfers.length > 0) {
      void handleReceivedTransferNotifications(
        data.wallet_address,
        unreadReceivedTransfers,
      );
    } else {
      markLatestReceivedTransferSeen(data.wallet_address, null);
    }
  } catch (err) {
    consecutiveFailures++;
    const message =
      err instanceof Error ? err.message : "Failed to fetch balance";
    // Background poll: expired sessions and transient network blips are the
    // dominant cases, and the underlying HTTP failure is already captured
    // centrally by the wallet service's fetch. Local diagnostic only.
    console.warn("[Wallet Store] Error refreshing balance:", message);

    const isAuthError =
      message.includes("expired") ||
      message.includes("401") ||
      message.includes("Authentication") ||
      message.includes("Unauthorized");

    // On auth errors, just stop polling. Never force logout from here —
    // the Rust backend emits auth:session-expired when both tokens are dead,
    // and user-initiated requests handle their own refresh. A background
    // poller should not yank tokens from under in-flight orchestrator work.
    if (isAuthError) {
      console.warn(
        "[Wallet Store] Auth error, stopping poller (backend handles refresh)",
      );
      stopAutoRefresh();
    } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.warn(
        `[Wallet Store] Stopping auto-refresh after ${consecutiveFailures} consecutive failures`,
      );
      stopAutoRefresh();
    }

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
    return;
  }

  setWalletState("autoRefreshActive", true);
  consecutiveFailures = 0;

  // Fetch immediately (but only if not already loading)
  if (!walletState.isLoading) {
    refreshBalance();
  }

  // Then refresh periodically
  const timerId = setInterval(() => {
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
 * Start periodic re-checking of daily claim eligibility.
 * Surfaces the claim popup for long-running sessions that span midnight UTC.
 */
function startDailyClaimPolling(): void {
  if (walletState.dailyClaimTimerId) return;

  const timerId = setInterval(async () => {
    const wasPreviouslyEligible = walletState.dailyClaim?.can_claim ?? false;
    try {
      const eligibility = await fetchDailyEligibility();
      setWalletState("dailyClaim", eligibility);
      // New eligibility appeared — reset dismiss so popup re-surfaces
      if (!wasPreviouslyEligible && eligibility.can_claim) {
        setWalletState("dailyClaimDismissed", false);
      }
    } catch {
      // Silently ignore — don't clear existing state on transient errors
    }
  }, DAILY_CLAIM_POLL_INTERVAL);

  setWalletState("dailyClaimTimerId", timerId);
}

/**
 * Stop periodic daily claim eligibility re-checks.
 */
function stopDailyClaimPolling(): void {
  const timerId = walletState.dailyClaimTimerId;
  if (timerId) {
    clearInterval(timerId);
  }
  setWalletState("dailyClaimTimerId", null);
}

/**
 * Reset wallet state (e.g., on logout).
 */
function resetWalletState(): void {
  stopAutoRefresh();
  stopDailyClaimPolling();
  receivedTransferSentinels.clear();
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
  checkDailyClaim,
  claimDaily,
  dismissDailyClaim,
  dismissLowBalanceWarning,
  isTopUpInProgress,
  refreshBalance,
  resetWalletState,
  setTopUpInProgress,
  shouldShowLowBalanceWarning,
  startAutoRefresh,
  startDailyClaimPolling,
  stopAutoRefresh,
  stopDailyClaimPolling,
  updateBalanceFromError,
  walletState,
};
