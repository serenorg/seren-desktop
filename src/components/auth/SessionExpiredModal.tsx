// ABOUTME: Layout-level blocking modal that fires on mid-session sign-in requests.
// ABOUTME: Subscribes to authStore.signInModalRequested and renders the SignIn form.

import { type Component, Show } from "solid-js";
import { authStore, dismissSignInModal } from "@/stores/auth.store";
import { SignIn } from "./SignIn";

/**
 * Blocking sign-in modal for mid-flow session expiry, refresh-token failure,
 * and the `/login` slash command. Distinct from ChatContent's local sign-in
 * gate (which fires on send attempts) and from the passive titlebar Sign In
 * button (which is always-on whenever the user is unauthenticated).
 *
 * Mounts once at the layout root so it works in every UI mode (agent thread,
 * chat thread, settings panel). See #1661.
 */
export const SessionExpiredModal: Component = () => {
  const handleSuccess = () => {
    dismissSignInModal();
  };

  const handleDismiss = () => {
    // Honest dismiss — the user explicitly chose to ignore the modal. The
    // titlebar Sign In button stays as the lower-friction surface; the next
    // mid-flow event (refresh failure, auto-compact skip) will re-raise.
    dismissSignInModal();
  };

  return (
    <Show when={authStore.signInModalRequested}>
      <div
        class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-expired-modal-title"
      >
        <div class="relative w-full max-w-md mx-4 bg-surface-0 border border-surface-3 rounded-lg shadow-2xl">
          <div class="px-6 py-5 border-b border-surface-2">
            <h2
              id="session-expired-modal-title"
              class="m-0 text-lg font-semibold text-foreground"
            >
              Sign in to continue
            </h2>
            <p class="mt-2 mb-0 text-sm text-muted-foreground leading-normal">
              Your Seren session has expired. Sign in to keep going — your
              current conversation is preserved.
            </p>
          </div>
          <div class="px-6 py-5">
            <SignIn onSuccess={handleSuccess} />
          </div>
          <div class="px-6 py-3 border-t border-surface-2 flex justify-end">
            <button
              type="button"
              class="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-transparent border-none cursor-pointer"
              onClick={handleDismiss}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};
