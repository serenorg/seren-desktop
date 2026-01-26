// ABOUTME: Auto top-up service for automatic balance replenishment.
// ABOUTME: Monitors balance and triggers Stripe checkout when below threshold.

import { createEffect } from "solid-js";
import {
  walletState,
  refreshBalance,
  isTopUpInProgress,
  setTopUpInProgress,
} from "@/stores/wallet.store";
import { settingsStore } from "@/stores/settings.store";
import { initiateTopUp, openCheckout } from "@/services/wallet";

/**
 * Auto top-up event types.
 */
export type AutoTopUpEventType =
  | "triggered"
  | "checkout_opened"
  | "completed"
  | "failed"
  | "skipped";

/**
 * Auto top-up event for logging/history.
 */
export interface AutoTopUpEvent {
  type: AutoTopUpEventType;
  timestamp: string;
  balance: number | null;
  threshold: number;
  amount: number;
  error?: string;
}

// Event history for the current session
const eventHistory: AutoTopUpEvent[] = [];

// Debounce timer to prevent rapid triggers
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_DELAY = 5000; // 5 seconds

/**
 * Log an auto top-up event.
 */
function logEvent(
  type: AutoTopUpEventType,
  balance: number | null,
  threshold: number,
  amount: number,
  error?: string
): void {
  const event: AutoTopUpEvent = {
    type,
    timestamp: new Date().toISOString(),
    balance,
    threshold,
    amount,
    error,
  };
  eventHistory.push(event);

  // Keep only last 50 events
  if (eventHistory.length > 50) {
    eventHistory.shift();
  }

  // Log to console for debugging
  if (type === "failed") {
    console.error("[AutoTopUp]", type, event);
  }
}

/**
 * Get auto top-up event history.
 */
export function getAutoTopUpHistory(): AutoTopUpEvent[] {
  return [...eventHistory];
}

/**
 * Clear auto top-up event history.
 */
export function clearAutoTopUpHistory(): void {
  eventHistory.length = 0;
}

/**
 * Check if auto top-up should be triggered.
 */
function shouldTriggerAutoTopUp(): boolean {
  const balance = walletState.balance;
  const isEnabled = settingsStore.get("autoTopUpEnabled");
  const threshold = settingsStore.get("autoTopUpThreshold");

  // Not enabled
  if (!isEnabled) {
    return false;
  }

  // Balance unknown
  if (balance === null) {
    return false;
  }

  // Already in progress
  if (isTopUpInProgress()) {
    return false;
  }

  // Balance above threshold
  if (balance >= threshold) {
    return false;
  }

  return true;
}

/**
 * Trigger auto top-up process.
 */
async function triggerAutoTopUp(): Promise<void> {
  if (!shouldTriggerAutoTopUp()) {
    return;
  }

  const balance = walletState.balance;
  const threshold = settingsStore.get("autoTopUpThreshold");
  const amount = settingsStore.get("autoTopUpAmount");

  // Set lock to prevent duplicates
  setTopUpInProgress(true);

  logEvent("triggered", balance, threshold, amount);

  try {
    // Initiate checkout
    const checkout = await initiateTopUp(amount);

    logEvent("checkout_opened", balance, threshold, amount);

    // Open in browser
    await openCheckout(checkout.checkout_url);

    // Note: Completion is handled when user returns and balance is refreshed
    // We'll keep the lock for a reasonable time, then release it
    setTimeout(() => {
      setTopUpInProgress(false);
      // Refresh balance to check if top-up completed
      refreshBalance();
    }, 30000); // 30 seconds
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logEvent("failed", balance, threshold, amount, message);
    setTopUpInProgress(false);
  }
}

/**
 * Debounced auto top-up trigger.
 */
function debouncedTrigger(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    triggerAutoTopUp();
  }, DEBOUNCE_DELAY);
}

/**
 * Initialize auto top-up monitoring.
 * Call this in your app's root component.
 * @returns Cleanup function
 */
export function initAutoTopUp(): () => void {
  // Create reactive effect that monitors balance
  createEffect(() => {
    const balance = walletState.balance;
    const isEnabled = settingsStore.get("autoTopUpEnabled");
    const threshold = settingsStore.get("autoTopUpThreshold");

    // Only trigger if conditions are met
    if (isEnabled && balance !== null && balance < threshold) {
      debouncedTrigger();
    }
  });

  // Return cleanup function
  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    // Note: SolidJS effects auto-cleanup, but we clear our timer
  };
}

/**
 * Manually trigger auto top-up check.
 * Useful after operations that consume credits.
 */
export function checkAutoTopUp(): void {
  if (shouldTriggerAutoTopUp()) {
    debouncedTrigger();
  }
}
