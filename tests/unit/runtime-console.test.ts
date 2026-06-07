// ABOUTME: Regression coverage for the opt-in verbose runtime console switch.
// ABOUTME: Keeps routine success breadcrumbs out of the default production console.

import { describe, expect, it, vi } from "vitest";
import {
  RUNTIME_VERBOSE_CONSOLE_KEY,
  shouldLogVerboseRuntimeConsole,
  verboseRuntimeConsole,
} from "@/lib/runtime-console";

function storageWith(value: string | null): Pick<Storage, "getItem"> {
  return {
    getItem(key: string) {
      return key === RUNTIME_VERBOSE_CONSOLE_KEY ? value : null;
    },
  };
}

describe("verbose runtime console logging", () => {
  it("is disabled by default", () => {
    expect(shouldLogVerboseRuntimeConsole(storageWith(null))).toBe(false);
    expect(shouldLogVerboseRuntimeConsole(storageWith("false"))).toBe(false);
  });

  it("accepts explicit localStorage truthy values", () => {
    expect(shouldLogVerboseRuntimeConsole(storageWith("true"))).toBe(true);
    expect(shouldLogVerboseRuntimeConsole(storageWith("1"))).toBe(true);
    expect(shouldLogVerboseRuntimeConsole(storageWith("on"))).toBe(true);
  });

  it("does not write to the console unless enabled", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    verboseRuntimeConsole.debugWithStorage(storageWith(null), "quiet");
    expect(debug).not.toHaveBeenCalled();

    verboseRuntimeConsole.debugWithStorage(storageWith("true"), "visible");
    expect(debug).toHaveBeenCalledWith("visible");

    debug.mockRestore();
  });
});
