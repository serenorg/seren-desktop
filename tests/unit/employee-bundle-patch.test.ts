import { describe, expect, it } from "vitest";
import type { AgentBundle } from "@/api/seren-agent";
import { buildEmployeeFilesPatch } from "@/lib/employees/bundle-patch";

describe("buildEmployeeFilesPatch", () => {
  it("returns null when bundles have the same files", () => {
    const bundle: AgentBundle = {
      instructions: [{ kind: "skill", path: "SKILL.md", content: "Run." }],
      assets: [
        {
          path: "data/input.json",
          content_base64: "e30=",
          content_type: "application/json",
          purpose: "resource",
          sha256: "abc",
        },
      ],
    };

    expect(buildEmployeeFilesPatch(bundle, { ...bundle })).toBeNull();
  });

  it("computes instruction and asset upserts and removals", () => {
    const current: AgentBundle = {
      instructions: [
        { kind: "skill", path: "SKILL.md", content: "Old." },
        { kind: "identity", path: "IDENTITY.md", content: "Stable." },
      ],
      assets: [
        {
          path: "data/remove.json",
          content_base64: "e30=",
          purpose: "resource",
        },
        {
          path: "data/replace.json",
          content_base64: "b2xk",
          purpose: "resource",
        },
      ],
    };
    const next: AgentBundle = {
      instructions: [
        { kind: "skill", path: "SKILL.md", content: "New." },
        { kind: "agents", path: "AGENTS.md", content: "Delegate." },
      ],
      assets: [
        {
          path: "data/replace.json",
          content_base64: "bmV3",
          purpose: "resource",
        },
        {
          path: "data/add.json",
          content_base64: "e30=",
          purpose: "resource",
        },
      ],
    };

    expect(buildEmployeeFilesPatch(current, next)).toEqual({
      remove_instructions: [{ kind: "identity", path: "IDENTITY.md" }],
      upsert_instructions: [
        { kind: "skill", path: "SKILL.md", content: "New." },
        { kind: "agents", path: "AGENTS.md", content: "Delegate." },
      ],
      remove_assets: ["data/remove.json"],
      upsert_assets: [
        {
          path: "data/replace.json",
          content_base64: "bmV3",
          purpose: "resource",
        },
        {
          path: "data/add.json",
          content_base64: "e30=",
          purpose: "resource",
        },
      ],
    });
  });
});
