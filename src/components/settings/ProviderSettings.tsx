// ABOUTME: Settings UI for configuring LLM provider credentials.
// ABOUTME: Supports API keys and OAuth sign-in for Anthropic, OpenAI, and Gemini.

import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { validateProviderKey } from "@/lib/providers";
import {
  CONFIGURABLE_PROVIDERS,
  PROVIDER_CONFIGS,
  type ProviderId,
  supportsApiKey,
  supportsOAuth,
} from "@/lib/providers/types";
import {
  listenForOAuthCallback,
  storeOAuthCredentials,
} from "@/lib/tauri-bridge";
import {
  cancelOAuthFlow,
  getPendingOAuthProvider,
  handleOAuthCallback,
  startOAuthFlow,
} from "@/services/oauth";
import { providerStore } from "@/stores/provider.store";

export const ProviderSettings: Component = () => {
  const [selectedProvider, setSelectedProvider] =
    createSignal<ProviderId | null>(null);
  const [apiKeyInput, setApiKeyInput] = createSignal("");
  const [showKey, setShowKey] = createSignal(false);
  const [oauthInProgress, setOauthInProgress] = createSignal<ProviderId | null>(
    null,
  );
  const [oauthError, setOauthError] = createSignal<string | null>(null);

  // Listen for OAuth callbacks
  onMount(async () => {
    const unlisten = await listenForOAuthCallback(async (url) => {
      try {
        const urlObj = new URL(url);
        const code = urlObj.searchParams.get("code");
        const state = urlObj.searchParams.get("state");
        const error = urlObj.searchParams.get("error");

        if (error) {
          setOauthError(`OAuth error: ${error}`);
          setOauthInProgress(null);
          return;
        }

        if (!code || !state) {
          setOauthError("Invalid OAuth callback - missing code or state");
          setOauthInProgress(null);
          return;
        }

        const pendingProvider = getPendingOAuthProvider();
        if (!pendingProvider) {
          setOauthError("No pending OAuth flow");
          return;
        }

        const credentials = await handleOAuthCallback(code, state);

        // Store credentials
        await storeOAuthCredentials(
          pendingProvider,
          JSON.stringify(credentials),
        );

        // Update provider store
        await providerStore.configureOAuthProvider(pendingProvider);

        setOauthInProgress(null);
        setOauthError(null);
      } catch (err) {
        setOauthError(err instanceof Error ? err.message : "OAuth failed");
        setOauthInProgress(null);
      }
    });

    onCleanup(() => {
      unlisten();
      cancelOAuthFlow();
    });
  });

  const handleOAuthSignIn = async (providerId: ProviderId) => {
    setOauthError(null);
    setOauthInProgress(providerId);

    try {
      await startOAuthFlow(providerId);
      // Flow continues in callback listener
    } catch (err) {
      setOauthError(
        err instanceof Error ? err.message : "Failed to start OAuth",
      );
      setOauthInProgress(null);
    }
  };

  const handleAddApiKey = async () => {
    const provider = selectedProvider();
    const apiKey = apiKeyInput().trim();

    if (!provider || !apiKey) return;

    const success = await providerStore.configureProvider(
      provider,
      apiKey,
      validateProviderKey,
    );

    if (success) {
      setSelectedProvider(null);
      setApiKeyInput("");
      setShowKey(false);
    }
  };

  const handleRemoveProvider = async (providerId: ProviderId) => {
    const config = PROVIDER_CONFIGS[providerId];
    const confirmRemove = window.confirm(
      `Remove ${config.name} configuration? Your credentials will be deleted.`,
    );
    if (confirmRemove) {
      await providerStore.removeProvider(providerId);
    }
  };

  const handleActivateProvider = (providerId: ProviderId) => {
    providerStore.setActiveProvider(providerId);
  };

  const unconfiguredProviders = () =>
    CONFIGURABLE_PROVIDERS.filter(
      (p) => !providerStore.configuredProviders.includes(p),
    );

  return (
    <section class="settings-section">
      <h3>AI Providers</h3>
      <p class="settings-description">
        Connect your own account to use models directly from Anthropic, OpenAI,
        or Google. Seren Models is always available with your SerenBucks
        balance.
      </p>

      {/* Configured Providers List */}
      <div class="flex flex-col gap-2 mb-6">
        <For each={providerStore.configuredProviders}>
          {(providerId) => {
            const config = PROVIDER_CONFIGS[providerId];
            const authType = providerStore.getAuthType(providerId);
            return (
              <div class="flex items-center justify-between px-4 py-3 bg-[rgba(30,41,59,0.5)] border border-[rgba(148,163,184,0.15)] rounded-lg transition-[border-color] duration-150 hover:border-[rgba(148,163,184,0.25)]">
                <div class="flex flex-col gap-1 min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-foreground">{config.name}</span>
                    <Show when={providerId === "seren"}>
                      <span class="text-[11px] px-1.5 py-0.5 rounded font-medium bg-[rgba(99,102,241,0.2)] text-[#818cf8]">Default</span>
                    </Show>
                    <Show when={providerId === providerStore.activeProvider}>
                      <span class="text-[11px] px-1.5 py-0.5 rounded font-medium bg-[rgba(34,197,94,0.2)] text-[#4ade80]">Active</span>
                    </Show>
                    <Show when={authType === "oauth"}>
                      <span class="text-[11px] px-1.5 py-0.5 rounded font-medium bg-[rgba(59,130,246,0.2)] text-[#60a5fa]">Signed In</span>
                    </Show>
                  </div>
                  <span class="text-xs text-muted overflow-hidden text-ellipsis whitespace-nowrap">{config.description}</span>
                </div>
                <div class="flex items-center gap-2 ml-4">
                  <Show when={providerId !== providerStore.activeProvider}>
                    <button
                      type="button"
                      class="px-3 py-1.5 bg-transparent border border-accent text-accent rounded text-[13px] cursor-pointer transition-all duration-150 hover:bg-accent hover:text-white"
                      onClick={() => handleActivateProvider(providerId)}
                    >
                      Use
                    </button>
                  </Show>
                  <Show when={providerId !== "seren"}>
                    <button
                      type="button"
                      class="w-7 h-7 flex items-center justify-center bg-transparent border border-[rgba(148,163,184,0.25)] text-muted rounded text-base cursor-pointer transition-all duration-150 hover:bg-[rgba(239,68,68,0.1)] hover:border-[rgba(239,68,68,0.5)] hover:text-[#ef4444]"
                      onClick={() => handleRemoveProvider(providerId)}
                      title="Remove provider"
                    >
                      x
                    </button>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>

      {/* Add New Provider */}
      <Show when={unconfiguredProviders().length > 0}>
        <h4>Add Provider</h4>

        {/* OAuth Error Display */}
        <Show when={oauthError()}>
          <div class="mt-3 px-3.5 py-2.5 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-md text-[#ef4444] text-[13px]">{oauthError()}</div>
        </Show>

        {/* Quick OAuth Sign-in Buttons */}
        <div class="flex flex-col gap-2.5 mt-3">
          <For each={unconfiguredProviders().filter((p) => supportsOAuth(p))}>
            {(providerId) => {
              const config = PROVIDER_CONFIGS[providerId];
              const isInProgress = () => oauthInProgress() === providerId;
              return (
                <button
                  type="button"
                  class={`flex items-center justify-center gap-2.5 px-5 py-3 border rounded-lg text-sm font-medium cursor-pointer transition-all duration-150 hover:not-disabled:-translate-y-px active:not-disabled:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed ${
                    providerId === "openai"
                      ? "bg-[#10a37f] border-[#10a37f] text-white hover:not-disabled:bg-[#0d8a6a] hover:not-disabled:border-[#0d8a6a]"
                      : providerId === "gemini"
                        ? "bg-gradient-to-br from-[#4285f4] via-[#34a853] to-[#fbbc05] border-transparent text-white hover:not-disabled:from-[#3b78e7] hover:not-disabled:via-[#2d9649] hover:not-disabled:to-[#e5ab04]"
                        : "bg-[rgba(30,41,59,0.5)] border-[rgba(148,163,184,0.25)] text-foreground"
                  }`}
                  onClick={() => handleOAuthSignIn(providerId)}
                  disabled={isInProgress() || !config.oauth?.clientId}
                >
                  <Show
                    when={isInProgress()}
                    fallback={`Sign in with ${config.name}`}
                  >
                    Connecting...
                  </Show>
                </button>
              );
            }}
          </For>
        </div>

        <div class="flex items-center my-5 gap-4 before:content-[''] before:flex-1 before:h-px before:bg-[rgba(148,163,184,0.25)] after:content-[''] after:flex-1 after:h-px after:bg-[rgba(148,163,184,0.25)]">
          <span class="text-muted text-xs uppercase tracking-[0.5px]">or use API key</span>
        </div>

        <div class="mt-4">
          <div class="settings-group">
            <label class="settings-label">
              <span class="label-text">Provider</span>
              <span class="label-hint">
                Select a provider to configure with API key
              </span>
            </label>
            <select
              aria-label="Select provider"
              value={selectedProvider() || ""}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setSelectedProvider(value ? (value as ProviderId) : null);
                setApiKeyInput("");
                providerStore.clearValidationError();
              }}
            >
              <option value="">Select provider...</option>
              <For
                each={unconfiguredProviders().filter((p) => supportsApiKey(p))}
              >
                {(providerId) => (
                  <option value={providerId}>
                    {PROVIDER_CONFIGS[providerId].name}
                  </option>
                )}
              </For>
            </select>
          </div>

          <Show when={selectedProvider()}>
            {(provider) => {
              const config = () => PROVIDER_CONFIGS[provider()];
              return (
                <>
                  <div class="settings-group">
                    <label class="settings-label">
                      <span class="label-text">API Key</span>
                      <span class="label-hint">
                        Your {config().name} API key.{" "}
                        <a
                          href={config().docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-accent no-underline hover:underline"
                        >
                          Get one here
                        </a>
                      </span>
                    </label>
                    <div class="flex gap-2">
                      <input
                        type={showKey() ? "text" : "password"}
                        class="flex-1 px-3 py-2 bg-surface border border-[rgba(148,163,184,0.25)] rounded text-foreground text-[13px] font-mono focus:outline-none focus:border-accent placeholder:text-muted placeholder:font-sans"
                        value={apiKeyInput()}
                        onInput={(e) => {
                          setApiKeyInput(e.currentTarget.value);
                          providerStore.clearValidationError();
                        }}
                        placeholder={
                          config().apiKeyPlaceholder || "Enter API key..."
                        }
                      />
                      <button
                        type="button"
                        class="px-3 py-2 bg-[rgba(30,41,59,0.5)] border border-[rgba(148,163,184,0.25)] rounded text-muted text-[13px] cursor-pointer transition-colors duration-150 whitespace-nowrap hover:bg-[rgba(148,163,184,0.15)]"
                        onClick={() => setShowKey(!showKey())}
                        title={showKey() ? "Hide API key" : "Show API key"}
                      >
                        {showKey() ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>

                  <Show when={providerStore.validationError}>
                    <div class="mt-2 px-3 py-2 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded text-[#ef4444] text-[13px]">
                      {providerStore.validationError}
                    </div>
                  </Show>

                  <button
                    type="button"
                    class="mt-4 px-5 py-2.5 bg-accent border-none rounded-md text-white text-sm font-medium cursor-pointer transition-all duration-150 hover:not-disabled:bg-[#4f46e5] disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleAddApiKey}
                    disabled={
                      !apiKeyInput().trim() || providerStore.isValidating
                    }
                  >
                    {providerStore.isValidating
                      ? "Validating..."
                      : "Add Provider"}
                  </button>
                </>
              );
            }}
          </Show>
        </div>
      </Show>

      <Show when={unconfiguredProviders().length === 0}>
        <div class="flex items-center gap-2 px-4 py-3 bg-[rgba(34,197,94,0.1)] border border-[rgba(34,197,94,0.3)] rounded-lg text-[#4ade80] text-sm mt-4">
          <span class="text-base">&#10003;</span>
          <span>All available providers have been configured.</span>
        </div>
      </Show>
    </section>
  );
};

export default ProviderSettings;
