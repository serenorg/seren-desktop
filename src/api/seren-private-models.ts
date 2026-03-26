// ABOUTME: Seren private models API exports and initialization.
// ABOUTME: Re-exports seren-private-models generated SDK and configures auth interceptors.

import { client } from "./generated/seren-private-models/client.gen";
import { attachAuthInterceptor } from "./setup-auth";

attachAuthInterceptor(client);

export * from "./generated/seren-private-models";
export { client };
