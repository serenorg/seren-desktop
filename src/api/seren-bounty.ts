// ABOUTME: Seren Bounty publisher API exports and initialization.
// ABOUTME: Re-exports seren-bounty generated SDK and configures auth interceptors.

import { client } from "./generated/seren-bounty/client.gen";
import { attachAuthInterceptor } from "./setup-auth";

attachAuthInterceptor(client);

export * from "./generated/seren-bounty";
export { client };
