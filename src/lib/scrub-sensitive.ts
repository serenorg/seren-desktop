// ABOUTME: Utility function to remove sensitive data from error messages.
// ABOUTME: Must be used before sending any error data to telemetry endpoints.

const PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // API keys (Stripe-style sk_live_* and sk_test_*)
  { regex: /sk_(live|test)_[a-zA-Z0-9]+/g, replacement: "[REDACTED_API_KEY]" },

  // Bearer tokens (anything after "Bearer ")
  { regex: /Bearer\s+[^\s]+/g, replacement: "Bearer [REDACTED_TOKEN]" },

  // UUIDs
  {
    regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: "[REDACTED_UUID]",
  },

  // Email addresses
  { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[REDACTED_EMAIL]" },

  // Unix-style paths with usernames (/Users/username/ or /home/username/)
  {
    regex: /(\/Users\/|\/home\/)([^/\s]+)/g,
    replacement: "$1[REDACTED]",
  },

  // Windows-style paths with usernames (C:\Users\username\)
  {
    regex: /(C:\\Users\\)([^\\]+)/gi,
    replacement: "$1[REDACTED]",
  },
];

/**
 * Removes sensitive data from a string before telemetry.
 * Scrubs: API keys, emails, file paths with usernames, UUIDs, Bearer tokens.
 */
export function scrubSensitive(text: string): string {
  let result = text;
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}
