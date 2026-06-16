// ABOUTME: Sign-in form component for user authentication.
// ABOUTME: Handles email/password and social provider login.

import { type Component, createSignal, For, Show } from "solid-js";
import githubLogo from "@/assets/oauth-logos/github.svg";
import googleLogo from "@/assets/oauth-logos/google.svg";
import microsoftLogo from "@/assets/oauth-logos/microsoft.svg";
import { openExternalLink } from "@/lib/external-link";
import { login } from "@/services/auth";
import {
  type SocialLoginProvider,
  startSocialLogin,
} from "@/services/social-login";

type OAuthLoginPhase = `oauth-${SocialLoginProvider}`;
type LoginPhase = "credentials" | "signing-in" | "completing" | OAuthLoginPhase;

const SOCIAL_PROVIDERS: Array<{
  id: SocialLoginProvider;
  label: string;
  logo: string;
}> = [
  { id: "github", label: "GitHub", logo: githubLogo },
  { id: "google", label: "Google", logo: googleLogo },
  { id: "microsoft", label: "Microsoft", logo: microsoftLogo },
];

interface SignInProps {
  onSuccess: () => Promise<void> | void;
}

// Tauri `invoke` rejects with the raw `Err` string payload, not an `Error`, so
// surface string rejections too instead of collapsing every failure into the
// generic fallback. Keeping the real cause visible is what makes social/login
// failures diagnosable.
function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

export const SignIn: Component<SignInProps> = (props) => {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [phase, setPhase] = createSignal<LoginPhase>("credentials");

  const isLoading = () => phase() !== "credentials";

  const oauthPhaseFor = (provider: SocialLoginProvider): OAuthLoginPhase =>
    `oauth-${provider}`;

  const completeSignIn = async () => {
    setPhase("completing");
    try {
      await props.onSuccess();
    } catch (err) {
      setError(authErrorMessage(err, "Sign-in setup failed"));
      setPhase("credentials");
    }
  };

  const handleSocialLogin = async (provider: SocialLoginProvider) => {
    setError("");
    setPhase(oauthPhaseFor(provider));

    try {
      await startSocialLogin(provider);
    } catch (err) {
      setError(authErrorMessage(err, "Social sign-in failed"));
      setPhase("credentials");
      return;
    }

    await completeSignIn();
  };

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
      setError(authErrorMessage(err, "Login failed"));
      setPhase("credentials");
      return;
    }

    // Phase 2: Complete
    await completeSignIn();
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
      <div class="w-full max-w-[360px] p-8 bg-surface-1/90 backdrop-blur-sm rounded-xl border border-border shadow-[var(--shadow-lg)]">
        <h1 class="text-[22px] font-semibold text-foreground text-center mb-6">
          Sign in to Seren
        </h1>

        <Show when={error()}>
          <div class="mb-5 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-[13px]">
            {error()}
          </div>
        </Show>

        <div class="flex flex-col gap-3">
          <For each={SOCIAL_PROVIDERS}>
            {(provider) => (
              <button
                type="button"
                aria-label={`Sign in with ${provider.label}`}
                class="w-full h-11 px-4 bg-background/70 border border-border rounded-lg text-[14px] font-medium text-foreground cursor-pointer transition-all duration-150 hover:bg-surface-2 hover:border-primary/40 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                disabled={isLoading()}
                onClick={() => {
                  void handleSocialLogin(provider.id);
                }}
              >
                <img src={provider.logo} alt="" class="w-5 h-5 shrink-0" />
                <span>
                  {phase() === oauthPhaseFor(provider.id)
                    ? `Opening ${provider.label}...`
                    : `Sign in with ${provider.label}`}
                </span>
              </button>
            )}
          </For>
        </div>

        <div class="my-6 flex items-center gap-3">
          <div class="h-px flex-1 bg-border" />
          <span class="text-[11px] font-semibold text-muted-foreground">
            OR SIGN IN WITH EMAIL
          </span>
          <div class="h-px flex-1 bg-border" />
        </div>

        <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
          <div class="flex flex-col gap-2">
            <label
              for="email"
              class="text-[13px] font-medium text-muted-foreground"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              placeholder="you@example.com"
              disabled={isLoading()}
              class="w-full px-4 py-3 bg-background/60 border border-border rounded-lg text-[14px] text-foreground placeholder:text-muted-foreground outline-none transition-colors duration-150 focus:border-primary focus:shadow-[var(--input-focus-glow)] disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          <div class="flex flex-col gap-2">
            <label
              for="password"
              class="text-[13px] font-medium text-muted-foreground"
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
              class="w-full px-4 py-3 bg-background/60 border border-border rounded-lg text-[14px] text-foreground placeholder:text-muted-foreground outline-none transition-colors duration-150 focus:border-primary focus:shadow-[var(--input-focus-glow)] disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              type="button"
              class="self-end mt-1 bg-transparent border-none p-0 text-[12px] text-primary/70 cursor-pointer hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isLoading()}
              onClick={() =>
                openExternalLink("https://console.serendb.com/forgot-password")
              }
            >
              Forgot password?
            </button>
          </div>

          <button
            type="submit"
            class="w-full py-3 mt-2 bg-primary border-none rounded-lg text-[14px] font-semibold text-white cursor-pointer transition-all duration-150 hover:bg-primary/85 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            disabled={isLoading()}
          >
            {isLoading() ? (
              <>
                <span class="w-4 h-4 border-2 border-foreground/30 border-t-foreground rounded-full animate-spin" />
                {getButtonText()}
              </>
            ) : (
              "Sign In"
            )}
          </button>
        </form>

        <p class="mt-6 text-center text-[13px] text-muted-foreground">
          Don't have an account?{" "}
          <button
            type="button"
            class="bg-transparent border-none p-0 text-primary cursor-pointer hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isLoading()}
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
