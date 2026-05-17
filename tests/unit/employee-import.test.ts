// ABOUTME: Tests for the drop-to-wizard instruction-file router.
// ABOUTME: Covers filename routing and conflict resolution.

import { describe, expect, it } from "vitest";
import {
  importPathForFile,
  normalizeResourcePath,
  routeFiles,
  slotForFilename,
} from "@/lib/employees/import";

describe("slotForFilename", () => {
  it("recognizes the instruction-file names case-insensitively", () => {
    expect(slotForFilename("SKILL.md")).toBe("skill");
    expect(slotForFilename("skill.md")).toBe("skill");
    expect(slotForFilename("Identity.MD")).toBe("identity");
    expect(slotForFilename("AGENTS.md")).toBe("agents");
    expect(slotForFilename("USER.md")).toBe("user");
    expect(slotForFilename("MEMORY.md")).toBe("memory");
    expect(slotForFilename("tools.md")).toBe("tools");
    expect(slotForFilename("HEARTBEAT.md")).toBe("heartbeat");
    expect(slotForFilename("EVAL.md")).toBe("eval");
    expect(slotForFilename("SOUL.md")).toBe("soul");
  });

  it("strips path segments before matching", () => {
    expect(slotForFilename("project/SKILL.md")).toBe("skill");
    expect(slotForFilename("nested\\path\\IDENTITY.md")).toBe("identity");
  });

  it("returns null for unrecognized filenames", () => {
    expect(slotForFilename("README.md")).toBeNull();
    expect(slotForFilename("manifest.json")).toBeNull();
    expect(slotForFilename("skill.txt")).toBeNull();
    expect(slotForFilename("")).toBeNull();
  });

  it("treats only .md as the section extension", () => {
    expect(slotForFilename("SKILL.markdown")).toBeNull();
    expect(slotForFilename("SKILL.MD")).toBe("skill");
  });
});

describe("normalizeResourcePath", () => {
  it("normalizes relative resource paths", () => {
    expect(normalizeResourcePath("refs\\data.json")).toBe("refs/data.json");
    expect(normalizeResourcePath("/refs/./data.json")).toBe("refs/data.json");
  });

  it("rejects empty, parent, and nul paths", () => {
    expect(normalizeResourcePath("")).toBeNull();
    expect(normalizeResourcePath("../secret.txt")).toBeNull();
    expect(normalizeResourcePath("refs/\0secret.txt")).toBeNull();
  });
});

describe("importPathForFile", () => {
  it("preserves directory-relative browser file picker paths", () => {
    expect(
      importPathForFile({
        name: "SKILL.md",
        webkitRelativePath: "agent/SKILL.md",
      }),
    ).toBe("agent/SKILL.md");
  });

  it("ignores native local paths so bundle paths stay relative", () => {
    expect(
      importPathForFile({
        name: "SKILL.md",
        path: "/Users/christian/agent/SKILL.md",
        webkitRelativePath: "agent/SKILL.md",
      }),
    ).toBe("agent/SKILL.md");
  });

  it("falls back to the visible filename for individual file picks", () => {
    expect(
      importPathForFile({
        name: "README.md",
        path: "/Users/christian/agent/README.md",
      }),
    ).toBe("README.md");
  });
});

describe("routeFiles", () => {
  it("routes recognized files by filename", () => {
    const result = routeFiles([
      { name: "SKILL.md", body: "Plain speech." },
      { name: "IDENTITY.md", body: "Senior advisor." },
      {
        name: "README.md",
        body: "Project readme.",
        contentBase64: "UHJvamVjdCByZWFkbWUu",
        contentType: "text/markdown",
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    ]);

    expect(result.sections).toEqual({
      skill: "Plain speech.",
      identity: "Senior advisor.",
    });
    expect(result.routed).toEqual(["SKILL.md", "IDENTITY.md"]);
    expect(result.resources).toEqual([
      {
        path: "README.md",
        content_base64: "UHJvamVjdCByZWFkbWUu",
        content_type: "text/markdown",
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        purpose: "resource",
      },
    ]);
    expect(result.ignored).toEqual([]);
  });

  it("keeps the first file when multiple route to the same slot", () => {
    const result = routeFiles([
      { name: "SKILL.md", body: "First." },
      { name: "skill.md", body: "Second." },
    ]);

    expect(result.sections).toEqual({ skill: "First." });
    expect(result.routed).toEqual(["SKILL.md", "skill.md"]);
  });

  it("strips directory prefixes when matching filenames", () => {
    const result = routeFiles([{ name: "project/SKILL.md", body: "From dir." }]);

    expect(result.sections).toEqual({ skill: "From dir." });
  });

  it("routes SKILL.md and USER.md independently when both are dropped", () => {
    const result = routeFiles([
      { name: "SKILL.md", body: "Skill body." },
      { name: "USER.md", body: "User context body." },
    ]);

    expect(result.sections).toEqual({
      skill: "Skill body.",
      user: "User context body.",
    });
    expect(result.routed).toEqual(["SKILL.md", "USER.md"]);
    expect(result.resources).toEqual([]);
    expect(result.ignored).toEqual([]);
  });

  it("packages unknown files as runtime-readable resources", () => {
    const result = routeFiles([
      {
        name: "data/reference.json",
        body: "{\"ok\":true}",
        contentBase64: "eyJvayI6dHJ1ZX0=",
        contentType: "application/json",
      },
    ]);

    expect(result.sections).toEqual({});
    expect(result.resources).toEqual([
      {
        path: "data/reference.json",
        content_base64: "eyJvayI6dHJ1ZX0=",
        content_type: "application/json",
        purpose: "resource",
      },
    ]);
    expect(result.ignored).toEqual([]);
  });

  it("ignores unsafe resource paths", () => {
    const result = routeFiles([
      {
        name: "../secret.txt",
        body: "secret",
        contentBase64: "c2VjcmV0",
      },
    ]);

    expect(result.sections).toEqual({});
    expect(result.resources).toEqual([]);
    expect(result.ignored).toEqual(["../secret.txt"]);
  });

  it("ignores duplicate resources after path normalization", () => {
    const result = routeFiles([
      {
        name: "refs\\data.txt",
        contentBase64: "b25l",
      },
      {
        name: "refs/data.txt",
        contentBase64: "dHdv",
      },
    ]);

    expect(result.resources).toEqual([
      {
        path: "refs/data.txt",
        content_base64: "b25l",
        purpose: "resource",
      },
    ]);
    expect(result.ignored).toEqual(["refs/data.txt"]);
  });

  it("ignores instruction files when text content is unavailable", () => {
    const result = routeFiles([{ name: "SKILL.md", contentBase64: "////" }]);

    expect(result.sections).toEqual({});
    expect(result.resources).toEqual([]);
    expect(result.ignored).toEqual(["SKILL.md"]);
  });
});
