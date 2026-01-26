// ABOUTME: Settings UI for configuring LLM provider credentials.
// ABOUTME: Supports API keys and OAuth sign-in for Anthropic, OpenAI, and Gemini.

import { createSignal, For, Show, onMount, onCleanup, type Component } from "solid-js";
import { providerStore } from "@/stores/provider.store";
import {
  PROVIDER_CONFIGS,
  CONFIGURABLE_PROVIDERS,
  supportsOAuth,
  supportsApiKey,
  type ProviderId,
} from "@/lib/providers/types";
import { validateProviderKey } from "@/lib/providers";
import { startOAuthFlow, handleOAuthCallback, cancelOAuthFlow, getPendingOAuthProvider } from "@/services/oauth";
import { listenForOAuthCallback, storeOAuthCredentials } from "@/lib/tauri-bridge";
import "./ProviderSettings.css";

export const ProviderSettings: Component = () => {
  const [selectedProvider, setSelectedProvider] = createSignal<ProviderId | null>(null);
  const [apiKeyInput, setApiKeyInput] = createSignal("");
  const [showKey, setShowKey] = createSignal(false);
  const [oauthInProgress, setOauthInProgress] = createSignal<ProviderId | null>(null);
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
        await storeOAuthCredentials(pendingProvider, JSON.stringify(credentials));

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
      setOauthError(err instanceof Error ? err.message : "Failed to start OAuth");
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
      validateProviderKey
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
      `Remove ${config.name} configuration? Your credentials will be deleted.`
    );
    if (confirmRemove) {
      await providerStore.removeProvider(providerId);
    }
  };

  const handleActivateProvider = (providerId: ProviderId) => {
    providerStore.setActiveProvider(providerId);
  };

  const unconfiguredProviders = () =>
    CONFIGURABLE_PROVIDERS.filter(p => !providerStore.configuredProviders.includes(p));

  return (
    <section class="settings-section">
      <h3>AI Providers</h3>
      <p class="settings-description">
        Connect your own account to use models directly from Anthropic, OpenAI, or Google.
        Seren Models is always available with your SerenBucks balance.
      </p>

      {/* Configured Providers List */}
      <div class="provider-list">
        <For each={providerStore.configuredProviders}>
          {(providerId) => {
            const config = PROVIDER_CONFIGS[providerId];
            const authType = providerStore.getAuthType(providerId);
            return (
              <div class="provider-item">
                <div class="provider-info">
                  <div class="provider-header">
                    <span class="provider-name">{config.name}</span>
                    <Show when={providerId === "seren"}>
                      <span class="provider-badge default">Default</span>
                    </Show>
                    <Show when={providerId === providerStore.activeProvider}>
                      <span class="provider-badge active">Active</span>
                    </Show>
                    <Show when={authType === "oauth"}>
                      <span class="provider-badge oauth">Signed In</span>
                    </Show>
                  </div>
                  <span class="provider-description">{config.description}</span>
                </div>
                <div class="provider-actions">
                  <Show when={providerId !== providerStore.activeProvider}>
                    <button
                      type="button"
                      class="provider-activate"
                      onClick={() => handleActivateProvider(providerId)}
                    >
                      Use
                    </button>
                  </Show>
                  <Show when={providerId !== "seren"}>
                    <button
                      type="button"
                      class="provider-remove"
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
          <div class="oauth-error">{oauthError()}</div>
        </Show>

        {/* Quick OAuth Sign-in Buttons */}
        <div class="oauth-buttons">
          <For each={unconfiguredProviders().filter(p => supportsOAuth(p))}>
            {(providerId) => {
              const config = PROVIDER_CONFIGS[providerId];
              const isInProgress = () => oauthInProgress() === providerId;
              return (
                <button
                  type="button"
                  class={`oauth-signin-btn oauth-${providerId}`}
                  onClick={() => handleOAuthSignIn(providerId)}
                  disabled={isInProgress() || !config.oauth?.clientId}
                >
                  <Show when={isInProgress()} fallback={`Sign in with ${config.name}`}>
                    Connecting...
                  </Show>
                </button>
              );
            }}
          </For>
        </div>

        <div class="auth-divider">
          <span>or use API key</span>
        </div>

        <div class="add-provider-form">
          <div class="settings-group">
            <label class="settings-label">
              <span class="label-text">Provider</span>
              <span class="label-hint">Select a provider to configure with API key</span>
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
              <For each={unconfiguredProviders().filter(p => supportsApiKey(p))}>
                {(providerId) => (
                  <option value={providerId}>{PROVIDER_CONFIGS[providerId].name}</option>
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
                        <a href={config().docsUrl} target="_blank" rel="noopener noreferrer">
                          Get one here
                        </a>
                      </span>
                    </label>
                    <div class="api-key-input-wrapper">
                      <input
                        type={showKey() ? "text" : "password"}
                        class="api-key-input"
                        value={apiKeyInput()}
                        onInput={(e) => {
                          setApiKeyInput(e.currentTarget.value);
                          providerStore.clearValidationError();
                        }}
                        placeholder={config().apiKeyPlaceholder || "Enter API key..."}
                      />
                      <button
                        type="button"
                        class="toggle-visibility"
                        onClick={() => setShowKey(!showKey())}
                        title={showKey() ? "Hide API key" : "Show API key"}
                      >
                        {showKey() ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>

                  <Show when={providerStore.validationError}>
                    <div class="validation-error">{providerStore.validationError}</div>
                  </Show>

                  <button
                    type="button"
                    class="primary add-provider-btn"
                    onClick={handleAddApiKey}
                    disabled={!apiKeyInput().trim() || providerStore.isValidating}
                  >
                    {providerStore.isValidating ? "Validating..." : "Add Provider"}
                  </button>
                </>
              );
            }}
          </Show>
        </div>
      </Show>

      <Show when={unconfiguredProviders().length === 0}>
        <div class="all-providers-configured">
          <span class="check-icon">&#10003;</span>
          <span>All available providers have been configured.</span>
        </div>
      </Show>
    </section>
  );
};

export default ProviderSettings;
