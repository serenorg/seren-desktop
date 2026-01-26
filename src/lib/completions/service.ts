import { createSignal } from "solid-js";
import type { CompletionContext, CompletionResult } from "./provider";
import { setCompletionHandler } from "./provider";

// Configuration
const DEFAULT_DEBOUNCE_MS = 300;
const CACHE_MAX_SIZE = 100;
const CACHE_TTL_MS = 60000; // 1 minute

// State
const [isEnabled, setIsEnabled] = createSignal(true);
const [debounceMs, setDebounceMs] = createSignal(DEFAULT_DEBOUNCE_MS);

// Debounce state
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastRequestId = 0;

// LRU Cache
interface CacheEntry {
  results: CompletionResult[];
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const cacheOrder: string[] = [];

/**
 * Generate a cache key from the completion context.
 */
function getCacheKey(context: CompletionContext): string {
  // Key based on language, prefix (last 200 chars), and suffix (first 100 chars)
  const prefixKey = context.prefix.slice(-200);
  const suffixKey = context.suffix.slice(0, 100);
  return `${context.language}:${prefixKey}:${suffixKey}`;
}

/**
 * Get cached results if available and not expired.
 */
function getFromCache(key: string): CompletionResult[] | null {
  const entry = cache.get(key);
  if (!entry) return null;

  // Check if expired
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    const idx = cacheOrder.indexOf(key);
    if (idx !== -1) cacheOrder.splice(idx, 1);
    return null;
  }

  // Move to end of LRU order
  const idx = cacheOrder.indexOf(key);
  if (idx !== -1) {
    cacheOrder.splice(idx, 1);
    cacheOrder.push(key);
  }

  return entry.results;
}

/**
 * Add results to cache.
 */
function addToCache(key: string, results: CompletionResult[]): void {
  // Evict oldest if at capacity
  while (cacheOrder.length >= CACHE_MAX_SIZE) {
    const oldest = cacheOrder.shift();
    if (oldest) cache.delete(oldest);
  }

  cache.set(key, { results, timestamp: Date.now() });
  cacheOrder.push(key);
}

/**
 * Clear the completion cache.
 */
export function clearCache(): void {
  cache.clear();
  cacheOrder.length = 0;
}

// API call handler (to be set by consumer)
type ApiCompletionHandler = (
  context: CompletionContext,
) => Promise<CompletionResult[]>;

let apiHandler: ApiCompletionHandler | null = null;

/**
 * Set the API handler for fetching completions.
 */
export function setApiHandler(handler: ApiCompletionHandler): void {
  apiHandler = handler;
}

/**
 * The main completion handler with debouncing and caching.
 */
async function handleCompletion(
  context: CompletionContext,
): Promise<CompletionResult[]> {
  // Check if completions are enabled
  if (!isEnabled()) {
    return [];
  }

  // Check cache first
  const cacheKey = getCacheKey(context);
  const cached = getFromCache(cacheKey);
  if (cached) {
    return cached;
  }

  // Debounce - return empty and schedule actual request
  return new Promise((resolve) => {
    // Cancel previous debounce
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    const requestId = ++lastRequestId;

    debounceTimer = setTimeout(async () => {
      // Check if this request is still the latest
      if (requestId !== lastRequestId) {
        resolve([]);
        return;
      }

      if (!apiHandler) {
        resolve([]);
        return;
      }

      try {
        const results = await apiHandler(context);

        // Cache results
        if (results.length > 0) {
          addToCache(cacheKey, results);
        }

        // Only return if still the latest request
        if (requestId === lastRequestId) {
          resolve(results);
        } else {
          resolve([]);
        }
      } catch (error) {
        console.error("Completion API error:", error);
        resolve([]);
      }
    }, debounceMs());
  });
}

/**
 * Initialize the completion service.
 * Call this after Monaco is initialized.
 */
export function initCompletionService(): void {
  setCompletionHandler(handleCompletion);
}

/**
 * Enable or disable completions.
 */
export function setCompletionsEnabled(enabled: boolean): void {
  setIsEnabled(enabled);
}

/**
 * Check if completions are enabled.
 */
export function isCompletionsEnabled(): boolean {
  return isEnabled();
}

/**
 * Set the debounce delay in milliseconds.
 */
export function setDebounceDelay(ms: number): void {
  setDebounceMs(Math.max(0, ms));
}

/**
 * Get the current debounce delay.
 */
export function getDebounceDelay(): number {
  return debounceMs();
}

export { isEnabled, debounceMs };
