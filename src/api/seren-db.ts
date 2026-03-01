// ABOUTME: Seren DB API exports and initialization.
// ABOUTME: Re-exports seren-db generated SDK and configures auth interceptors.

import { client } from "./generated/seren-db/client.gen";
import { attachAuthInterceptor } from "./setup-auth";

attachAuthInterceptor(client);

export * from "./generated/seren-db";
export { client };
