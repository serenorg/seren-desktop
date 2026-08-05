// ABOUTME: Guards #3693 — Windows .cmd CLI verification must quote paths with spaces.
// ABOUTME: Pins the composed shell command string and cli-updater's use of the shared helper.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shellArgsModule = new URL(
  "../../bin/browser-local/windows-shell-args.mjs",
  import.meta.url,
).href;
const { composeWindowsShellCommand } = await import(
  /* @vite-ignore */ shellArgsModule
);

describe("#3693 .cmd verification quoting", () => {
  it("quotes a .cmd path containing a space so cmd.exe runs one command, not two", () => {
    const cmdPath =
      "C:\\Users\\John Smith\\AppData\\Roaming\\Seren\\cli-tools\\claude.cmd";

    const composed = composeWindowsShellCommand(cmdPath, ["--version"]);

    expect(composed).toBe(`"${cmdPath}" "--version"`);
  });

  it("cli-updater routes every shell exec through the pre-composed command", () => {
    const updaterSource = readFileSync(
      new URL("../../bin/browser-local/cli-updater.mjs", import.meta.url),
      "utf8",
    );

    expect(updaterSource).toContain("composeWindowsShellCommand");
    // No exec site may hand an unquoted argv to cmd.exe's space-join.
    expect(updaterSource).not.toMatch(/shell:\s*process\.platform/);
    expect(updaterSource).not.toMatch(/shell:\s*onWindowsCmd/);
  });
});
