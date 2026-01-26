// ABOUTME: Store for managing AI autocomplete state across the application.
// ABOUTME: Tracks autocomplete status (active/loading/disabled/error) and error messages.

import { createStore } from "solid-js/store";
import type { AutocompleteState } from "@/components/common/AutocompleteStatus";

interface AutocompleteStore {
  state: AutocompleteState;
  errorMessage: string | null;
  isEnabled: boolean;
}

const [store, setStore] = createStore<AutocompleteStore>({
  state: "disabled",
  errorMessage: null,
  isEnabled: false,
});

/**
 * Enable autocomplete and set state to active.
 */
function enable(): void {
  setStore({
    state: "active",
    isEnabled: true,
    errorMessage: null,
  });
}

/**
 * Disable autocomplete.
 */
function disable(): void {
  setStore({
    state: "disabled",
    isEnabled: false,
    errorMessage: null,
  });
}

/**
 * Toggle autocomplete on/off.
 */
function toggle(): void {
  if (store.isEnabled) {
    disable();
  } else {
    enable();
  }
}

/**
 * Set autocomplete to loading state.
 */
function setLoading(): void {
  setStore({ state: "loading" });
}

/**
 * Set autocomplete to active state (after loading completes).
 */
function setActive(): void {
  setStore({ state: "active", errorMessage: null });
}

/**
 * Set autocomplete to error state.
 */
function setError(message: string): void {
  setStore({
    state: "error",
    errorMessage: message,
  });
}

/**
 * Clear error and return to previous state.
 */
function clearError(): void {
  setStore({
    state: store.isEnabled ? "active" : "disabled",
    errorMessage: null,
  });
}

export const autocompleteStore = {
  get state() {
    return store.state;
  },
  get errorMessage() {
    return store.errorMessage;
  },
  get isEnabled() {
    return store.isEnabled;
  },
  enable,
  disable,
  toggle,
  setLoading,
  setActive,
  setError,
  clearError,
};
