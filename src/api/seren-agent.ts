// ABOUTME: Seren Agent API exports and initialization.
// ABOUTME: Re-exports seren-agent generated SDK and configures auth interceptors.

import { client } from "./generated/seren-agent/client.gen";
import { attachAuthInterceptor } from "./setup-auth";

attachAuthInterceptor(client);

export * from "./generated/seren-agent";
export { client };
