// ABOUTME: Centralized configuration for the Seren Gateway API.
// ABOUTME: All API calls must use these values for consistency and security.

/**
 * Seren Gateway API base URL.
 * SECURITY: Must always be HTTPS in production.
 */
export const API_URL =
  import.meta.env.VITE_SEREN_API_URL ?? "https://api.serendb.com";

/**
 * API version prefix.
 */
export const API_VERSION = import.meta.env.VITE_SEREN_API_VERSION ?? "v1";

const DEFAULT_API_BASE = `${API_URL}/${API_VERSION}`;

/**
 * Full API base path for requests.
 * Example: https://api.serendb.com/v1
 */
export const apiBase =
  import.meta.env.VITE_SEREN_API_BASE ?? DEFAULT_API_BASE;

export const config = {
  apiBase,
};
