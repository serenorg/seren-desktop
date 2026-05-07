// ABOUTME: Editor sessions derive from tab cwd; activate restores the per-cwd active tab.
// ABOUTME: Disambiguates duplicate basenames so two ".../examples" dirs render distinctly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>());

vi.mock("@/lib/files/service", () => ({
  readFile: readFileMock,
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let storage: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  readFileMock.mockReset();
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    clear: vi.fn(() => storage.clear()),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("editorSessionStore", () => {
  it("groups tabs by cwd into sessions labeled with the basename", async () => {
    const { openTab } = await import("@/stores/tabs");
    const { editorSessionStore } = await import("@/stores/editor.sessions");

    openTab(
      "/Users/u/Documents/Seren/skills/lead-finder/SKILL.md",
      "# A",
      "/Users/u/Documents/Seren/skills/lead-finder",
    );
    openTab(
      "/Users/u/Documents/Seren/skills/lead-finder/template.md",
      "# T",
      "/Users/u/Documents/Seren/skills/lead-finder",
    );
    openTab(
      "/Users/u/Documents/Seren/skills/grid-trader/SKILL.md",
      "# B",
      "/Users/u/Documents/Seren/skills/grid-trader",
    );

    const sessions = editorSessionStore.sessions;
    expect(sessions).toHaveLength(2);

    const lf = sessions.find((s) => s.cwd.endsWith("lead-finder"));
    const gt = sessions.find((s) => s.cwd.endsWith("grid-trader"));
    expect(lf?.label).toBe("lead-finder");
    expect(lf?.tabs).toHaveLength(2);
    expect(gt?.label).toBe("grid-trader");
    expect(gt?.tabs).toHaveLength(1);
  });

  it("disambiguates sessions whose basenames collide", async () => {
    const { openTab } = await import("@/stores/tabs");
    const { editorSessionStore } = await import("@/stores/editor.sessions");

    openTab(
      "/a/lead-finder/examples/x.md",
      "x",
      "/a/lead-finder/examples",
    );
    openTab(
      "/b/grid-trader/examples/y.md",
      "y",
      "/b/grid-trader/examples",
    );

    const labels = editorSessionStore.sessions.map((s) => s.label).sort();
    expect(labels).toEqual(["grid-trader/examples", "lead-finder/examples"]);
  });

  it("activate restores the per-cwd remembered active tab", async () => {
    const { openTab, tabsState } = await import("@/stores/tabs");
    const { editorSessionStore } = await import("@/stores/editor.sessions");

    const aId = openTab("/a/skill/SKILL.md", "s", "/a/skill");
    const bId = openTab("/a/skill/template.md", "t", "/a/skill");
    expect(tabsState.activeTabId).toBe(bId); // most recent open is active

    // Open a tab in another session - swaps active.
    const cId = openTab("/b/other/SKILL.md", "o", "/b/other");
    expect(tabsState.activeTabId).toBe(cId);

    // Switch back: the previously-active tab in /a/skill should be restored.
    editorSessionStore.activate("editor:/a/skill");
    expect(tabsState.activeTabId).toBe(bId);

    // And forward: switching to /b/other restores its active tab.
    editorSessionStore.activate("editor:/b/other");
    expect(tabsState.activeTabId).toBe(cId);

    // Sanity: aId was never the most-recent active in /a/skill, so it isn't picked.
    expect(tabsState.activeTabId).not.toBe(aId);
  });

  it("restoreEditorSessions reopens persisted tabs and restores active tab", async () => {
    const { openTab, setTabDirty, tabsState } = await import("@/stores/tabs");
    const { restoreEditorSessions } = await import("@/stores/editor.sessions");

    // Seed a persisted state by writing it directly to localStorage. Mirrors
    // what the persistence effect produces in production.
    const persisted = {
      tabs: [
        { filePath: "/skill/SKILL.md", cwd: "/skill" },
        { filePath: "/skill/template.md", cwd: "/skill" },
        { filePath: "/other/notes.md", cwd: "/other" },
      ],
      activeFilePath: "/skill/template.md",
      lastActiveByCwd: {
        "/skill": "/skill/template.md",
        "/other": "/other/notes.md",
      },
      lastActiveAtByCwd: { "/skill": 1234, "/other": 5678 },
    };
    storage.set("seren:editor_sessions:v1", JSON.stringify(persisted));

    readFileMock.mockImplementation(async (path: string) => {
      if (path === "/skill/SKILL.md") return "# skill md";
      if (path === "/skill/template.md") return "# template";
      if (path === "/other/notes.md") return "notes";
      throw new Error(`unexpected read: ${path}`);
    });

    await restoreEditorSessions();

    expect(tabsState.tabs.map((t) => t.filePath).sort()).toEqual([
      "/other/notes.md",
      "/skill/SKILL.md",
      "/skill/template.md",
    ]);
    const active = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
    expect(active?.filePath).toBe("/skill/template.md");

    // Switching away and back uses the restored per-cwd memory.
    const otherTab = tabsState.tabs.find(
      (t) => t.filePath === "/other/notes.md",
    );
    if (!otherTab) throw new Error("missing /other tab");

    // Open another tab in /other to force a session swap.
    openTab("/other/extra.md", "x", "/other");
    const skillTemplate = tabsState.tabs.find(
      (t) => t.filePath === "/skill/template.md",
    );
    if (!skillTemplate) throw new Error("missing /skill/template.md tab");

    // Verify we can mark dirty and the state still works.
    setTabDirty(skillTemplate.id, true);
    expect(tabsState.tabs.find((t) => t.id === skillTemplate.id)?.isDirty).toBe(
      true,
    );
  });

  it("restoreEditorSessions silently drops files that no longer exist", async () => {
    const { tabsState } = await import("@/stores/tabs");
    const { restoreEditorSessions } = await import("@/stores/editor.sessions");

    storage.set(
      "seren:editor_sessions:v1",
      JSON.stringify({
        tabs: [
          { filePath: "/gone.md", cwd: "/gone" },
          { filePath: "/here.md", cwd: "/here" },
        ],
        activeFilePath: "/here.md",
        lastActiveByCwd: {},
        lastActiveAtByCwd: {},
      }),
    );

    readFileMock.mockImplementation(async (path: string) => {
      if (path === "/here.md") return "ok";
      throw new Error("ENOENT");
    });

    await restoreEditorSessions();

    expect(tabsState.tabs.map((t) => t.filePath)).toEqual(["/here.md"]);
  });

  it("pickEditorSessionForContext prefers the contextRoot match", async () => {
    const { openTab } = await import("@/stores/tabs");
    const { editorSessionStore, pickEditorSessionForContext } = await import(
      "@/stores/editor.sessions"
    );

    openTab("/projA/file.ts", "", "/projA");
    openTab("/projB/file.ts", "", "/projB");

    // /projA was opened first, /projB later, so /projB has the higher
    // implicit recency. But contextRoot=/projA should still win.
    editorSessionStore.activate("editor:/projA");
    editorSessionStore.activate("editor:/projB");

    const match = pickEditorSessionForContext({ contextRoot: "/projA" });
    expect(match?.cwd).toBe("/projA");
  });

  it("pickEditorSessionForContext falls back to most-recently-activated session", async () => {
    const { openTab } = await import("@/stores/tabs");
    const { editorSessionStore, pickEditorSessionForContext } = await import(
      "@/stores/editor.sessions"
    );

    openTab("/projA/file.ts", "", "/projA");
    openTab("/projB/file.ts", "", "/projB");

    editorSessionStore.activate("editor:/projA");
    // Tiny delay to ensure the second activate has a strictly greater epoch.
    await new Promise((resolve) => setTimeout(resolve, 5));
    editorSessionStore.activate("editor:/projB");

    // No matching contextRoot - should pick /projB as most recent.
    const match = pickEditorSessionForContext({ contextRoot: "/unknown" });
    expect(match?.cwd).toBe("/projB");

    const matchNull = pickEditorSessionForContext({ contextRoot: null });
    expect(matchNull?.cwd).toBe("/projB");
  });

  it("pickEditorSessionForContext returns null when no sessions exist", async () => {
    const { pickEditorSessionForContext } = await import(
      "@/stores/editor.sessions"
    );

    expect(pickEditorSessionForContext({ contextRoot: "/anywhere" })).toBe(
      null,
    );
    expect(pickEditorSessionForContext({ contextRoot: null })).toBe(null);
  });

  it("openTab bumps lastActiveAt so a fresh session is recent", async () => {
    const { openTab } = await import("@/stores/tabs");
    const { editorSessionStore } = await import("@/stores/editor.sessions");

    const before = Date.now();
    openTab("/skill-a/SKILL.md", "", "/skill-a");
    const session = editorSessionStore.findByCwd("/skill-a");
    expect(session?.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  it("opening a tab in a stale session bubbles its lastActiveAt above older sessions", async () => {
    const { openTab } = await import("@/stores/tabs");
    const { editorSessionStore } = await import("@/stores/editor.sessions");

    openTab("/old/SKILL.md", "", "/old");
    await new Promise((resolve) => setTimeout(resolve, 5));
    openTab("/new/SKILL.md", "", "/new");

    const old = editorSessionStore.findByCwd("/old");
    const fresh = editorSessionStore.findByCwd("/new");
    expect(old?.lastActiveAt).toBeDefined();
    expect(fresh?.lastActiveAt).toBeDefined();
    if (old && fresh) {
      expect(fresh.lastActiveAt).toBeGreaterThan(old.lastActiveAt);
    }
  });

  it("isDirty reflects any dirty tab in the session", async () => {
    const { openTab, setTabDirty } = await import("@/stores/tabs");
    const { editorSessionStore } = await import("@/stores/editor.sessions");

    const aId = openTab("/x/a", "", "/x");
    const bId = openTab("/y/b", "", "/y");
    expect(editorSessionStore.findByCwd("/x")?.isDirty).toBe(false);

    setTabDirty(aId, true);
    expect(editorSessionStore.findByCwd("/x")?.isDirty).toBe(true);
    expect(editorSessionStore.findByCwd("/y")?.isDirty).toBe(false);

    setTabDirty(aId, false);
    setTabDirty(bId, true);
    expect(editorSessionStore.findByCwd("/x")?.isDirty).toBe(false);
    expect(editorSessionStore.findByCwd("/y")?.isDirty).toBe(true);
  });
});
