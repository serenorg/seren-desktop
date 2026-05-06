// ABOUTME: Tests for skill drag payload encoding/decoding and prompt wrapping.
// ABOUTME: Guards against false-positive text matches and nested fence corruption.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadContent = vi.hoisted(() => vi.fn());
const mockFetchContent = vi.hoisted(() => vi.fn());

vi.mock("@/services/skills", () => ({
  skills: {
    readContent: mockReadContent,
    fetchContent: mockFetchContent,
  },
}));

vi.mock("@/stores/skills.store", () => ({
  skillsStore: {
    available: [],
    installed: [],
  },
}));

describe("decodeSkillDragPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a prefixed payload", async () => {
    const { decodeSkillDragPayload, encodeSkillDragText } = await import(
      "@/lib/skill-drag"
    );
    const text = encodeSkillDragText({ id: "seren:demo", slug: "demo" });
    expect(decodeSkillDragPayload(text)).toMatchObject({ id: "seren:demo" });
  });

  it("accepts a raw JSON payload by default", async () => {
    const { decodeSkillDragPayload } = await import("@/lib/skill-drag");
    expect(
      decodeSkillDragPayload(JSON.stringify({ id: "seren:demo" })),
    ).toMatchObject({ id: "seren:demo" });
  });

  it("rejects raw JSON when prefix is required", async () => {
    const { decodeSkillDragPayload } = await import("@/lib/skill-drag");
    const text = JSON.stringify({ id: "seren:demo" });
    expect(decodeSkillDragPayload(text, { requirePrefix: true })).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const { decodeSkillDragPayload } = await import("@/lib/skill-drag");
    expect(decodeSkillDragPayload("not json")).toBeNull();
  });

  it("returns null when id is missing", async () => {
    const { decodeSkillDragPayload } = await import("@/lib/skill-drag");
    expect(decodeSkillDragPayload(JSON.stringify({ slug: "demo" }))).toBeNull();
  });
});

describe("skillPromptTextFromDrag fence escaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a longer fence when SKILL.md contains triple backticks", async () => {
    mockFetchContent.mockResolvedValueOnce(
      "# Heading\n\n```bash\necho hello\n```\n",
    );
    const { skillPromptTextFromDrag } = await import("@/lib/skill-drag");

    const text = await skillPromptTextFromDrag({
      id: "seren:demo",
      slug: "demo",
      sourceUrl: "seren-skills:demo",
      name: "Demo",
    });

    expect(text).not.toBeNull();
    if (!text) return;
    const outerFenceMatch = text.match(/\n(`{4,})markdown\n/);
    expect(outerFenceMatch).not.toBeNull();
    const fence = outerFenceMatch?.[1] ?? "";
    expect(fence.length).toBeGreaterThanOrEqual(4);
    expect(text.endsWith(`\n${fence}`)).toBe(true);
  });

  it("escalates fence length to one more than the longest inner run", async () => {
    mockFetchContent.mockResolvedValueOnce("````python\nprint(1)\n````");
    const { skillPromptTextFromDrag } = await import("@/lib/skill-drag");

    const text = await skillPromptTextFromDrag({
      id: "seren:demo",
      slug: "demo",
      sourceUrl: "seren-skills:demo",
      name: "Demo",
    });

    expect(text).not.toBeNull();
    if (!text) return;
    expect(text).toContain("\n`````markdown\n");
    expect(text.endsWith("\n`````")).toBe(true);
  });

  it("returns null when content cannot be fetched", async () => {
    mockFetchContent.mockResolvedValueOnce(null);
    const { skillPromptTextFromDrag } = await import("@/lib/skill-drag");

    const text = await skillPromptTextFromDrag({
      id: "seren:demo",
      slug: "demo",
      sourceUrl: "seren-skills:demo",
    });

    expect(text).toBeNull();
  });
});
