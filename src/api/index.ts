// ABOUTME: API client exports and initialization.
// ABOUTME: Re-exports core API SDK and configures auth interceptors.

import { client } from "./generated/seren-core/client.gen";
import { attachAuthInterceptor } from "./setup-auth";

attachAuthInterceptor(client);

// Re-export everything from core generated SDK
export * from "./generated/seren-core";
export { client };
