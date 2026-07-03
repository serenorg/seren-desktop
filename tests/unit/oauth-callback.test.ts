// ABOUTME: Regression tests for parsing publisher OAuth deep-link callback errors.
// ABOUTME: Protects surfacing the Gateway's error_description instead of an opaque code.

import { describe, expect, it } from "vitest";

import { describeOAuthCallbackError } from "@/lib/oauth-callback";

describe("describeOAuthCallbackError", () => {
  it("returns null for a successful callback (no error param)", () => {
    expect(
      describeOAuthCallbackError(
        "seren://oauth/callback?code=abc123&state=xyz",
      ),
    ).toBeNull();
  });

  it("prefers the Gateway error_description over the opaque error code", () => {
    // The exact failure captured in ~/Downloads/Logs/20260703_oauth.log
    const url =
      "seren://oauth/callback?error=callback_failed&error_description=" +
      encodeURIComponent(
        "Bad request: OAuth provider did not return a stable account identifier",
      );
    expect(describeOAuthCallbackError(url)).toBe(
      "Connection failed: Bad request: OAuth provider did not return a stable account identifier",
    );
  });

  it("falls back to the error code when no description is present", () => {
    expect(
      describeOAuthCallbackError("seren://oauth/callback?error=access_denied"),
    ).toBe("OAuth error: access_denied");
  });

  it("parses the loopback callback variant used on Windows/validation builds", () => {
    const url =
      "http://127.0.0.1:8765/oauth/callback?error=callback_failed" +
      "&error_description=" +
      encodeURIComponent("Provider rejected the request");
    expect(describeOAuthCallbackError(url)).toBe(
      "Connection failed: Provider rejected the request",
    );
  });

  it("returns null for an unparseable callback string", () => {
    expect(describeOAuthCallbackError("not a url")).toBeNull();
  });
});
