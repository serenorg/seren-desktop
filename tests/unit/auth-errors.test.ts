import { describe, expect, it } from "vitest";
import { isAuthError, isLikelyAuthError } from "@/lib/auth-errors";

describe("isAuthError", () => {
  it("detects common auth error messages", () => {
    expect(isAuthError("login required")).toBe(true);
    expect(isAuthError("authentication_error: invalid token")).toBe(true);
    expect(isAuthError("OAuth token has expired")).toBe(true);
    expect(isAuthError("token expired")).toBe(true);
    expect(isAuthError("session expired")).toBe(true);
    expect(isAuthError("not authenticated")).toBe(true);
    expect(isAuthError("please sign in")).toBe(true);
    expect(isAuthError("does not have access")).toBe(true);
    expect(isAuthError("Run claude login to authenticate")).toBe(true);
    expect(isAuthError("please login again")).toBe(true);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError("")).toBe(false);
  });

  it("does not false-positive on '401' in normal text", () => {
    expect(isAuthError("HTTP status 401 Unauthorized")).toBe(false);
    expect(isAuthError("Error code: 401")).toBe(false);
    expect(isAuthError("port 4010")).toBe(false);
  });

  it("does not false-positive on normal assistant content", () => {
    expect(
      isAuthError(
        "I searched for files matching the pattern and found 401 results",
      ),
    ).toBe(false);
    expect(
      isAuthError("The server returned a 401 status code for that endpoint"),
    ).toBe(false);
  });

  it("matches regardless of message length", () => {
    const longMsg = "x".repeat(1000) + " token expired " + "x".repeat(1000);
    expect(isAuthError(longMsg)).toBe(true);
  });
});

describe("isLikelyAuthError", () => {
  it("detects short auth error messages", () => {
    expect(isLikelyAuthError("token expired")).toBe(true);
    expect(isLikelyAuthError("authentication_error: invalid")).toBe(true);
    expect(isLikelyAuthError("not logged in")).toBe(true);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isLikelyAuthError(null)).toBe(false);
    expect(isLikelyAuthError(undefined)).toBe(false);
    expect(isLikelyAuthError("")).toBe(false);
  });

  it("rejects long messages that mention auth keywords", () => {
    const longAssistantResponse =
      "I analyzed the authentication flow in your codebase. " +
      "The token expired error occurs when the JWT lifetime exceeds 24 hours. " +
      "Here's how to fix it:\n\n" +
      "```typescript\n" +
      "// Check if the token has expired before making API calls\n" +
      "if (isTokenExpired(token)) {\n" +
      "  await refreshToken();\n" +
      "}\n" +
      "```\n\n" +
      "This pattern ensures the token is always fresh. The session expired " +
      "handling should also be updated to redirect to the login page. " +
      "You'll also want to handle the case where the refresh token itself " +
      "has expired, which requires the user to log in again. " +
      "Make sure your refresh endpoint returns a new token with the correct " +
      "claims and that the client stores it securely using httpOnly cookies.";

    expect(longAssistantResponse.length).toBeGreaterThan(500);
    expect(isLikelyAuthError(longAssistantResponse)).toBe(false);
  });

  it("rejects long tool output containing auth phrases", () => {
    const toolOutput =
      "$ grep -r 'authentication' src/\n" +
      "src/middleware/auth.ts: if (!req.user) throw new Error('not authenticated')\n" +
      "src/routes/login.ts: // Handle login required redirect\n" +
      "src/utils/token.ts: // Check if token expired\n" +
      "src/config.ts: authRequired: true\n" +
      "Found 4 matches in 4 files. The authentication middleware checks if " +
      "the user is not authenticated and throws an error. The login route " +
      "handles the login required redirect. The token utility checks for " +
      "token expiration. The config file sets auth required to true.";

    expect(isLikelyAuthError(toolOutput)).toBe(false);
  });

  it("accepts short CLI auth error messages", () => {
    expect(
      isLikelyAuthError("Error: OAuth token has expired. Please login again."),
    ).toBe(true);
    expect(
      isLikelyAuthError(
        "authentication_error: Your session has expired. Run `claude login` to re-authenticate.",
      ),
    ).toBe(true);
  });
});
