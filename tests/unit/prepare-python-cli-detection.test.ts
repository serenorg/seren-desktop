// ABOUTME: Regression test for serenorg/seren-desktop#2053.
// ABOUTME: Asserts the Python prepare script detects CLI invocation on Windows.

import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

import { isInvokedAsCli } from "../../build/win32/prepare-python-runtime";

describe("prepare-python-runtime CLI detection (regression #2053)", () => {
  // Before the fix, the script gated its CLI body on
  //   import.meta.url === `file://${process.argv[1]}`
  // which on Windows compared `file:///D:/a/.../prepare-python-runtime.ts`
  // (POSIX, three slashes) to `file://D:\a\...\prepare-python-runtime.ts`
  // (backslashes, two slashes, drive letter parsed as host). The strings
  // never matched, so `pnpm prepare:python:win32-x64` exited as a no-op,
  // the installer shipped without `python.exe`, and the runtime health
  // check fired for every Windows user. This single assertion locks the
  // contract: a backslash Windows path must resolve as "invoked as CLI".
  it("matches when argv[1] is a Windows-style backslash path", () => {
    const winArgv =
      "D:\\a\\seren-desktop\\seren-desktop\\build\\win32\\prepare-python-runtime.ts";
    expect(isInvokedAsCli(pathToFileURL(winArgv).href, winArgv)).toBe(true);
  });
});
