// ABOUTME: Unit coverage for the shared connect-a-channel setup controller.
// ABOUTME: Keeps desktop and web wizard behavior identical and idempotent.

import { describe, expect, it } from "vitest";
import {
  CONNECTOR_SETUP_INITIAL_STATE,
  type ConnectorCatalogEntryLike,
  type ConnectorSetupApi,
  connectorSetupAttach,
  connectorSetupEnterValue,
  connectorSetupMergeCredentialRefs,
  connectorSetupMergeToolRefs,
  connectorSetupRequiredFieldsFilled,
  connectorSetupSecretNames,
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

describe("connector setup controller", () => {
  it("requires the required fields before verification", () => {
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    expect(state.step).toBe("credentials");
    expect(connectorSetupRequiredFieldsFilled(SLACK, state.values)).toBe(false);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    expect(connectorSetupRequiredFieldsFilled(SLACK, state.values)).toBe(true);
  });

  it("verification success advances with the provider identity", async () => {
    const api: ConnectorSetupApi = {
      verifyCredentials: async (ref, credentials) => {
        expect(ref).toBe("slack");
        expect(credentials).toEqual({ SLACK_BOT_TOKEN: "xoxb-token" });
        return { ok: true, identity: "bot @ workspace" };
      },
      attachConnector: async () => ({}),
    };
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", " xoxb-token ");
    state = await connectorSetupVerify(api, state, SLACK);
    expect(state.step).toBe("attach");
    expect(state.verifiedIdentity).toBe("bot @ workspace");
    expect(state.error).toBeNull();
  });

  it("verification rejection keeps the flow on credentials with the reason", async () => {
    const api: ConnectorSetupApi = {
      verifyCredentials: async () => ({
        ok: false,
        failure_reason: "invalid_auth",
      }),
      attachConnector: async () => ({}),
    };
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "bad");
    state = await connectorSetupVerify(api, state, SLACK);
    expect(state.step).toBe("credentials");
    expect(state.error).toContain("invalid_auth");
  });

  it("non-verifiable connectors skip the probe", async () => {
    const api: ConnectorSetupApi = {
      verifyCredentials: async () => {
        throw new Error("must not be called");
      },
      attachConnector: async () => ({}),
    };
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, WEBHOOK);
    state = await connectorSetupVerify(api, state, WEBHOOK);
    expect(state.step).toBe("attach");
    expect(state.verifiedIdentity).toBeNull();
  });

  it("tool ref merge is idempotent", () => {
    const first = connectorSetupMergeToolRefs([], SLACK);
    expect(first).toHaveLength(1);
    const second = connectorSetupMergeToolRefs(first, SLACK);
    expect(second).toBe(first);
  });

  it("tool ref merge corrects stale connector capability metadata", () => {
    const existing = [
      {
        kind: "connector",
        connector_ref: "slack",
        capability: "tools",
        scopes: ["chat:write"],
      },
    ];
    expect(connectorSetupMergeToolRefs(existing, SLACK)).toEqual([
      { ...existing[0], capability: "messaging" },
    ]);
  });

  it("credential ref merge scopes provided fields to the deployment", () => {
    const values = { SLACK_BOT_TOKEN: "xoxb-token", SLACK_APP_TOKEN: "" };
    const existing = [
      {
        name: "SLACK_BOT_TOKEN",
        ref_uri: "org-secret://SLACK_BOT_TOKEN",
        kind: "api_key",
        binding: "env",
      },
    ];
    const { merged, changed } = connectorSetupMergeCredentialRefs(
      existing,
      SLACK,
      values,
      "dep-1",
    );
    expect(changed).toBe(1);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.ref_uri).toBe(
      "org-secret://connector-dep-1-SLACK_BOT_TOKEN",
    );
    expect(connectorSetupSecretNames(SLACK, values, "dep-1")).toEqual([
      "connector-dep-1-SLACK_BOT_TOKEN",
    ]);
  });

  it("credential ref merge corrects a conflicting same-name reference", () => {
    const existing = [
      {
        name: "SLACK_BOT_TOKEN",
        ref_uri: "user-secret://SLACK_BOT_TOKEN",
        kind: "api_key",
        binding: "header",
        binding_target: "Authorization",
      },
    ];
    const { merged, changed } = connectorSetupMergeCredentialRefs(
      existing,
      SLACK,
      { SLACK_BOT_TOKEN: "xoxb-token" },
      "dep-1",
    );
    expect(changed).toBe(1);
    expect(merged).toEqual([
      {
        name: "SLACK_BOT_TOKEN",
        ref_uri: "org-secret://connector-dep-1-SLACK_BOT_TOKEN",
        kind: "api_key",
        binding: "env",
      },
    ]);
  });

  it("credential ref merge removes a stale env binding target", () => {
    const { merged, changed } = connectorSetupMergeCredentialRefs(
      [
        {
          name: "SLACK_BOT_TOKEN",
          ref_uri: "org-secret://connector-dep-1-SLACK_BOT_TOKEN",
          kind: "api_key",
          binding: "env",
          binding_target: "Authorization",
        },
      ],
      SLACK,
      { SLACK_BOT_TOKEN: "xoxb-token" },
      "dep-1",
    );
    expect(changed).toBe(1);
    expect(merged[0]).not.toHaveProperty("binding_target");
  });

  it("attach surfaces the update error and stays resumable", async () => {
    const api: ConnectorSetupApi = {
      verifyCredentials: async () => ({ ok: true }),
      attachConnector: async () => ({
        error:
          "credential references target organization secrets that do not exist: SLACK_BOT_TOKEN",
      }),
    };
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    state = await connectorSetupAttach(api, state, SLACK, {
      deploymentId: "dep-1",
      toolRefs: [],
      credentials: [],
    });
    expect(state.step).toBe("credentials");
    expect(state.error).toContain("SLACK_BOT_TOKEN");
  });

  it("attach stores provided secrets before updating the deployment", async () => {
    const calls: string[] = [];
    const api: ConnectorSetupApi = {
      verifyCredentials: async () => ({ ok: true }),
      attachConnector: async () => {
        calls.push("attach");
        return {};
      },
      storeSecret: async (request) => {
        calls.push(`store:${request.name}`);
        expect(request.name).toBe("connector-dep-1-SLACK_BOT_TOKEN");
        expect(request.value).toBe("xoxb-token");
        expect(request.description).toBe("Slack connector credential");
        return {};
      },
    };
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    state = await connectorSetupAttach(api, state, SLACK, {
      deploymentId: "dep-1",
      toolRefs: [],
      credentials: [],
    });
    expect(state.step).toBe("done");
    expect(calls).toEqual([
      "store:connector-dep-1-SLACK_BOT_TOKEN",
      "attach",
    ]);
  });

  it("a secret store failure stops before the deployment update", async () => {
    const api: ConnectorSetupApi = {
      verifyCredentials: async () => ({ ok: true }),
      attachConnector: async () => {
        throw new Error("must not be called");
      },
      storeSecret: async () => ({ error: "secret store unavailable" }),
    };
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    state = await connectorSetupAttach(api, state, SLACK, {
      deploymentId: "dep-1",
      toolRefs: [],
      credentials: [],
    });
    expect(state.step).toBe("credentials");
    expect(state.error).toBe("secret store unavailable");
  });

  it("attach success completes the flow", async () => {
    const api: ConnectorSetupApi = {
      verifyCredentials: async () => ({ ok: true }),
      attachConnector: async (request) => {
        expect(request.deploymentId).toBe("dep-1");
        expect(request.toolRefs).toHaveLength(1);
        expect(request.credentials).toHaveLength(1);
        return {};
      },
    };
    let state = connectorSetupSelect(CONNECTOR_SETUP_INITIAL_STATE, SLACK);
    state = connectorSetupEnterValue(state, "SLACK_BOT_TOKEN", "xoxb-token");
    state = await connectorSetupAttach(api, state, SLACK, {
      deploymentId: "dep-1",
      toolRefs: [],
      credentials: [],
    });
    expect(state.step).toBe("done");
  });
});
