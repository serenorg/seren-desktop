// ABOUTME: Sign-in form component for user authentication.
// ABOUTME: Handles email/password login with validation and error display.

import { Component, createSignal } from "solid-js";
import { login } from "@/services/auth";
import "./SignIn.css";

interface SignInProps {
  onSuccess: () => void;
}

export const SignIn: Component<SignInProps> = (props) => {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");

    if (!email().trim()) {
      setError("Email is required");
      return;
    }

    if (!password()) {
      setError("Password is required");
      return;
    }

    setIsLoading(true);
    try {
      await login(email(), password());
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

        <form class="signin-form" onSubmit={handleSubmit}>
          <div class="signin-field">
            <label for="email">Email</label>
            <input
              id="email"
              type="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              placeholder="you@example.com"
              disabled={isLoading()}
            />
          </div>

          <div class="signin-field">
            <label for="password">Password</label>
            <input
              id="password"
              type="password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              placeholder="Your password"
              autocomplete="off"
              disabled={isLoading()}
            />
          </div>

          <button
            type="submit"
            class="signin-submit"
            disabled={isLoading()}
          >
            {isLoading() ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
};
