// ABOUTME: Centralized configuration for the Seren Gateway API.
// ABOUTME: All API calls must use these values for consistency and security.

/**
 * Seren Gateway API base URL.
 * SECURITY: Must always be HTTPS in production.
 */
export const API_URL = "https://api.serendb.com";

/**
 * API version prefix.
 */
export const API_VERSION = "v1";

/**
 * Full API base path for requests.
 * Example: https://api.serendb.com/v1
 */
export const apiBase = `${API_URL}/${API_VERSION}`;
