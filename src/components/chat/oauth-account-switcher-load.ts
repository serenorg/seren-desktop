// ABOUTME: Contains optional OAuth account discovery failures inside the chat header.
// ABOUTME: Keeps transient connection-list outages from rejecting a render resource.

import { listConnectedPublishers } from "@/services/publisher-oauth";
import type { OAuthConnection } from "@/stores/oauth-account.store";

export const OAUTH_ACCOUNT_LOAD_ERROR =
  "Connected accounts are temporarily unavailable. Chat remains available.";

export interface OAuthAccountLoadState {
  connections: OAuthConnection[];
  error: string | null;
}

export async function loadOAuthAccountSwitcherState(): Promise<OAuthAccountLoadState> {
  try {
    return {
      connections: await listConnectedPublishers(),
      error: null,
    };
  } catch {
    return {
      connections: [],
      error: OAUTH_ACCOUNT_LOAD_ERROR,
    };
  }
}
