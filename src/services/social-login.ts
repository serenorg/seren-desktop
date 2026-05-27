// ABOUTME: Native SerenDB social sign-in flow for desktop.
// ABOUTME: Uses PKCE, loopback callback events, and secure token storage.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentUser, listOrganizations } from "@/api";
import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import {
  storeDefaultOrganizationId,
  storeRefreshToken,
  storeToken,
} from "@/lib/tauri-bridge";

export type SocialLoginProvider = "github" | "google" | "microsoft";

export interface SocialLoginResult {
  access_token: string;
  refresh_token: string;
  default_organization_id: string;
  expires_in?: number;
}

interface SocialLoginCallbackPayload {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

interface TokenPayload {
  access_token: string;
  refresh_token: string;
  default_organization_id?: string;
  expires_in?: number;
}

const CLIENT_ID = "seren-desktop";
const REDIRECT_URI = "http://127.0.0.1:8787/auth/callback";
const CODE_VERIFIER_LENGTH = 64;
const STATE_LENGTH = 32;

function generateRandomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues, (value) => chars[value % chars.length]).join(
    "",
  );
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildAuthorizeUrl(
  provider: SocialLoginProvider,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL("/oauth2/authorize", apiBase);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    provider,
  }).toString();
  return url.toString();
}

function getTokenPayload(json: unknown): TokenPayload {
  const record = isRecord(json) && isRecord(json.data) ? json.data : json;
  if (!isRecord(record)) {
    throw new Error("Token exchange response was not an object");
  }

  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new Error("Token exchange response missing tokens");
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    default_organization_id:
      typeof record.default_organization_id === "string"
        ? record.default_organization_id
        : undefined,
    expires_in:
      typeof record.expires_in === "number" ? record.expires_in : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<TokenPayload> {
  const tokenUrl = new URL("/oauth2/token", apiBase).toString();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const response = await appFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail
        ? `Social login token exchange failed: ${detail}`
        : "Social login token exchange failed",
    );
  }

  return getTokenPayload(await response.json());
}

async function resolveDefaultOrganizationId(
  tokenDefaultOrganizationId: string | undefined,
): Promise<string> {
  const { data: userData } = await getCurrentUser({ throwOnError: false });
  const currentDefaultOrgId = userData?.data?.default_organization_id;
  if (currentDefaultOrgId) {
    return currentDefaultOrgId;
  }

  if (tokenDefaultOrganizationId) {
    return tokenDefaultOrganizationId;
  }

  const { data: orgData } = await listOrganizations({ throwOnError: false });
  const organizations = orgData?.data ?? [];
  const fallbackOrganization =
    organizations.find((organization) => organization.is_personal) ??
    organizations[0];
  if (fallbackOrganization?.id) {
    return fallbackOrganization.id;
  }

  throw new Error("Unable to determine default organization");
}

function createCallbackWaiter(expectedState: string): {
  handler: (event: { payload: SocialLoginCallbackPayload }) => void;
  promise: Promise<SocialLoginCallbackPayload>;
} {
  let resolveCallback!: (payload: SocialLoginCallbackPayload) => void;
  let rejectCallback!: (error: Error) => void;
  const promise = new Promise<SocialLoginCallbackPayload>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  return {
    handler: (event) => {
      const payload = event.payload;

      if (payload.error) {
        rejectCallback(
          new Error(
            payload.error_description
              ? `${payload.error}: ${payload.error_description}`
              : payload.error,
          ),
        );
        return;
      }

      if (!payload.code || !payload.state) {
        rejectCallback(new Error("OAuth callback missing authorization code"));
        return;
      }

      if (payload.state !== expectedState) {
        rejectCallback(new Error("OAuth state mismatch. Please try again."));
        return;
      }

      resolveCallback(payload);
    },
    promise,
  };
}

export async function startSocialLogin(
  provider: SocialLoginProvider,
): Promise<SocialLoginResult> {
  const codeVerifier = generateRandomString(CODE_VERIFIER_LENGTH);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(STATE_LENGTH);
  const authUrl = buildAuthorizeUrl(provider, state, codeChallenge);
  const callbackWaiter = createCallbackWaiter(state);
  const unlisten: UnlistenFn = await listen<SocialLoginCallbackPayload>(
    "social-login-callback",
    callbackWaiter.handler,
  );

  try {
    await invoke("start_social_login", { provider, authUrl });
    const callback = await callbackWaiter.promise;

    const tokenPayload = await exchangeCodeForTokens(
      callback.code ?? "",
      codeVerifier,
    );
    await storeToken(tokenPayload.access_token);
    await storeRefreshToken(tokenPayload.refresh_token);
    const defaultOrganizationId = await resolveDefaultOrganizationId(
      tokenPayload.default_organization_id,
    );
    await storeDefaultOrganizationId(defaultOrganizationId);

    return {
      ...tokenPayload,
      default_organization_id: defaultOrganizationId,
    };
  } finally {
    unlisten();
  }
}
