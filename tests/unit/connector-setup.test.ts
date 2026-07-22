// ABOUTME: Unit coverage for the shared connect-a-channel setup controller.
// ABOUTME: Keeps desktop and web wizard behavior identical and idempotent.

import { describe, expect, it } from "vitest";
import {
  CONNECTOR_SETUP_INITIAL_STATE,
  type ConnectorCatalogEntryLike,
  type ConnectorSetupApi,
  connectorSetupAttach,
  connectorSetupEnterValue,
  connectorSetupMergeToolRefs,
  connectorSetupProvidedFieldNames,
  connectorSetupRequiredFieldsFilled,
  connectorSetupSelect,
  connectorSetupVerify,
} from "../../packages/employees-core/src/connector-setup";

const SLACK: ConnectorCatalogEntryLike = {
  connector_ref: "slack",
  display_name: "Slack",
  description: "Slack workspace messaging.",
  capability: "messaging",
  credentials: [
    {
      name: "SLACK_BOT_TOKEN",
      label: "Bot token",
      required: true,
      secret: true,
      format_hint: "xoxb-...",
    },
    {
      name: "SLACK_APP_TOKEN",
      label: "App token",
      required: false,
      secret: true,
    },
  ],
  setup_url: "https://api.slack.com/apps",
  supports_webhook_ingress: true,
  requires_always_on: true,
  connected: false,
};

const WEBHOOK: ConnectorCatalogEntryLike = {
  ...SLACK,
  connector_ref: "webhook",
  display_name: "Generic webhook",
  credentials: [
    {
      name: "WEBHOOK_INGRESS_SECRET",
      label: "Shared secret",
      required: false,
      secret: true,
    },
  ],
};

function testApi(overrides: Partial<ConnectorSetupApi>): ConnectorSetupApi {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected API call");
  };
  return {
    verifyCredentials: unexpected,
    ensureEmployeeIdentity: unexpected,
    storeCredential: unexpected,
    previewEmployeeSecretRefs: unexpected,
    bindConnectorSecrets: unexpected,
    createEmployeeDelegation: unexpected,
    attachConnector: unexpected,
    ...overrides,
  };
}

const DEPLOYMENT = {
  deploymentId: "dep-1",
  organizationId: "org-1",
  displayName: "Support employee",
  agentIdentityId: null,
  toolRefs: [],
};

describe("connector setup controller", () => {
  it("requires the required fields before verification", () => {
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    expect(state.step).toBe("credentials");
    expect(connectorSetupRequiredFieldsFilled(SLACK, state.values)).toBe(false);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    expect(connectorSetupRequiredFieldsFilled(SLACK, state.values)).toBe(true);
    expect(connectorSetupProvidedFieldNames(SLACK, state.values)).toEqual([
      "SLACK_BOT_TOKEN",
    ]);
  });

  it("verification success advances with the provider identity", async () => {
    const api = testApi({
      verifyCredentials: async (ref, credentials) => {
        expect(ref).toBe("slack");
        expect(credentials).toEqual({ SLACK_BOT_TOKEN: "xoxb-token" });
        return { ok: true, identity: "bot @ workspace" };
      },
    });
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", " xoxb-token ");
    state = await connectorSetupVerify(api, state, SLACK);
    expect(state.step).toBe("attach");
    expect(state.verifiedIdentity).toBe("bot @ workspace");
    expect(state.error).toBeNull();
  });

  it("verification rejection keeps the flow resumable", async () => {
    const api = testApi({
      verifyCredentials: async () => ({
        ok: false,
        failure_reason: "invalid_auth",
      }),
    });
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "bad");
    state = await connectorSetupVerify(api, state, SLACK);
    expect(state.step).toBe("credentials");
    expect(state.error).toContain("invalid_auth");
  });

  it("non-verifiable connectors skip the probe", async () => {
    const api = testApi({});
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, WEBHOOK);
    state = await connectorSetupVerify(api, state, WEBHOOK);
    expect(state.step).toBe("attach");
    expect(state.verifiedIdentity).toBeNull();
  });

  it("tool ref merge is idempotent and corrects stale capability metadata", () => {
    const first = connectorSetupMergeToolRefs([], SLACK);
    expect(first).toHaveLength(1);
    expect(connectorSetupMergeToolRefs(first, SLACK)).toBe(first);
    expect(
      connectorSetupMergeToolRefs(
        [
          {
            kind: "connector",
            connector_ref: "slack",
            capability: "tools",
            scopes: ["chat:write"],
          },
        ],
        SLACK,
      ),
    ).toEqual([
      {
        kind: "connector",
        connector_ref: "slack",
        capability: "messaging",
        scopes: ["chat:write"],
      },
    ]);
  });

  it("attach follows the Passwords authorization transaction", async () => {
    const calls: string[] = [];
    const api = testApi({
      ensureEmployeeIdentity: async (request) => {
        calls.push("identity");
        expect(request.currentAgentIdentityId).toBeNull();
        return { agentIdentityId: "agent-1" };
      },
      storeCredential: async (request) => {
        calls.push("store");
        expect(request.deploymentId).toBe("dep-1");
        expect(request.credentials).toEqual({ SLACK_BOT_TOKEN: "xoxb-token" });
        return {
          references: {
            SLACK_BOT_TOKEN:
              "seren-secrets://11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/SLACK_BOT_TOKEN",
          },
        };
      },
      previewEmployeeSecretRefs: async (request) => {
        calls.push("preview");
        return { secretRefs: request.additionalRefs };
      },
      createEmployeeDelegation: async (request) => {
        calls.push("delegate");
        expect(request.organizationId).toBe("org-1");
        expect(request.agentIdentityId).toBe("agent-1");
        expect(request.secretRefs).toHaveLength(1);
        return { secretResolutionDelegation: "signed-delegation" };
      },
      bindConnectorSecrets: async (request) => {
        calls.push("bind");
        expect(request.connectorRef).toBe("slack");
        return { secretRefs: Object.values(request.secretRefs) };
      },
      attachConnector: async (request) => {
        calls.push("attach");
        expect(request.agentIdentityId).toBe("agent-1");
        expect(request.secretResolutionDelegation).toBe("signed-delegation");
        expect(request.toolRefs).toHaveLength(1);
        expect(request).not.toHaveProperty("credentials");
        return {};
      },
    });
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    state = await connectorSetupAttach(api, state, SLACK, DEPLOYMENT);
    expect(calls).toEqual([
      "identity",
      "store",
      "preview",
      "delegate",
      "bind",
      "attach",
    ]);
    expect(state.step).toBe("done");
    expect(state.values).toEqual({});
  });

  it("a Passwords failure stops before references are bound", async () => {
    const api = testApi({
      ensureEmployeeIdentity: async () => ({ agentIdentityId: "agent-1" }),
      storeCredential: async () => ({
        error: "Unlock a writable Seren Passwords vault first",
      }),
    });
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    state = await connectorSetupAttach(api, state, SLACK, DEPLOYMENT);
    expect(state.step).toBe("credentials");
    expect(state.error).toContain("Unlock a writable");
    expect(state.values.SLACK_BOT_TOKEN).toBe("xoxb-token");
  });

  it("a final deployment update error remains resumable", async () => {
    const api = testApi({
      ensureEmployeeIdentity: async () => ({ agentIdentityId: "agent-1" }),
      storeCredential: async () => ({
        references: { SLACK_BOT_TOKEN: "seren-secrets://vault/item/field" },
      }),
      previewEmployeeSecretRefs: async () => ({
        secretRefs: ["seren-secrets://vault/item/field"],
      }),
      createEmployeeDelegation: async () => ({
        secretResolutionDelegation: "signed-delegation",
      }),
      bindConnectorSecrets: async () => ({
        secretRefs: ["seren-secrets://vault/item/field"],
      }),
      attachConnector: async () => ({ error: "deployment update rejected" }),
    });
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    state = await connectorSetupAttach(api, state, SLACK, DEPLOYMENT);
    expect(state.step).toBe("credentials");
    expect(state.error).toBe("deployment update rejected");
  });

  it("allows connector rotation when the signed preview contains replaced references", async () => {
    const oldReference =
      "seren-secrets://11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/SLACK_BOT_TOKEN";
    const newReference =
      "seren-secrets://11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/SLACK_BOT_TOKEN";
    const api = testApi({
      ensureEmployeeIdentity: async () => ({ agentIdentityId: "agent-1" }),
      storeCredential: async () => ({
        references: { SLACK_BOT_TOKEN: newReference },
      }),
      previewEmployeeSecretRefs: async () => ({
        secretRefs: [oldReference, newReference],
      }),
      createEmployeeDelegation: async () => ({
        secretResolutionDelegation: "signed-delegation",
      }),
      bindConnectorSecrets: async () => ({ secretRefs: [newReference] }),
      attachConnector: async () => ({}),
    });
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-rotated");

    state = await connectorSetupAttach(api, state, SLACK, DEPLOYMENT);

    expect(state.step).toBe("done");
    expect(state.error).toBeNull();
  });

  it("rejects a post-bind reference that was not covered by the delegation", async () => {
    const authorizedReference =
      "seren-secrets://11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/SLACK_BOT_TOKEN";
    const unauthorizedReference =
      "seren-secrets://11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/SLACK_BOT_TOKEN";
    const api = testApi({
      ensureEmployeeIdentity: async () => ({ agentIdentityId: "agent-1" }),
      storeCredential: async () => ({
        references: { SLACK_BOT_TOKEN: authorizedReference },
      }),
      previewEmployeeSecretRefs: async () => ({
        secretRefs: [authorizedReference],
      }),
      createEmployeeDelegation: async () => ({
        secretResolutionDelegation: "signed-delegation",
      }),
      bindConnectorSecrets: async () => ({ secretRefs: [unauthorizedReference] }),
    });
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");

    state = await connectorSetupAttach(api, state, SLACK, DEPLOYMENT);

    expect(state.step).toBe("credentials");
    expect(state.error).toContain("credentials changed during authorization");
  });
});
