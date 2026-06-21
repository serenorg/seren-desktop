// ABOUTME: Source-level guard for centralized workspace and terminal pane shortcuts.
// ABOUTME: Ensures runtime handlers, visible hints, and settings use the keybinding registry.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf-8");
}

const appShellSource = source("src/components/layout/AppShell.tsx");
const workspaceBarSource = source("src/components/layout/WorkspaceBar.tsx");
const keybindingsSource = source("src/stores/keybindings.store.ts");
const shortcutsSource = source("src/lib/shortcuts.ts");
const settingsPanelSource = source("src/components/settings/SettingsPanel.tsx");
const keybindingsSettingsSource = source(
  "src/components/settings/KeybindingsSettings.tsx",
);

describe("workspace terminal shortcuts", () => {
  it("routes workspace and pane shortcuts through the keybinding registry", () => {
    expect(appShellSource).toContain("createKeybindingMatcher");
    expect(appShellSource).toContain("WORKSPACE_KEYBINDING_ACTIONS");
    expect(appShellSource).toContain("data-keybinding-recorder");
    expect(appShellSource).toContain("keybindingRecording");
    expect(appShellSource).toContain("workspaceStore.activeWindow === null");
    expect(appShellSource).toContain("workspaceStore.activeWindow.kind === null");
    expect(shortcutsSource).toContain("keybindingRecording");
    expect(appShellSource).toContain('"pane.focusLeft"');
    expect(appShellSource).toContain('"pane.focusRight"');
    expect(appShellSource).toContain('"pane.focusUp"');
    expect(appShellSource).toContain('"pane.focusDown"');
    expect(appShellSource).toContain('"pane.focusPrevious"');
    expect(appShellSource).toContain('"pane.focusNext"');
    expect(appShellSource).toContain('"pane.splitRight"');
    expect(appShellSource).toContain('"pane.splitDown"');
    expect(appShellSource).toContain('"pane.close"');
  });

  it("wires the new workspace-cycle, zoom, and resize pane actions", () => {
    expect(appShellSource).toContain('"workspace.next"');
    expect(appShellSource).toContain('"workspace.previous"');
    expect(appShellSource).toContain("cycleWorkspace(1)");
    expect(appShellSource).toContain('"pane.zoom"');
    expect(appShellSource).toContain("toggleZoomFocusedPane()");
    expect(appShellSource).toContain('"pane.resizeLeft"');
    expect(appShellSource).toContain('resizeFocusedPane("left")');
    expect(keybindingsSource).toContain('id: "pane.zoom"');
    expect(keybindingsSource).toContain('id: "workspace.next"');
    expect(keybindingsSource).toContain('id: "global.newTerminal"');
  });

  it("only swallows close-panel when a panel is actually open", () => {
    expect(shortcutsSource).toContain("consumed !== false");
    expect(appShellSource).toContain("if (!slidePanel()) return false;");
  });

  it("defines terminal and direct pane defaults in the registry", () => {
    expect(keybindingsSource).toContain('id: "pane.focusLeft"');
    expect(keybindingsSource).toContain('key: "ArrowLeft"');
    expect(keybindingsSource).toContain("alt: true");
    expect(keybindingsSource).toContain('id: "pane.splitRight"');
    expect(keybindingsSource).toContain('key: "d"');
    expect(keybindingsSource).toContain('key: "o"');
    expect(keybindingsSource).toContain('id: "pane.splitDown"');
    expect(keybindingsSource).toContain('key: "e"');
    expect(keybindingsSource).toContain('id: "pane.focusPrevious"');
    expect(keybindingsSource).toContain(
      'defaults: [{ sequence: [{ mod: true, key: "[" }] }]',
    );
    expect(keybindingsSource).toContain('id: "pane.focusNext"');
    expect(keybindingsSource).toContain(
      'defaults: [{ sequence: [{ mod: true, key: "]" }] }]',
    );
  });

  it("adds shared bracket aliases for cycling workspaces", () => {
    expect(keybindingsSource).toContain('id: "workspace.next"');
    expect(keybindingsSource).toContain(
      '{ sequence: [{ mod: true, shift: true, key: "]" }] }',
    );
    expect(keybindingsSource).toContain('id: "workspace.previous"');
    expect(keybindingsSource).toContain(
      '{ sequence: [{ mod: true, shift: true, key: "[" }] }',
    );
  });

  it("uses registry labels for visible workspace bar split hints", () => {
    expect(workspaceBarSource).toContain("getKeybindingLabel");
    expect(workspaceBarSource).toContain('"pane.splitRight"');
    expect(workspaceBarSource).toContain('"pane.splitDown"');
  });

  it("adds editable shortcuts settings backed by the same registry", () => {
    expect(settingsPanelSource).toContain('"shortcuts"');
    expect(settingsPanelSource).toContain("<KeybindingsSettings />");
    expect(settingsPanelSource).toContain("resetAllKeybindings()");
    expect(keybindingsSettingsSource).toContain("setKeybindingBindings");
    expect(keybindingsSettingsSource).toContain("resetKeybinding");
    expect(keybindingsSettingsSource).toContain("eventToKeyStroke");
    expect(keybindingsSettingsSource).toContain("data-keybinding-recorder");
    expect(keybindingsSettingsSource).toContain("keybindingRecording");
    expect(keybindingsSettingsSource).toContain("AddShortcutButton");
    expect(keybindingsSettingsSource).toContain('title="Add shortcut"');
    expect(keybindingsSettingsSource).toContain(
      "Default shortcut cannot be removed",
    );
    expect(keybindingsSettingsSource).toContain("Reset shortcut to default");
    expect(keybindingsSettingsSource).toContain("Workspace Switching");
    expect(keybindingsSettingsSource).toContain("Pane Navigation");
    expect(keybindingsSettingsSource).toContain("Pane Layout");
    expect(keybindingsSettingsSource).toContain("grid-cols-[repeat(auto-fit");
  });
});
