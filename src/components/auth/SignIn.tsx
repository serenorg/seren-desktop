// ABOUTME: Sign-in component for user authentication.
// ABOUTME: Uses OAuth 2.1 with PKCE - opens browser for secure authentication.

import { Component, createSignal } from "solid-js";
import { login } from "@/services/auth";
import { openExternalLink } from "@/lib/external-link";
import "./SignIn.css";

interface SignInProps {
  onSuccess: () => void;
}

export const SignIn: Component<SignInProps> = (props) => {
  const [error, setError] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(false);

  const handleSignIn = async () => {
    setError("");
    setIsLoading(true);

    try {
      await login();
      props.onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div class="signin">
      <div class="signin-card">
        <h1 class="signin-title">Sign in to Seren</h1>

        {error() && <div class="signin-error">{error()}</div>}

        <div class="signin-content">
          {isLoading() ? (
            <div class="signin-waiting">
              <div class="signin-spinner" />
              <p>Waiting for authentication...</p>
              <p class="signin-hint">Complete sign-in in your browser</p>
            </div>
          ) : (
            <>
              <p class="signin-description">
                Click the button below to sign in with your Seren account.
                A browser window will open for secure authentication.
              </p>

              <button
                type="button"
                class="signin-submit"
                onClick={handleSignIn}
              >
                Sign in with Seren
              </button>
            </>
          )}
        </div>

        <p class="signin-signup">
          Don't have an account?{" "}
          <button
            type="button"
            class="signin-link"
            onClick={() => openExternalLink("https://console.serendb.com/signup")}
          >
            Sign up for Seren
          </button>
        </p>
      </div>
    </div>
  );
};
