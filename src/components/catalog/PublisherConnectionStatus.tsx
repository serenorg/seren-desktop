// ABOUTME: Publisher OAuth connection status component.
// ABOUTME: Shows Connect/Disconnect buttons for OAuth-enabled publishers.

import { createSignal, onMount, Show } from "solid-js";
import {
  connectPublisher,
  disconnectPublisher,
  isPublisherConnected,
} from "@/services/publisher-oauth";
import "./PublisherConnectionStatus.css";

interface Props {
  publisherSlug: string;
  oauthProviderSlug?: string; // e.g., "github" for Git MCP publisher
  requiresOAuth?: boolean;
}

export function PublisherConnectionStatus(props: Props) {
  const [isConnected, setIsConnected] = createSignal(false);
  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const checkConnection = async () => {
    if (!props.oauthProviderSlug) {
      setIsLoading(false);
      return;
    }

    try {
      const connected = await isPublisherConnected(props.oauthProviderSlug);
      setIsConnected(connected);
    } catch (err) {
      console.error(
        "[PublisherConnectionStatus] Error checking connection:",
        err,
      );
      setError("Failed to check connection status");
    } finally {
      setIsLoading(false);
    }
  };

  onMount(() => {
    checkConnection();
  });

  const handleConnect = async () => {
    if (!props.oauthProviderSlug) return;

    setIsLoading(true);
    setError(null);

    try {
      await connectPublisher(props.oauthProviderSlug);
      // Connection status will be updated after OAuth callback
      // For now, just show loading state
    } catch (err) {
      console.error("[PublisherConnectionStatus] Connection failed:", err);
      setError("Failed to connect. Please try again.");
      setIsLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!props.oauthProviderSlug) return;

    setIsLoading(true);
    setError(null);

    try {
      await disconnectPublisher(props.oauthProviderSlug);
      setIsConnected(false);
    } catch (err) {
      console.error("[PublisherConnectionStatus] Disconnection failed:", err);
      setError("Failed to disconnect. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  // Don't render if OAuth is not required
  if (!props.requiresOAuth || !props.oauthProviderSlug) {
    return null;
  }

  return (
    <div class="publisher-connection-status">
      <Show when={error()}>
        <div class="connection-error">{error()}</div>
      </Show>

      <Show when={isConnected()}>
        <div class="connection-status connected">
          <span class="status-indicator" />
          <span class="status-text">Connected</span>
          <button
            class="btn-disconnect"
            onClick={handleDisconnect}
            disabled={isLoading()}
          >
            {isLoading() ? "Disconnecting..." : "Disconnect"}
          </button>
        </div>
      </Show>

      <Show when={!isConnected() && !isLoading()}>
        <div class="connection-status disconnected">
          <span class="status-indicator" />
          <span class="status-text">Not connected</span>
          <button
            class="btn-connect"
            onClick={handleConnect}
            disabled={isLoading()}
          >
            {isLoading() ? "Connecting..." : "Connect"}
          </button>
        </div>
      </Show>

      <Show when={isLoading() && !isConnected()}>
        <div class="connection-status loading">
          <div class="loading-spinner small" />
          <span class="status-text">Checking connection...</span>
        </div>
      </Show>
    </div>
  );
}
