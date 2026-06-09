// ABOUTME: Regression tests for BYOC OAuth tool-error classification.
// ABOUTME: Pins inline connect/reconnect affordance triggers for gateway tools.

import { describe, expect, it } from "vitest";

import {
  getOAuthConnectActionForToolError,
  isOAuthConnectionRequiredError,
  isOAuthRefreshError,
  isOAuthScopeError,
  isOAuthTokenError,
} from "@/lib/oauth-tool-errors";

describe("BYOC OAuth tool errors", () => {
  it("treats Google insufficient-scope 403s as reconnect-worthy OAuth errors", () => {
    expect(
      isOAuthTokenError(
        "403 Forbidden: Request had insufficient authentication scopes.",
      ),
    ).toBe(true);
    expect(
      isOAuthTokenError(
        '{"error":"access_token_scope_insufficient","message":"Missing scope"}',
      ),
    ).toBe(true);
  });

  it("distinguishes first-connect OAuth failures from generic forbidden errors", () => {
    expect(isOAuthConnectionRequiredError("OAuth authentication required")).toBe(
      true,
    );
    expect(
      isOAuthConnectionRequiredError("403 Forbidden: quota exceeded"),
    ).toBe(false);
  });

  it("classifies canonical scope markers directly", () => {
    expect(isOAuthScopeError("insufficient authentication scopes")).toBe(true);
    expect(isOAuthScopeError("access_token_scope_insufficient")).toBe(true);
  });

  it("classifies expired-token refresh failures as reconnect-worthy", () => {
    expect(isOAuthRefreshError("OAuth token refresh failed")).toBe(true);
    expect(isOAuthRefreshError('{"error":"invalid_grant"}')).toBe(true);
    expect(isOAuthRefreshError("refresh token expired")).toBe(true);
    expect(isOAuthRefreshError("403 Forbidden: quota exceeded")).toBe(false);
  });

  it("surfaces an inline reconnect action when a previously-valid token expires", () => {
    for (const message of [
      "OAuth token refresh failed",
      "Provider error during token refresh",
      '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
      "refresh token expired",
    ]) {
      expect(
        getOAuthConnectActionForToolError(
          "gateway__gmail__get_messages",
          message,
        ),
      ).toEqual({ publisherSlug: "gmail", reason: "connection_required" });
    }
  });

  it("returns an inline action only for actionable gateway OAuth failures", () => {
    expect(
      getOAuthConnectActionForToolError(
        "gateway__gmail__get_messages",
        "OAuth authentication required",
      ),
    ).toEqual({ publisherSlug: "gmail", reason: "connection_required" });

    expect(
      getOAuthConnectActionForToolError(
        "gateway__google-meet__create_meeting",
        "403: access_token_scope_insufficient",
      ),
    ).toEqual({
      publisherSlug: "google-meet",
      reason: "scope_insufficient",
    });

    expect(
      getOAuthConnectActionForToolError(
        "read_file",
        "OAuth authentication required",
      ),
    ).toBeNull();
    expect(
      getOAuthConnectActionForToolError(
        "gateway__gmail__get_messages",
        "403 Forbidden: quota exceeded",
      ),
    ).toBeNull();
  });
});
