// ABOUTME: Tests for skill drag payload encoding/decoding and prompt wrapping.
// ABOUTME: Guards against false-positive text matches and nested fence corruption.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockReadContent = vi.hoisted(() => vi.fn());
const mockFetchContent = vi.hoisted(() => vi.fn());
const mockInstall = vi.hoisted(() => vi.fn());
const mockAttachSkillToThread = vi.hoisted(() => vi.fn());
const mockGetThreadSkills = vi.hoisted(() => vi.fn());
const mockSkillsState = vi.hoisted(() => ({
  available: [] as Array<Record<string, unknown>>,
  installed: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/skills", () => ({
  skills: {
    readContent: mockReadContent,
    fetchContent: mockFetchContent,
  },
}));

vi.mock("@/stores/skills.store", () => ({
  skillsStore: {
    get available() {
      return mockSkillsState.available;
    },
    get installed() {
      return mockSkillsState.installed;
    },
    install: mockInstall,
    attachSkillToThread: mockAttachSkillToThread,
    getThreadSkills: mockGetThreadSkills,
  },
}));

function resetSkillStoreMocks(): void {
  mockSkillsState.available = [];
  mockSkillsState.installed = [];
  mockInstall.mockReset();
  mockAttachSkillToThread.mockReset();
  mockGetThreadSkills.mockReset();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeSkillDragPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSkillStoreMocks();
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
    resetSkillStoreMocks();
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

interface FakeDataTransferInit {
  data?: Record<string, string>;
  types?: string[];
}

function fakeDragEvent(init: FakeDataTransferInit = {}): DragEvent {
  const data = init.data ?? {};
  const declaredTypes = init.types ?? Object.keys(data);
  const dataTransfer = {
    types: declaredTypes,
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
  return { dataTransfer } as unknown as DragEvent;
}

describe("skillDragPayload priority", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetSkillStoreMocks();
    const { setCurrentSkillDragPayload } = await import("@/lib/skill-drag");
    setCurrentSkillDragPayload(null);
  });

  it("prefers the MIME payload over a stale module-level signal", async () => {
    const { setCurrentSkillDragPayload, skillDragPayload, SKILL_DRAG_MIME } =
      await import("@/lib/skill-drag");
    setCurrentSkillDragPayload({ id: "stale:from-prior-drag" });
    const event = fakeDragEvent({
      data: { [SKILL_DRAG_MIME]: JSON.stringify({ id: "fresh:demo" }) },
    });
    expect(skillDragPayload(event)).toMatchObject({ id: "fresh:demo" });
  });

  it("falls back to text/plain prefix when MIME slot is empty", async () => {
    const { encodeSkillDragText, skillDragPayload } = await import(
      "@/lib/skill-drag"
    );
    const event = fakeDragEvent({
      data: {
        "text/plain": encodeSkillDragText({ id: "seren:demo", slug: "demo" }),
      },
    });
    expect(skillDragPayload(event)).toMatchObject({ id: "seren:demo" });
  });

  it("ignores a non-prefixed text/plain payload", async () => {
    const { skillDragPayload } = await import("@/lib/skill-drag");
    const event = fakeDragEvent({
      data: { "text/plain": JSON.stringify({ id: "seren:demo" }) },
    });
    expect(skillDragPayload(event)).toBeNull();
  });

  it("uses the signal only when dataTransfer carries no payload", async () => {
    const { setCurrentSkillDragPayload, skillDragPayload } = await import(
      "@/lib/skill-drag"
    );
    setCurrentSkillDragPayload({ id: "fallback:demo" });
    const event = fakeDragEvent();
    expect(skillDragPayload(event)).toMatchObject({ id: "fallback:demo" });
  });

  it("returns null after the drop handler clears the signal", async () => {
    const { setCurrentSkillDragPayload, skillDragPayload } = await import(
      "@/lib/skill-drag"
    );
    setCurrentSkillDragPayload({ id: "seren:demo" });
    setCurrentSkillDragPayload(null);
    expect(skillDragPayload(fakeDragEvent())).toBeNull();
  });
});

describe("canAcceptSkillDrop", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetSkillStoreMocks();
    const { setCurrentSkillDragPayload } = await import("@/lib/skill-drag");
    setCurrentSkillDragPayload(null);
  });

  it("accepts when the MIME type is declared on dataTransfer", async () => {
    const { canAcceptSkillDrop, SKILL_DRAG_MIME } = await import(
      "@/lib/skill-drag"
    );
    const event = fakeDragEvent({ types: [SKILL_DRAG_MIME] });
    expect(canAcceptSkillDrop(event)).toBe(true);
  });

  it("rejects an unrelated text/plain drag", async () => {
    const { canAcceptSkillDrop } = await import("@/lib/skill-drag");
    const event = fakeDragEvent({
      data: { "text/plain": "just some prose the user dragged in" },
    });
    expect(canAcceptSkillDrop(event)).toBe(false);
  });

  it("falls back to the signal only when no skill type is declared", async () => {
    const { canAcceptSkillDrop, setCurrentSkillDragPayload } = await import(
      "@/lib/skill-drag"
    );
    setCurrentSkillDragPayload({ id: "seren:demo" });
    expect(canAcceptSkillDrop(fakeDragEvent())).toBe(true);
  });

  it("does not accept once the signal is cleared and no MIME match exists", async () => {
    const { canAcceptSkillDrop, setCurrentSkillDragPayload } = await import(
      "@/lib/skill-drag"
    );
    setCurrentSkillDragPayload({ id: "seren:demo" });
    setCurrentSkillDragPayload(null);
    expect(canAcceptSkillDrop(fakeDragEvent())).toBe(false);
  });
});

describe("draftSkillInvocationFromDrag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSkillStoreMocks();
  });

  it("installs a catalog skill before drafting it into a thread composer", async () => {
    const skill = {
      id: "seren:demo",
      slug: "demo",
      name: "Demo",
      description: "",
      source: "seren",
      sourceUrl: "seren-skills:demo",
      tags: [],
    };
    const installed = {
      ...skill,
      id: "local:demo",
      source: "local",
      scope: "seren",
      skillsDir: "/skills",
      dirName: "demo",
      path: "/skills/demo/SKILL.md",
      installedAt: 1,
      enabled: true,
      contentHash: "hash",
    };
    mockSkillsState.available = [skill];
    mockFetchContent.mockResolvedValueOnce("# Demo");
    mockInstall.mockResolvedValueOnce(installed);
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "CustomEvent",
      class TestCustomEvent<T = unknown> extends Event {
        detail: T;

        constructor(type: string, init?: CustomEventInit<T>) {
          super(type);
          this.detail = init?.detail as T;
        }
      },
    );

    const { draftSkillInvocationFromDrag } = await import("@/lib/skill-drag");
    const result = await draftSkillInvocationFromDrag(
      { id: "seren:demo", slug: "demo", sourceUrl: "seren-skills:demo" },
      { kind: "chat", threadId: "thread-1" },
    );

    expect(mockFetchContent).toHaveBeenCalledWith(skill);
    expect(mockInstall).toHaveBeenCalledWith(skill, "# Demo", "seren");
    expect(mockAttachSkillToThread).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe("seren:run-skill");
    expect(event.detail).toMatchObject({
      kind: "chat",
      threadId: "thread-1",
      skill: { slug: "demo", path: "/skills/demo/SKILL.md" },
    });
    expect(result).toMatchObject({ installed: true });
  });
});
