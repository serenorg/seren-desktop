import { describe, expect, it } from "vitest";
import type { AgentToolRef } from "@/api/seren-agent";
import {
  connectorAccessModeFromToolRefs,
  firstRemoteHttpToolRef,
  mergeConnectorAccessToolRefs,
  mergePublisherOperationToolRefs,
  mergeRemoteHttpToolRef,
  remoteHttpToolRefDraftError,
  sameToolRefs,
  selectedPublisherOperationKeysFromToolRefs,
} from "@/lib/employees/tool-refs";

describe("employee tool-ref helpers", () => {
  it("builds Gmail read-only connector refs while preserving other refs", () => {
    const existing: AgentToolRef[] = [
      {
        kind: "publisher",
        publisher_slug: "seren-web",
        operation_id: "fetch",
      },
    ];

    const refs = mergeConnectorAccessToolRefs(existing, "gmail_read");

    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual(existing[0]);
    expect(refs[1]).toEqual({
      kind: "connector",
      connector_ref: "gmail",
      capability: "messaging",
      scopes: ["read"],
      require_approval: false,
      permitted_actions: [{ action: "read", capability: { kind: "all" } }],
    });
    expect(connectorAccessModeFromToolRefs(refs)).toBe("gmail_read");
  });

  it("replaces only the managed Gmail connector and can clear it", () => {
    const existing: AgentToolRef[] = [
      {
        kind: "connector",
        connector_ref: "gmail",
        capability: "messaging",
        scopes: ["read"],
        require_approval: false,
        permitted_actions: [{ action: "read", capability: { kind: "all" } }],
      },
      {
        kind: "connector",
        connector_ref: "slack",
        capability: "messaging",
        scopes: ["read"],
      },
    ];

    const sendRefs = mergeConnectorAccessToolRefs(
      existing,
      "gmail_send_approval",
    );
    expect(sendRefs).toHaveLength(2);
    expect(sendRefs[0]).toEqual(existing[1]);
    expect(sendRefs[1]).toMatchObject({
      kind: "connector",
      connector_ref: "gmail",
      require_approval: true,
      scopes: ["read", "send"],
    });
    expect(connectorAccessModeFromToolRefs(sendRefs)).toBe(
      "gmail_send_approval",
    );

    const cleared = mergeConnectorAccessToolRefs(sendRefs, "none");
    expect(cleared).toEqual([existing[1]]);
    expect(connectorAccessModeFromToolRefs(cleared)).toBe("none");
  });

  it("mode toggle round-trip preserves wire-equal tool refs", () => {
    const start: AgentToolRef[] = [
      {
        kind: "publisher",
        publisher_slug: "seren-web",
        operation_id: "fetch",
      },
    ];

    const a = mergeConnectorAccessToolRefs(start, "gmail_read");
    const b = mergeConnectorAccessToolRefs(a, "gmail_send_approval");
    const c = mergeConnectorAccessToolRefs(b, "gmail_read");

    expect(sameToolRefs(a, c)).toBe(true);
    expect(sameToolRefs(a, b)).toBe(false);
    expect(connectorAccessModeFromToolRefs(c)).toBe("gmail_read");
  });

  it("discriminator preserves custom gmail messaging refs that are not the managed preset shape", () => {
    const custom: AgentToolRef = {
      kind: "connector",
      connector_ref: "gmail",
      capability: "messaging",
      scopes: ["read", "labels"],
    };
    const existing: AgentToolRef[] = [custom];

    // Mode `none` should leave the user-authored gmail ref alone since it does
    // not match either managed preset shape.
    const noneRefs = mergeConnectorAccessToolRefs(existing, "none");
    expect(noneRefs).toEqual([custom]);
    expect(connectorAccessModeFromToolRefs(noneRefs)).toBe("none");

    // Switching to `gmail_read` should append the managed preset alongside the
    // user-authored ref without clobbering it.
    const readRefs = mergeConnectorAccessToolRefs(existing, "gmail_read");
    expect(readRefs).toHaveLength(2);
    expect(readRefs[0]).toEqual(custom);
    expect(readRefs[1]).toMatchObject({
      kind: "connector",
      connector_ref: "gmail",
      capability: "messaging",
      scopes: ["read"],
      require_approval: false,
    });
    expect(connectorAccessModeFromToolRefs(readRefs)).toBe("gmail_read");
  });

  it("sameToolRefs treats scope order and missing optional flags as equivalent", () => {
    const a: AgentToolRef[] = [
      {
        kind: "connector",
        connector_ref: "gmail",
        capability: "messaging",
        scopes: ["read", "send"],
        require_approval: true,
        permitted_actions: [
          { action: "read", capability: { kind: "all" } },
          {
            action: "send",
            capability: { kind: "specific", actions: ["email"] },
          },
        ],
      },
    ];
    const b: AgentToolRef[] = [
      {
        kind: "connector",
        connector_ref: "gmail",
        capability: "messaging",
        // Same scopes, different order.
        scopes: ["send", "read"],
        require_approval: true,
        // Same leases, different order.
        permitted_actions: [
          {
            action: "send",
            capability: { kind: "specific", actions: ["email"] },
          },
          { action: "read", capability: { kind: "all" } },
        ],
      },
    ];
    expect(sameToolRefs(a, b)).toBe(true);

    // Optional require_approval: undefined and false should match.
    const c: AgentToolRef[] = [
      {
        kind: "publisher",
        publisher_slug: "seren-web",
        operation_id: "fetch",
        require_approval: false,
      },
    ];
    const d: AgentToolRef[] = [
      {
        kind: "publisher",
        publisher_slug: "seren-web",
        operation_id: "fetch",
      },
    ];
    expect(sameToolRefs(c, d)).toBe(true);
  });

  it("sameToolRefs differentiates publisher refs by identity fields", () => {
    const a: AgentToolRef[] = [
      {
        kind: "publisher",
        publisher_slug: "seren-web",
        operation_id: "fetch",
      },
    ];
    const b: AgentToolRef[] = [
      {
        kind: "publisher",
        publisher_slug: "seren-web",
        operation_id: "post",
      },
    ];
    expect(sameToolRefs(a, b)).toBe(false);
  });

  it("merges managed publisher operations while preserving custom publisher refs", () => {
    const custom: AgentToolRef = {
      kind: "publisher",
      publisher_slug: "seren-web",
      operation_id: "fetch",
    };
    const existing: AgentToolRef[] = [
      custom,
      {
        kind: "publisher",
        publisher_slug: "microsoft",
        operation_id: "calendar.events.list",
      },
    ];

    const selected = selectedPublisherOperationKeysFromToolRefs(existing);
    expect(selected).toEqual(["microsoft:calendar.events.list"]);

    const refs = mergePublisherOperationToolRefs(existing, [
      "microsoft:mail.messages.send",
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual(custom);
    expect(refs[1]).toEqual({
      kind: "publisher",
      publisher_slug: "microsoft",
      operation_id: "mail.messages.send",
      require_approval: true,
      permitted_actions: [
        {
          action: "mail.messages.send",
          capability: { kind: "all" },
        },
      ],
    });

    expect(mergePublisherOperationToolRefs(refs, [])).toEqual([custom]);
  });

  it("sameToolRefs compares remote http refs structurally", () => {
    const a: AgentToolRef[] = [
      {
        kind: "remote_http",
        name: "webhook_lookup",
        endpoint: "https://api.example.com/tools/lookup",
        method: "post",
        auth_mode: "api_key",
        require_approval: false,
      },
    ];
    const b: AgentToolRef[] = [
      {
        kind: "remote_http",
        name: "webhook_lookup",
        endpoint: "https://api.example.com/tools/lookup",
        method: "post",
        auth_mode: "api_key",
        require_approval: null as unknown as boolean,
        timeout_ms: null,
      },
    ];
    const c: AgentToolRef[] = [
      {
        kind: "remote_http",
        name: "webhook_lookup",
        endpoint: "https://api.example.com/tools/lookup",
        method: "get",
        auth_mode: "api_key",
      },
    ];

    expect(sameToolRefs(a, b)).toBe(true);
    expect(sameToolRefs(a, c)).toBe(false);
  });

  it("replaces the first remote http ref while preserving other refs", () => {
    const primary: AgentToolRef = {
      kind: "remote_http",
      name: "lookup",
      endpoint: "https://api.example.com/tools/lookup",
      method: "post",
      auth_mode: "api_key",
    };
    const secondary: AgentToolRef = {
      kind: "remote_http",
      name: "notify",
      endpoint: "https://api.example.com/tools/notify",
      method: "post",
      auth_mode: "bearer",
    };
    const connector: AgentToolRef = {
      kind: "connector",
      connector_ref: "slack",
      capability: "messaging",
    };
    const replacement: AgentToolRef = {
      kind: "remote_http",
      name: "lookup_v2",
      endpoint: "https://api.example.com/tools/lookup-v2",
      method: "get",
      auth_mode: "none",
    };

    expect(firstRemoteHttpToolRef([connector, primary, secondary])).toEqual(
      primary,
    );
    expect(
      mergeRemoteHttpToolRef([connector, primary, secondary], replacement),
    ).toEqual([connector, replacement, secondary]);
    expect(mergeRemoteHttpToolRef([connector, primary, secondary], undefined))
      .toEqual([connector, secondary]);
  });

  it("preserves hidden remote http fields while editing the first ref", () => {
    const primary: AgentToolRef = {
      kind: "remote_http",
      name: "lookup",
      endpoint: "https://api.example.com/tools/lookup",
      method: "post",
      auth_mode: "bearer",
      timeout_ms: 5000,
      require_approval: true,
      permitted_actions: [
        {
          action: "execute",
          capability: { kind: "specific", actions: ["lookup.customer"] },
        },
      ],
    };
    const replacement: AgentToolRef = {
      ...primary,
      name: "lookup_v2",
    };

    expect(mergeRemoteHttpToolRef([primary], replacement)).toEqual([
      replacement,
    ]);
  });

  it("validates remote http drafts with backend URL parity", () => {
    const valid = {
      enabled: true,
      name: "lookup",
      endpoint: "https://api.example.com/tools/lookup?region=us",
    };

    expect(remoteHttpToolRefDraftError({ ...valid, enabled: false })).toBe("");
    expect(remoteHttpToolRefDraftError(valid)).toBe("");
    expect(remoteHttpToolRefDraftError({ ...valid, name: " " })).toBe(
      "Remote HTTP name is required.",
    );
    expect(remoteHttpToolRefDraftError({ ...valid, name: " lookup" })).toBe(
      "Remote HTTP name must not include leading or trailing whitespace.",
    );
    expect(remoteHttpToolRefDraftError({ ...valid, name: "look up" })).toBe(
      "Remote HTTP name may only contain letters, numbers, underscores, dashes, and dots.",
    );
    expect(
      remoteHttpToolRefDraftError({
        ...valid,
        name: "x".repeat(129),
      }),
    ).toBe("Remote HTTP name must be at most 128 characters.");
    expect(remoteHttpToolRefDraftError({ ...valid, endpoint: " " })).toBe(
      "Remote HTTP endpoint is required.",
    );
    expect(
      remoteHttpToolRefDraftError({
        ...valid,
        endpoint: "ftp://api.example.com/tools/lookup",
      }),
    ).toBe("Remote HTTP endpoint must be an HTTP(S) URL.");
    expect(
      remoteHttpToolRefDraftError({
        ...valid,
        endpoint: "http://api.example.com/tools/lookup",
      }),
    ).toBe("Remote HTTP endpoint must use HTTPS.");
    expect(
      remoteHttpToolRefDraftError({
        ...valid,
        endpoint: "https://user:secret@api.example.com/tools/lookup",
      }),
    ).toBe("Remote HTTP endpoint must not include credentials.");
    for (const endpoint of [
      "https://localhost/tools/lookup",
      "https://127.0.0.1/tools/lookup",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/tools/lookup",
      "https://172.16.0.1/tools/lookup",
      "https://172.31.255.255/tools/lookup",
      "https://192.168.1.1/tools/lookup",
      "https://192.0.2.1/tools/lookup",
      "https://198.51.100.1/tools/lookup",
      "https://203.0.113.1/tools/lookup",
      "https://0.0.0.0/tools/lookup",
      "https://255.255.255.255/tools/lookup",
      "https://[::1]/tools/lookup",
      "https://[::]/tools/lookup",
      "https://[fe80::1]/tools/lookup",
      "https://[fe90::1]/tools/lookup",
      "https://[2001:db8::1]/tools/lookup",
      "https://[::ffff:127.0.0.1]/tools/lookup",
      "https://[::ffff:192.168.1.1]/tools/lookup",
    ]) {
      expect(remoteHttpToolRefDraftError({ ...valid, endpoint })).toBe(
        "Remote HTTP endpoint must not target localhost or private IPs.",
      );
    }
    for (const endpoint of [
      "https://8.8.8.8/tools/lookup",
      "https://172.32.0.1/tools/lookup",
      "https://0.1.2.3/tools/lookup",
      "https://[2001:4860:4860::8888]/tools/lookup",
      "https://[fec0::1]/tools/lookup",
      "https://[::ffff:8.8.8.8]/tools/lookup",
    ]) {
      expect(remoteHttpToolRefDraftError({ ...valid, endpoint })).toBe("");
    }
    expect(
      remoteHttpToolRefDraftError({
        ...valid,
        endpoint: "https://api.example.com/tools/lookup#",
      }),
    ).toBe("Remote HTTP endpoint must not include a fragment.");
    expect(
      remoteHttpToolRefDraftError({
        ...valid,
        endpoint: "https://api.example.com/tools/lookup#section",
      }),
    ).toBe("Remote HTTP endpoint must not include a fragment.");
  });

  it("validates remote http drafts against existing refs", () => {
    const editing: AgentToolRef = {
      kind: "remote_http",
      name: "lookup",
      endpoint: "https://api.example.com/tools/lookup",
      method: "post",
      auth_mode: "bearer",
    };
    const secondary: AgentToolRef = {
      kind: "remote_http",
      name: "notify",
      endpoint: "https://api.example.com/tools/notify",
      method: "post",
      auth_mode: "none",
    };
    const existingRefs = [editing, secondary];

    expect(
      remoteHttpToolRefDraftError({
        enabled: true,
        name: "lookup",
        endpoint: "https://API.example.com:443/tools/lookup",
        method: "post",
        existingRefs,
        editingRef: editing,
      }),
    ).toBe("");
    expect(
      remoteHttpToolRefDraftError({
        enabled: true,
        name: "notify",
        endpoint: "https://api.example.com/tools/lookup-v2",
        method: "post",
        existingRefs,
        editingRef: editing,
      }),
    ).toBe("Remote HTTP name already exists.");
    expect(
      remoteHttpToolRefDraftError({
        enabled: true,
        name: "lookup_v2",
        endpoint: "https://api.example.com:443/tools/notify",
        method: "post",
        existingRefs,
        editingRef: editing,
      }),
    ).toBe("Remote HTTP endpoint already exists for this method.");
  });

  it("connectorAccessModeFromToolRefs returns none for non-preset gmail refs", () => {
    const refs: AgentToolRef[] = [
      {
        kind: "connector",
        connector_ref: "gmail",
        capability: "messaging",
        scopes: ["send"],
        require_approval: false,
      },
    ];
    expect(connectorAccessModeFromToolRefs(refs)).toBe("none");
  });
});
