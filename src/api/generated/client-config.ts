// ABOUTME: Runtime configuration for the generated API client.
// ABOUTME: Sets base URL and default headers for all API requests.

const API_BASE_URL = "https://api.serendb.com";

/**
 * Creates the client configuration with the Seren API base URL.
 * This function is called during client initialization.
 */
export const createClientConfig = <T>(config?: T): T & { baseUrl: string } => ({
  ...(config as T & { baseUrl: string }),
  baseUrl: API_BASE_URL,
});
