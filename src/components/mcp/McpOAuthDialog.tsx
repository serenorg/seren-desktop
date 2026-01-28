// ABOUTME: MCP OAuth dialog component for authenticating with mcp.serendb.com.
// ABOUTME: Uses browser-based OAuth with loopback server for reliable authentication flow.

import { createEffect, createSignal, Show } from "solid-js";
import { clearOAuthState, startOAuthBrowserFlow } from "@/services/mcp-oauth";
import "./McpOAuthDialog.css";

interface McpOAuthDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onError: (error: Error) => void;
}

export function McpOAuthDialog(props: McpOAuthDialogProps) {
  const [status, setStatus] = createSignal<
    "idle" | "loading" | "authorizing" | "exchanging" | "success" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  let abortController: AbortController | null = null;

  const startAuth = async () => {
    setStatus("loading");
    setErrorMessage(null);
    abortController = new AbortController();

    try {
      setStatus("authorizing");
      console.log("[McpOAuthDialog] Starting browser-based OAuth flow...");

      // This opens the browser and waits for the callback
      await startOAuthBrowserFlow();

      setStatus("success");
      props.onSuccess();
    } catch (error) {
      // Don't show error if cancelled
      if (abortController?.signal.aborted) {
        return;
      }

      console.error("[McpOAuthDialog] OAuth flow failed:", error);
      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Authentication failed",
      );
      props.onError(
        error instanceof Error ? error : new Error("Authentication failed"),
      );
    }
  };

  const handleCancel = () => {
    abortController?.abort();
    clearOAuthState();
    setStatus("idle");
    props.onClose();
  };

  // Auto-start when dialog opens
  createEffect(() => {
    if (props.isOpen && status() === "idle") {
      startAuth();
    }
    if (!props.isOpen && status() !== "idle") {
      abortController?.abort();
      setStatus("idle");
    }
  });

  return (
    <Show when={props.isOpen}>
      <div class="mcp-oauth-dialog-overlay">
        <div class="mcp-oauth-dialog">
          <div class="mcp-oauth-dialog-header">
            <h2>Connect to Seren MCP</h2>
            <button
              type="button"
              class="mcp-oauth-dialog-close"
              onClick={handleCancel}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div class="mcp-oauth-dialog-content">
            <Show when={status() === "loading"}>
              <div class="mcp-oauth-status">
                <div class="mcp-oauth-spinner" />
                <p>Preparing authorization...</p>
              </div>
            </Show>

            <Show when={status() === "authorizing"}>
              <div class="mcp-oauth-status">
                <div class="mcp-oauth-icon mcp-oauth-icon-info">→</div>
                <p>Complete authorization in your browser</p>
                <p class="mcp-oauth-hint">
                  Your default browser has opened. Sign in there to continue.
                </p>
              </div>
            </Show>

            <Show when={status() === "exchanging"}>
              <div class="mcp-oauth-status">
                <div class="mcp-oauth-spinner" />
                <p>Completing authorization...</p>
              </div>
            </Show>

            <Show when={status() === "success"}>
              <div class="mcp-oauth-status mcp-oauth-success">
                <div class="mcp-oauth-icon">✓</div>
                <p>Connected to Seren MCP!</p>
              </div>
            </Show>

            <Show when={status() === "error"}>
              <div class="mcp-oauth-status mcp-oauth-error">
                <div class="mcp-oauth-icon">!</div>
                <p>Authorization failed</p>
                <p class="mcp-oauth-error-message">{errorMessage()}</p>
                <button
                  type="button"
                  class="mcp-oauth-retry"
                  onClick={startAuth}
                >
                  Try Again
                </button>
              </div>
            </Show>
          </div>

          <div class="mcp-oauth-dialog-footer">
            <button
              type="button"
              class="mcp-oauth-cancel"
              onClick={handleCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
