// ABOUTME: Seren Memory API exports and initialization.
// ABOUTME: Re-exports the generated SDK and configures auth interceptors.

import { client } from "./generated/seren-memory/client.gen";
import { attachAuthInterceptor } from "./setup-auth";

attachAuthInterceptor(client);

export * from "./generated/seren-memory";
export { client };
