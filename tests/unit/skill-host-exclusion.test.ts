// ABOUTME: Tests for skill host exclusion contract (#1496).
// ABOUTME: Covers parser, host check, catalog/installed filtering, and fail-closed gating.

import { describe, expect, it } from "vitest";
import {
  filterHostCompatibleCatalog,
  isSkillCompatibleWithHost,
  parseSkillMd,
  SEREN_DESKTOP_HOST,
} from "@/lib/skills";

// ============================================================================
// Parser: excludeHosts frontmatter reading
// ============================================================================

describe("parseSkillMd excludeHosts", () => {
  it("parses inline array form", () => {
    const md = `---
name: cli-only
description: Claude CLI only skill
exclude-hosts: ["seren-desktop"]
---

# CLI Only
`;
    const parsed = parseSkillMd(md);
    expect(parsed.metadata.excludeHosts).toEqual(["seren-desktop"]);
  });

  it("parses block array form (unindented per parser spec)", () => {
    // The existing YAML-lite parser treats indented lines as sub-keys and
    // skips them. Block arrays must use unindented '- item' lines.
    const md = `---
name: cli-only
description: Claude CLI only skill
exclude-hosts:
- seren-desktop
- other-host
---

# CLI Only
`;
    const parsed = parseSkillMd(md);
    expect(parsed.metadata.excludeHosts).toEqual([
      "seren-desktop",
      "other-host",
    ]);
  });

  it("accepts excludeHosts camelCase key as alias", () => {
    const md = `---
name: cli-only
description: Claude CLI only skill
excludeHosts: ["seren-desktop"]
---

# CLI Only
`;
    const parsed = parseSkillMd(md);
    expect(parsed.metadata.excludeHosts).toEqual(["seren-desktop"]);
  });

  it("leaves excludeHosts undefined when not present", () => {
    const md = `---
name: normal
description: Desktop-compatible skill
---

# Normal
`;
    const parsed = parseSkillMd(md);
    expect(parsed.metadata.excludeHosts).toBeUndefined();
  });
});

// ============================================================================
// isSkillCompatibleWithHost: core gate logic
// ============================================================================

describe("isSkillCompatibleWithHost", () => {
  it("allows skill with no excludeHosts", () => {
    expect(isSkillCompatibleWithHost({})).toBe(true);
    expect(isSkillCompatibleWithHost({ excludeHosts: [] })).toBe(true);
    expect(isSkillCompatibleWithHost(null)).toBe(true);
    expect(isSkillCompatibleWithHost(undefined)).toBe(true);
  });

  it("blocks skill that explicitly excludes seren-desktop", () => {
    expect(
      isSkillCompatibleWithHost({ excludeHosts: [SEREN_DESKTOP_HOST] }),
    ).toBe(false);
  });

  it("allows skill that excludes a different host", () => {
    expect(
      isSkillCompatibleWithHost({ excludeHosts: ["some-other-host"] }),
    ).toBe(true);
  });
});

// ============================================================================
// filterHostCompatibleCatalog: discovery filtering
// ============================================================================

describe("filterHostCompatibleCatalog", () => {
  const normalSkill = {
    id: "s:a",
    slug: "a",
    name: "Normal",
    description: "",
    source: "seren" as const,
    tags: [],
  };
  const excludedSkill = {
    id: "s:b",
    slug: "b",
    name: "CLI Only",
    description: "",
    source: "anthropic" as const,
    tags: [],
    excludeHosts: ["seren-desktop"],
  };

  it("drops Desktop-excluded entries from catalog", () => {
    const filtered = filterHostCompatibleCatalog([normalSkill, excludedSkill]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].slug).toBe("a");
  });

  it("keeps all entries when none exclude Desktop", () => {
    const filtered = filterHostCompatibleCatalog([normalSkill]);
    expect(filtered).toHaveLength(1);
  });

  it("fail-closed: an installed skill that manages to declare exclusion cannot be resolved", () => {
    // Regression guard: even if a stale cached ref points at an excluded skill,
    // it must not flow through the catalog filter.
    const allExcluded = filterHostCompatibleCatalog([excludedSkill]);
    expect(allExcluded).toHaveLength(0);
  });
});
