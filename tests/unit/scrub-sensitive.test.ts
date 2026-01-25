// ABOUTME: Unit tests for the scrubSensitive utility function.
// ABOUTME: Ensures PII and sensitive data is removed before error telemetry.

import { describe, expect, it } from "vitest";
import { scrubSensitive } from "@/lib/scrub-sensitive";

describe("scrubSensitive", () => {
  it("scrubs API keys starting with sk_live_", () => {
    const input = "Error with key sk_live_abc123xyz456";
    expect(scrubSensitive(input)).toBe("Error with key [REDACTED_API_KEY]");
  });

  it("scrubs API keys starting with sk_test_", () => {
    const input = "API key: sk_test_123abc456def";
    expect(scrubSensitive(input)).toBe("API key: [REDACTED_API_KEY]");
  });

  it("scrubs email addresses", () => {
    const input = "User email: test@example.com failed";
    expect(scrubSensitive(input)).toBe("User email: [REDACTED_EMAIL] failed");
  });

  it("scrubs file paths with usernames", () => {
    const input = "Error in /Users/taariq/Projects/seren/file.ts";
    expect(scrubSensitive(input)).toBe(
      "Error in /Users/[REDACTED]/Projects/seren/file.ts"
    );
  });

  it("scrubs Windows-style paths with usernames", () => {
    const input = "Error in C:\\Users\\john\\Documents\\file.txt";
    expect(scrubSensitive(input)).toBe(
      "Error in C:\\Users\\[REDACTED]\\Documents\\file.txt"
    );
  });

  it("scrubs UUIDs", () => {
    const input = "Session 550e8400-e29b-41d4-a716-446655440000 expired";
    expect(scrubSensitive(input)).toBe("Session [REDACTED_UUID] expired");
  });

  it("scrubs Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(scrubSensitive(input)).toBe("Authorization: Bearer [REDACTED_TOKEN]");
  });

  it("handles empty string", () => {
    expect(scrubSensitive("")).toBe("");
  });

  it("passes through safe text unchanged", () => {
    const input = "Connection timeout after 30 seconds";
    expect(scrubSensitive(input)).toBe("Connection timeout after 30 seconds");
  });

  it("scrubs multiple sensitive items in one string", () => {
    const input =
      "User test@example.com with key sk_live_abc123 at /Users/john/app";
    const result = scrubSensitive(input);
    expect(result).not.toContain("test@example.com");
    expect(result).not.toContain("sk_live_abc123");
    expect(result).not.toContain("/Users/john/");
  });
});
