// ABOUTME: Centralized configuration for the Seren Gateway API.
// ABOUTME: All API calls must use these values for consistency and security.

/**
 * Seren Gateway API base URL.
 * SECURITY: Must always be HTTPS in production.
 * NOTE: Seren Gateway API does NOT use a version prefix.
 */
export const API_BASE =
  import.meta.env.VITE_SEREN_API_URL ?? "https://api.serendb.com";

// Backwards-compat alias
export const apiBase = API_BASE;
export const API_URL = API_BASE;

export const config = {
  apiBase,
};
