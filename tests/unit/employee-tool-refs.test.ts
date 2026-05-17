import { describe, expect, it } from "vitest";
import type { AgentToolRef } from "@/api/seren-agent";
import {
  connectorAccessModeFromToolRefs,
  mergeConnectorAccessToolRefs,
  sameToolRefs,
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
