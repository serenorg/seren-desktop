// ABOUTME: Guards Mac platform detection against webview navigator.platform drift.
// ABOUTME: Pins the "macOS" lowercase case that broke mac-only keybindings.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacPlatform, isWindowsPlatform } from "@/lib/platform";

function stubNavigator(platform: string, userAgent = ""): void {
  vi.stubGlobal("navigator", { platform, userAgent });
}

describe("isMacPlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches the lowercase 'macOS' platform reported by WKWebview", () => {
    stubNavigator("macOS");
    expect(isMacPlatform()).toBe(true);
  });

  it("matches the historical 'MacIntel' platform", () => {
    stubNavigator("MacIntel");
    expect(isMacPlatform()).toBe(true);
  });

  it("falls back to userAgent when platform is blank", () => {
    stubNavigator("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(isMacPlatform()).toBe(true);
  });

  it("returns false on non-Apple platforms", () => {
    stubNavigator("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(isMacPlatform()).toBe(false);
  });

  it("returns false when navigator is unavailable", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isMacPlatform()).toBe(false);
  });
});

describe("isWindowsPlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches the platforms WebView2 reports", () => {
    for (const platform of ["Win32", "Win64", "Windows"]) {
      stubNavigator(platform, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
      expect(isWindowsPlatform()).toBe(true);
    }
  });

  it("falls back to userAgent when platform is blank", () => {
    stubNavigator("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(isWindowsPlatform()).toBe(true);
  });

  it("does not match Darwin on the trailing 'win'", () => {
    stubNavigator("Darwin", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(isWindowsPlatform()).toBe(false);
  });

  it("reports false for the Mac and Linux webviews", () => {
    stubNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(isWindowsPlatform()).toBe(false);
    stubNavigator("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
    expect(isWindowsPlatform()).toBe(false);
  });

  it("returns false when navigator is unavailable", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isWindowsPlatform()).toBe(false);
  });
});
