// ABOUTME: Fetch wrapper for HTTP requests in Tauri environment.
// ABOUTME: Uses Tauri HTTP plugin when available, falls back to browser fetch.

import { getToken } from "./tauri-bridge";
import { getTauriFetch, shouldSkipRefresh } from "./tauri-fetch";

/**
 * Make an HTTP request using the appropriate fetch for the environment.
 * In Tauri, uses the HTTP plugin which bypasses CORS restrictions.
 * In browser, uses native fetch.
 * Automatically refreshes access token on 401 and retries once.
 */
export async function appFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const fetchFn = await getTauriFetch();
  const baseRequest = new Request(input, init);
  let refreshedForRequest = false;
  let otpRetried = 0;

  while (true) {
    const request = baseRequest.clone();
    const response = await fetchFn(request);

    if (
      response.status === 401 &&
      !shouldSkipRefresh(request) &&
      !refreshedForRequest
    ) {
      const { refreshAccessToken } = await import("@/services/auth");
      const refreshed = await refreshAccessToken();
      refreshedForRequest = true;

      if (refreshed) {
        const newToken = await getToken();
        if (newToken) {
          baseRequest.headers.set("Authorization", `Bearer ${newToken}`);
        }

        try {
          await response.body?.cancel();
        } catch {
          // noop
        }

        continue;
      }
    }

    if (response.status === 403) {
      const { organizationOtpService } = await import(
        "@/services/organization-otp"
      );

      if (!organizationOtpService.shouldSkipOtp(request) && otpRetried < 2) {
        const denial =
          await organizationOtpService.isOtpRequiredResponse(response);

        if (denial) {
          const approved = await organizationOtpService.requestApproval(denial);
          if (approved) {
            otpRetried += 1;

            try {
              await response.body?.cancel();
            } catch {
              // noop
            }

            continue;
          }
        }
      }
    }

    if (
      response.status >= 400 &&
      request.url.includes("api.serendb.com") &&
      !request.url.includes("/support/report")
    ) {
      void import("@/lib/support/hook")
        .then(({ captureHttpFailure }) => captureHttpFailure(request, response))
        .catch(() => {});
    }

    return response;
  }
}
