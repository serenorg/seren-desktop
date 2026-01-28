// ABOUTME: Sign-in form component for user authentication.
// ABOUTME: Handles email/password login.

import { type Component, createSignal, Show } from "solid-js";
import { openExternalLink } from "@/lib/external-link";
import { login } from "@/services/auth";

type LoginPhase = "credentials" | "signing-in" | "completing";

interface SignInProps {
  onSuccess: () => void;
}

export const SignIn: Component<SignInProps> = (props) => {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [phase, setPhase] = createSignal<LoginPhase>("credentials");

  const isLoading = () => phase() !== "credentials";

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

    // Phase 1: Sign in to SerenDB
    setPhase("signing-in");
    try {
      await login(email(), password());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setPhase("credentials");
      return;
    }

    // Phase 2: Complete
    setPhase("completing");
    props.onSuccess();
  };

  const getButtonText = () => {
    switch (phase()) {
      case "signing-in":
        return "Signing in...";
      case "completing":
        return "Completing...";
      default:
        return "Sign In";
    }
  };

  return (
    <div class="flex items-center justify-center p-5 w-full">
      <div class="w-full max-w-[360px] p-8 bg-[rgba(30,41,59,0.8)] rounded-xl border border-[rgba(148,163,184,0.15)] shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
        <h1 class="text-[22px] font-semibold text-white text-center mb-6">
          Sign in to Seren
        </h1>

        <Show when={error()}>
          <div class="mb-5 p-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg text-[#f87171] text-[13px]">
            {error()}
          </div>
        </Show>

        <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
          <div class="flex flex-col gap-2">
            <label for="email" class="text-[13px] font-medium text-[#94a3b8]">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              placeholder="you@example.com"
              disabled={isLoading()}
              class="w-full px-4 py-3 bg-[rgba(15,23,42,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg text-[14px] text-white placeholder:text-[#64748b] outline-none transition-colors duration-150 focus:border-[#6366f1] disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          <div class="flex flex-col gap-2">
            <label
              for="password"
              class="text-[13px] font-medium text-[#94a3b8]"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              placeholder="Your password"
              autocomplete="off"
              disabled={isLoading()}
              class="w-full px-4 py-3 bg-[rgba(15,23,42,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg text-[14px] text-white placeholder:text-[#64748b] outline-none transition-colors duration-150 focus:border-[#6366f1] disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              type="button"
              class="self-end mt-1 bg-transparent border-none p-0 text-[12px] text-[#818cf8] cursor-pointer hover:underline"
              onClick={() =>
                openExternalLink("https://console.serendb.com/forgot-password")
              }
            >
              Forgot password?
            </button>
          </div>

          <button
            type="submit"
            class="w-full py-3 mt-2 bg-[#6366f1] border-none rounded-lg text-[14px] font-semibold text-white cursor-pointer transition-all duration-150 hover:bg-[#4f46e5] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            disabled={isLoading()}
          >
            {isLoading() ? (
              <>
                <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {getButtonText()}
              </>
            ) : (
              "Sign In"
            )}
          </button>
        </form>

        <p class="mt-6 text-center text-[13px] text-[#64748b]">
          Don't have an account?{" "}
          <button
            type="button"
            class="bg-transparent border-none p-0 text-[#818cf8] cursor-pointer hover:underline"
            onClick={() =>
              openExternalLink("https://console.serendb.com/signup")
            }
          >
            Sign up for Seren
          </button>
        </p>
      </div>
    </div>
  );
};
