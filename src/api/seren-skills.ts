// ABOUTME: Seren Skills publisher API exports and initialization.
// ABOUTME: Re-exports seren-skills generated SDK and configures auth interceptors.

import { client } from "./generated/seren-skills/client.gen";
import { attachAuthInterceptor } from "./setup-auth";

attachAuthInterceptor(client);

export * from "./generated/seren-skills";
export { client };
