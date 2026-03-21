// ABOUTME: Shared auth interceptor setup for generated API clients.
// ABOUTME: Adds bearer token to every outbound request.

import { getToken } from "@/lib/tauri-bridge";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";

type ClientWithRequestInterceptor = {
  interceptors?: {
    request?: {
      use: (handler: (request: Request) => Promise<Request>) => unknown;
    };
  };
};

export function attachAuthInterceptor(
  client: ClientWithRequestInterceptor,
): void {
  if (!client.interceptors?.request?.use) {
    console.warn(
      "[API] Client missing request interceptors — auth will not be attached",
    );
    return;
  }
  client.interceptors.request.use(async (request: Request) => {
    if (shouldUseRustGatewayAuth(request)) {
      return request;
    }

    const token = await getToken();
    if (token) {
      request.headers.set("Authorization", `Bearer ${token}`);
    }
    return request;
  });
}
