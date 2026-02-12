// ABOUTME: MCP OAuth dialog component for authenticating with mcp.serendb.com.
// ABOUTME: Uses browser-based OAuth with loopback server for reliable authentication flow.

import { createEffect, createSignal, Show } from "solid-js";
import { clearOAuthState, startOAuthBrowserFlow } from "@/services/mcp-oauth";

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
      <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]">
        <div class="bg-surface-1 border border-border rounded-xl w-[400px] max-w-[90vw] shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          <div class="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 class="m-0 text-lg font-semibold text-foreground">
              Connect to Seren MCP
            </h2>
            <button
              type="button"
              class="bg-transparent border-none text-muted-foreground text-2xl cursor-pointer p-0 leading-none transition-colors duration-200 hover:text-foreground"
              onClick={handleCancel}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div class="px-5 py-8 min-h-[150px] flex items-center justify-center">
            <Show when={status() === "loading"}>
              <div class="text-center">
                <div class="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
                <p class="my-2 text-foreground">Preparing authorization...</p>
              </div>
            </Show>

            <Show when={status() === "authorizing"}>
              <div class="text-center">
                <div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl mx-auto mb-4">
                  →
                </div>
                <p class="my-2 text-foreground">
                  Complete authorization in your browser
                </p>
                <p class="text-sm text-muted-foreground">
                  Your default browser has opened. Sign in there to continue.
                </p>
              </div>
            </Show>

            <Show when={status() === "exchanging"}>
              <div class="text-center">
                <div class="w-10 h-10 border-[3px] border-border border-t-primary rounded-full animate-spin mx-auto mb-4" />
                <p class="my-2 text-foreground">Completing authorization...</p>
              </div>
            </Show>

            <Show when={status() === "success"}>
              <div class="text-center">
                <div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl mx-auto mb-4 bg-[rgba(34,197,94,0.12)] text-success">
                  ✓
                </div>
                <p class="my-2 text-foreground">Connected to Seren MCP!</p>
              </div>
            </Show>

            <Show when={status() === "error"}>
              <div class="text-center">
                <div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl mx-auto mb-4 bg-[rgba(239,68,68,0.12)] text-destructive">
                  !
                </div>
                <p class="my-2 text-foreground">Authorization failed</p>
                <p class="text-sm text-destructive max-w-[300px] break-words">
                  {errorMessage()}
                </p>
                <button
                  type="button"
                  class="mt-4 px-4 py-2 bg-primary text-white border-none rounded-md cursor-pointer text-sm transition-colors duration-200 hover:opacity-90"
                  onClick={startAuth}
                >
                  Try Again
                </button>
              </div>
            </Show>
          </div>

          <div class="px-5 py-4 border-t border-border flex justify-end">
            <button
              type="button"
              class="px-4 py-2 bg-transparent text-muted-foreground border border-border rounded-md cursor-pointer text-sm transition-all duration-200 hover:text-foreground hover:border-muted-foreground"
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
