// ABOUTME: Covers the centralized keybinding registry defaults and overrides.
// ABOUTME: Guards terminal-safe shortcuts and direct pane focus matching.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearKeybinding,
  createKeybindingMatcher,
  getKeybindingBindings,
  getKeybindingLabel,
  keybindingConflicts,
  loadKeybindings,
  resetAllKeybindings,
  resetKeybinding,
  setKeybindingBindings,
  setKeybindingOverride,
} from "@/stores/keybindings.store";

function key(
  value: string,
  modifiers: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

describe("keybindings store", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    resetAllKeybindings();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("uses terminal-safe split defaults for the current platform", () => {
    const splitRight = getKeybindingLabel("pane.splitRight", {
      terminalPaneFocused: true,
    });
    const splitDown = getKeybindingLabel("pane.splitDown", {
      terminalPaneFocused: true,
    });

    expect(splitRight).toContain(splitRight.includes("Cmd") ? "Cmd+D" : "Ctrl+Shift+D");
    expect(splitDown).toContain(
      splitDown.includes("Cmd") ? "Cmd+Shift+D" : "Ctrl+Shift+E",
    );
    expect(splitRight).not.toContain("Ctrl+D");
  });

  it("supports override, clear, and reset for a binding", () => {
    setKeybindingOverride("pane.splitRight", [
      { mod: true, alt: true, key: "s" },
    ]);
    expect(getKeybindingLabel("pane.splitRight")).toMatch(
      /^(Cmd\+Option|Ctrl\+Alt)\+S$/,
    );

    clearKeybinding("pane.splitRight");
    expect(getKeybindingLabel("pane.splitRight")).toBe("");

    resetKeybinding("pane.splitRight");
    expect(getKeybindingLabel("pane.splitRight")).toMatch(/^(Cmd|Ctrl)\+\\/);
  });

  it("supports multiple override bindings for one action", () => {
    setKeybindingBindings("pane.splitRight", [
      { sequence: [{ mod: true, alt: true, key: "s" }] },
      { sequence: [{ mod: true, shift: true, key: "s" }] },
    ]);

    const label = getKeybindingLabel("pane.splitRight");
    expect(label).toMatch(/(Cmd\+Option|Ctrl\+Alt)\+S/);
    expect(label).toMatch(/(Cmd|Ctrl)\+Shift\+S/);

    const matcher = createKeybindingMatcher(["pane.splitRight"]);
    const usesMeta = label.includes("Cmd");
    const mod = usesMeta ? { metaKey: true } : { ctrlKey: true };

    expect(
      matcher.handleEvent(key("s", { ...mod, altKey: true })),
    ).toEqual({
      kind: "matched",
      action: "pane.splitRight",
    });
    expect(
      matcher.handleEvent(key("s", { ...mod, shiftKey: true })),
    ).toEqual({
      kind: "matched",
      action: "pane.splitRight",
    });
  });

  it("preserves binding scope when overriding scoped aliases", () => {
    const scopedBinding = {
      sequence: [{ mod: true, alt: true, key: "s" }],
      context: "terminal" as const,
    };
    setKeybindingBindings("pane.splitRight", [scopedBinding]);

    expect(
      getKeybindingLabel("pane.splitRight", { terminalPaneFocused: false }),
    ).toBe("");
    expect(
      getKeybindingLabel("pane.splitRight", { terminalPaneFocused: true }),
    ).not.toBe("");
  });

  it("matches split aliases regardless of focused pane kind", () => {
    const matcher = createKeybindingMatcher(
      ["pane.splitRight", "pane.splitDown"],
      () => ({ terminalPaneFocused: false }),
    );
    const usesMeta = getKeybindingLabel("pane.splitRight", {
      terminalPaneFocused: false,
    }).includes("Cmd");
    const mod = usesMeta ? { metaKey: true } : { ctrlKey: true };

    expect(matcher.handleEvent(key("d", mod))).toEqual({
      kind: usesMeta ? "matched" : "none",
      ...(usesMeta ? { action: "pane.splitRight" as const } : {}),
    });
    expect(
      matcher.handleEvent(key("d", { ...mod, shiftKey: true })),
    ).toEqual({
      kind: "matched",
      action: usesMeta ? "pane.splitDown" : "pane.splitRight",
    });
  });

  it("loads legacy and malformed stored overrides defensively", async () => {
    vi.mocked(globalThis.localStorage.getItem).mockReturnValue(
      JSON.stringify({
        overrides: {
          "pane.splitRight": {
            sequence: [{ mod: true, alt: true, key: "s" }],
          },
          "pane.splitDown": {
            bindings: [
              null,
              { sequence: "bad" },
              {
                sequence: [{ mod: true, key: "x" }],
                context: "unknown",
              },
            ],
          },
        },
      }),
    );

    await loadKeybindings();

    expect(getKeybindingLabel("pane.splitRight")).toMatch(
      /^(Cmd\+Option|Ctrl\+Alt)\+S$/,
    );
    expect(getKeybindingLabel("pane.splitDown")).toMatch(/^(Cmd|Ctrl)\+X$/);
  });

  it("detects conflicts across split aliases", () => {
    const terminalAlias = getKeybindingBindings("pane.splitRight", {
      terminalPaneFocused: false,
    }).find((binding) =>
      keybindingConflicts("global.focusChat", binding.sequence).some(
        (definition) => definition.id === "pane.splitRight",
      ),
    );
    expect(terminalAlias).toBeDefined();

    const conflicts = keybindingConflicts(
      "global.focusChat",
      terminalAlias?.sequence ?? [],
    );

    expect(conflicts.some((definition) => definition.id === "pane.splitRight"))
      .toBe(true);
  });

  it("matches direct pane focus defaults", () => {
    const matcher = createKeybindingMatcher(["pane.focusLeft"], () => ({
      terminalPaneFocused: false,
    }));
    const usesMeta = getKeybindingLabel("pane.focusLeft").includes("Cmd");
    const mod = usesMeta ? { metaKey: true } : { ctrlKey: true };

    expect(
      matcher.handleEvent(key("ArrowLeft", { ...mod, altKey: true })),
    ).toEqual({
      kind: "matched",
      action: "pane.focusLeft",
    });
    expect(matcher.handleEvent(key("k", mod))).toEqual({ kind: "none" });
  });

  it("keeps tab workspace cycling and shared bracket workspace aliases", () => {
    const nextLabel = getKeybindingLabel("workspace.next");
    const previousLabel = getKeybindingLabel("workspace.previous");
    const usesMeta = nextLabel.includes("Cmd+Shift+]");
    const mod = usesMeta ? { metaKey: true } : { ctrlKey: true };
    const matcher = createKeybindingMatcher([
      "workspace.next",
      "workspace.previous",
    ]);

    expect(nextLabel).toContain("Ctrl+Tab");
    expect(previousLabel).toContain("Ctrl+Shift+Tab");
    expect(nextLabel).toContain(usesMeta ? "Cmd+Shift+]" : "Ctrl+Shift+]");
    expect(previousLabel).toContain(
      usesMeta ? "Cmd+Shift+[" : "Ctrl+Shift+[",
    );

    expect(matcher.handleEvent(key("Tab", { ctrlKey: true }))).toEqual({
      kind: "matched",
      action: "workspace.next",
    });
    expect(
      matcher.handleEvent(key("Tab", { ctrlKey: true, shiftKey: true })),
    ).toEqual({
      kind: "matched",
      action: "workspace.previous",
    });
    expect(
      matcher.handleEvent(key("]", { ...mod, shiftKey: true })),
    ).toEqual({
      kind: "matched",
      action: "workspace.next",
    });
    expect(
      matcher.handleEvent(key("[", { ...mod, shiftKey: true })),
    ).toEqual({
      kind: "matched",
      action: "workspace.previous",
    });
  });

  it("still supports custom multi-stroke overrides", () => {
    setKeybindingOverride("pane.focusLeft", [
      { mod: true, key: "k" },
      { mod: true, key: "ArrowLeft" },
    ]);
    const matcher = createKeybindingMatcher(["pane.focusLeft"], () => ({
      terminalPaneFocused: false,
    }));
    const usesMeta = getKeybindingLabel("pane.focusLeft").includes("Cmd");
    const mod = usesMeta ? { metaKey: true } : { ctrlKey: true };

    expect(matcher.handleEvent(key("k", mod))).toEqual({ kind: "pending" });
    expect(matcher.handleEvent(key("ArrowLeft", mod))).toEqual({
      kind: "matched",
      action: "pane.focusLeft",
    });
  });
});
