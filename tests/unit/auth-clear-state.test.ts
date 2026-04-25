// ABOUTME: Critical tests for #1661 — clearAuthState / requestSignInModal separation.
// ABOUTME: Locks the rule that auth state and the sign-in modal are independent concerns.

import { describe, expect, it } from "vitest";

import {
  authStore,
  clearAuthState,
  dismissSignInModal,
  requestSignInModal,
} from "@/stores/auth.store";

describe("clearAuthState (#1661)", () => {
  it("flips isAuthenticated, user, privateChatPolicy and does NOT touch the modal signal", () => {
    requestSignInModal(); // pre-set the modal flag so we can prove the separation
    expect(authStore.signInModalRequested).toBe(true);

    clearAuthState();

    expect(authStore.isAuthenticated).toBe(false);
    expect(authStore.user).toBeNull();
    expect(authStore.privateChatPolicy).toBeNull();
    // The whole point of the rename: clearing auth state must not also flip
    // the modal signal. Pre-#1661 promptLogin conflated the two; that conflation
    // is what made the auto-compact call site dead code.
    expect(authStore.signInModalRequested).toBe(true);

    dismissSignInModal();
  });
});

describe("requestSignInModal / dismissSignInModal (#1661)", () => {
  it("requestSignInModal flips the signal and does NOT touch auth state", () => {
    // Treat the test environment as if the user were authenticated. We can't
    // setAuthenticated() without provisioning, so just confirm the modal
    // signal moves independently of whatever auth state is.
    const beforeAuth = authStore.isAuthenticated;
    const beforeUser = authStore.user;
    const beforePolicy = authStore.privateChatPolicy;

    requestSignInModal();

    expect(authStore.signInModalRequested).toBe(true);
    expect(authStore.isAuthenticated).toBe(beforeAuth);
    expect(authStore.user).toBe(beforeUser);
    expect(authStore.privateChatPolicy).toBe(beforePolicy);

    dismissSignInModal();
  });

  it("dismissSignInModal clears the signal and does NOT touch auth state", () => {
    requestSignInModal();
    const beforeAuth = authStore.isAuthenticated;

    dismissSignInModal();

    expect(authStore.signInModalRequested).toBe(false);
    expect(authStore.isAuthenticated).toBe(beforeAuth);
  });
});

