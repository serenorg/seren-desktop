// ABOUTME: API client exports and initialization.
// ABOUTME: Re-exports generated SDK and configures auth interceptors.

import { client } from "./generated/client.gen";
import { getToken } from "@/lib/tauri-bridge";

// Set up auth interceptor to add Bearer token to all requests
client.interceptors.request.use(async (request: Request) => {
  const token = await getToken();
  if (token) {
    request.headers.set("Authorization", `Bearer ${token}`);
  }
  return request;
});

// Re-export everything from generated
export * from "./generated";
export { client };
