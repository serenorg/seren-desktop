// ABOUTME: Shared helpers for desktop OAuth callback URLs.
// ABOUTME: Keeps app-wide loopback OAuth in sync with the active Tauri server port.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-bridge";

const DEFAULT_DESKTOP_OAUTH_PORT = 8787;

export interface ValidationRuntimeInfo {
  isValidation: boolean;
  controlEnabled: boolean;
  identifier: string;
  oauthCallbackPort: number;
  processId: number;
}

export async function getValidationRuntimeInfo(): Promise<ValidationRuntimeInfo> {
  if (!isTauriRuntime()) {
    return {
      isValidation: false,
      controlEnabled: false,
      identifier: "browser",
      oauthCallbackPort: DEFAULT_DESKTOP_OAUTH_PORT,
      processId: 0,
    };
  }

  try {
    const info = await invoke<Partial<ValidationRuntimeInfo>>(
      "get_validation_runtime_info",
    );
    return {
      isValidation: info.isValidation === true,
      controlEnabled: info.controlEnabled === true,
      identifier:
        typeof info.identifier === "string" ? info.identifier : "unknown",
      oauthCallbackPort:
        typeof info.oauthCallbackPort === "number"
          ? info.oauthCallbackPort
          : DEFAULT_DESKTOP_OAUTH_PORT,
      processId: typeof info.processId === "number" ? info.processId : 0,
    };
  } catch {
    return {
      isValidation: false,
      controlEnabled: false,
      identifier: "unknown",
      oauthCallbackPort: DEFAULT_DESKTOP_OAUTH_PORT,
      processId: 0,
    };
  }
}

export async function getDesktopOAuthCallbackUrl(
  path: "/auth/callback" | "/oauth/callback",
): Promise<string> {
  if (!isTauriRuntime()) {
    return `${window.location.origin}${path}`;
  }

  try {
    return await invoke<string>("get_desktop_oauth_callback_url", { path });
  } catch {
    return `http://127.0.0.1:${DEFAULT_DESKTOP_OAUTH_PORT}${path}`;
  }
}
