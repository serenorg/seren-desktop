// ABOUTME: Seren Cloud API exports and initialization.
// ABOUTME: Re-exports seren-cloud generated SDK and configures auth interceptors.

import { client } from "./generated/seren-cloud/client.gen";
import { attachAuthInterceptor } from "./setup-auth";

attachAuthInterceptor(client);

export * from "./generated/seren-cloud";
export { client };
