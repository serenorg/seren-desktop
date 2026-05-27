import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentUser, listOrganizations } from "@/api";
import { appFetch } from "@/lib/fetch";
import {
  storeDefaultOrganizationId,
  storeRefreshToken,
  storeToken,
} from "@/lib/tauri-bridge";
import { startSocialLogin } from "@/services/social-login";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@/lib/fetch", () => ({
  appFetch: vi.fn(),
}));

vi.mock("@/api", () => ({
  getCurrentUser: vi.fn(),
  listOrganizations: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  storeDefaultOrganizationId: vi.fn(),
  storeRefreshToken: vi.fn(),
  storeToken: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const appFetchMock = vi.mocked(appFetch);
const getCurrentUserMock = vi.mocked(getCurrentUser);
const listOrganizationsMock = vi.mocked(listOrganizations);
const storeTokenMock = vi.mocked(storeToken);
const storeRefreshTokenMock = vi.mocked(storeRefreshToken);
const storeDefaultOrganizationIdMock = vi.mocked(storeDefaultOrganizationId);

type SocialLoginCallback = (event: {
  payload: { code?: string; state?: string; error?: string };
}) => void | Promise<void>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitForInvoke() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (invokeMock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("start_social_login was not invoked");
}

async function s256(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("base64url");
}

async function startAndCompleteSocialLogin(provider: "github" | "google") {
  let callback: SocialLoginCallback | undefined;
  const unlisten = vi.fn();
  listenMock.mockImplementation(async (_event, handler) => {
    callback = handler as SocialLoginCallback;
    return unlisten;
  });

  invokeMock.mockResolvedValue(undefined);
  appFetchMock.mockResolvedValue(
    jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    }),
  );
  getCurrentUserMock.mockResolvedValue({
    data: { data: { default_organization_id: "org-current" } },
  } as Awaited<ReturnType<typeof getCurrentUser>>);
  listOrganizationsMock.mockResolvedValue({
    data: { data: [{ id: "org-list", is_personal: true }] },
  } as Awaited<ReturnType<typeof listOrganizations>>);

  const promise = startSocialLogin(provider);
  await waitForInvoke();

  const [, { authUrl }] = invokeMock.mock.calls[0] as [
    string,
    { provider: string; authUrl: string },
  ];
  const authorizeUrl = new URL(authUrl);
  const state = authorizeUrl.searchParams.get("state");
  expect(state).toBeTruthy();

  await callback?.({ payload: { code: "auth-code", state: state ?? "" } });
  const result = await promise;

  return { authorizeUrl, result, unlisten };
}

describe("social login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the native OAuth authorize URL with provider and S256 PKCE", async () => {
    const { authorizeUrl } = await startAndCompleteSocialLogin("github");

    expect(invokeMock).toHaveBeenCalledWith("start_social_login", {
      provider: "github",
      authUrl: expect.stringContaining("https://api.serendb.com/oauth2/authorize"),
    });
    expect(authorizeUrl.origin).toBe("https://api.serendb.com");
    expect(authorizeUrl.pathname).toBe("/oauth2/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("seren-desktop");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8787/auth/callback",
    );
    expect(authorizeUrl.searchParams.get("provider")).toBe("github");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const [, tokenInit] = appFetchMock.mock.calls[0];
    const tokenBody = new URLSearchParams(tokenInit?.body as string);
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe(
      await s256(tokenBody.get("code_verifier") ?? ""),
    );
  });

  it("exchanges the callback code and persists tokens plus default organization", async () => {
    const { result, unlisten } = await startAndCompleteSocialLogin("google");

    expect(appFetchMock).toHaveBeenCalledWith(
      "https://api.serendb.com/oauth2/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    const [, tokenInit] = appFetchMock.mock.calls[0];
    const tokenBody = new URLSearchParams(tokenInit?.body as string);
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("auth-code");
    expect(tokenBody.get("client_id")).toBe("seren-desktop");
    expect(tokenBody.get("redirect_uri")).toBe(
      "http://127.0.0.1:8787/auth/callback",
    );
    expect(tokenBody.get("code_verifier")).toBeTruthy();

    expect(storeTokenMock).toHaveBeenCalledWith("access-token");
    expect(storeRefreshTokenMock).toHaveBeenCalledWith("refresh-token");
    expect(getCurrentUserMock).toHaveBeenCalledWith({ throwOnError: false });
    expect(storeDefaultOrganizationIdMock).toHaveBeenCalledWith("org-current");
    expect(result.default_organization_id).toBe("org-current");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("rejects callbacks with a mismatched state before exchanging tokens", async () => {
    let callback: SocialLoginCallback | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_event, handler) => {
      callback = handler as SocialLoginCallback;
      return unlisten;
    });
    invokeMock.mockResolvedValue(undefined);

    const promise = startSocialLogin("github");
    await waitForInvoke();

    await callback?.({
      payload: { code: "auth-code", state: "wrong-state" },
    });

    await expect(promise).rejects.toThrow("OAuth state mismatch");
    expect(appFetchMock).not.toHaveBeenCalled();
    expect(storeTokenMock).not.toHaveBeenCalled();
    expect(storeRefreshTokenMock).not.toHaveBeenCalled();
    expect(storeDefaultOrganizationIdMock).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
