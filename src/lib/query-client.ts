// ABOUTME: Shared TanStack Query client for API-backed desktop data.
// ABOUTME: Keeps generated HeyAPI reads cached consistently across the app.

import { QueryClient } from "@tanstack/solid-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
