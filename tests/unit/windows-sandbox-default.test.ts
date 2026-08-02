// ABOUTME: Guards that a Windows install can always launch an agent on first run.
// ABOUTME: Bounded modes have no working backend there, so they must resolve to one that runs.

import { afterEach, describe, expect, it, vi } from "vitest";

async function withPlatform<T>(
  platform: string,
  run: (mod: typeof import("@/stores/settings.store")) => T | Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    vi.resetModules();
    const mod = await import("@/stores/settings.store");
    return await run(mod);
  } finally {
    if (original) Object.defineProperty(navigator, "platform", original);
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("agent sandbox mode per platform", () => {
  it("defaults Windows to the only mode that can launch", async () => {
    await withPlatform("Win32", ({ defaultAgentSandboxMode }) => {
      expect(defaultAgentSandboxMode()).toBe("full-access");
    });
  });

  it("keeps real containment as the default off Windows", async () => {
    for (const platform of ["MacIntel", "Linux x86_64"]) {
      await withPlatform(platform, ({ defaultAgentSandboxMode }) => {
        expect(defaultAgentSandboxMode()).toBe("workspace-write");
      });
    }
  });

  it("resolves an unlaunchable stored Windows preference to one that runs", async () => {
    await withPlatform("Win32", ({ resolveAgentSandboxMode }) => {
      // These are the values an upgrader carries in from an older build.
      expect(resolveAgentSandboxMode("workspace-write")).toBe("full-access");
      expect(resolveAgentSandboxMode("read-only")).toBe("full-access");
      expect(resolveAgentSandboxMode("full-access")).toBe("full-access");
    });
  });

  it("never rewrites a bounded preference where containment works", async () => {
    for (const platform of ["MacIntel", "Linux x86_64"]) {
      await withPlatform(platform, ({ resolveAgentSandboxMode }) => {
        expect(resolveAgentSandboxMode("workspace-write")).toBe(
          "workspace-write",
        );
        expect(resolveAgentSandboxMode("read-only")).toBe("read-only");
      });
    }
  });
});
