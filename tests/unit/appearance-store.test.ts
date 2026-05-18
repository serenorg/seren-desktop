// ABOUTME: Covers appearance persistence reconciliation and write ordering.
// ABOUTME: Protects first-paint cache hydration from drifting away from Tauri store.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: mocks.isTauriRuntime,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

function installLocalStorage() {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, String(value));
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
  });
  return storage;
}

function installTauriInvokeBridge() {
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      invoke: mocks.invoke,
    },
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (lastError) throw lastError;
}

describe("appearance store persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocks.invoke.mockReset();
    mocks.isTauriRuntime.mockReturnValue(true);
  });

  it("mirrors canonical Tauri appearance into the synchronous localStorage cache", async () => {
    const storage = installLocalStorage();
    installTauriInvokeBridge();
    const canonical = {
      theme: "light",
      chatFontSize: "xl",
      threadListFontSize: "l",
      terminalFontSize: 17,
      density: "spacious",
    };
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (
        command === "get_setting" &&
        typeof args === "object" &&
        args !== null &&
        "store" in args &&
        args.store === "appearance.json"
      ) {
        return JSON.stringify(canonical);
      }
      return null;
    });

    const { appearanceState, loadAppearance } = await import(
      "@/stores/appearance.store"
    );

    await loadAppearance();

    expect(appearanceState.appearance).toEqual(canonical);
    expect(JSON.parse(storage.get("seren_appearance") ?? "null")).toEqual(
      canonical,
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "set_setting",
      expect.anything(),
    );
  });

  it("does not let an async load overwrite a user change made while loading", async () => {
    const storage = installLocalStorage();
    installTauriInvokeBridge();
    let resolveRead: (value: string) => void = () => {};
    mocks.invoke.mockImplementation((command: string, args: unknown) => {
      if (
        command === "get_setting" &&
        typeof args === "object" &&
        args !== null &&
        "store" in args &&
        args.store === "appearance.json"
      ) {
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      }
      return Promise.resolve(null);
    });

    const { appearanceState, appearanceStore, loadAppearance } = await import(
      "@/stores/appearance.store"
    );

    const loading = loadAppearance();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "get_setting",
        expect.objectContaining({ store: "appearance.json" }),
      ),
    );
    appearanceStore.set("theme", "light");
    resolveRead(
      JSON.stringify({
        theme: "dark",
        chatFontSize: "s",
        threadListFontSize: "s",
        terminalFontSize: 11,
        density: "compact",
      }),
    );
    await loading;

    expect(appearanceState.appearance.theme).toBe("light");
    expect(JSON.parse(storage.get("seren_appearance") ?? "{}").theme).toBe(
      "light",
    );
  });

  it("serializes rapid writes so the final Tauri write is the latest appearance", async () => {
    installLocalStorage();
    installTauriInvokeBridge();
    const writes: Array<Record<string, unknown>> = [];
    const resolvers: Array<() => void> = [];
    mocks.invoke.mockImplementation((command: string, args: unknown) => {
      if (
        command === "set_setting" &&
        typeof args === "object" &&
        args !== null &&
        "value" in args &&
        typeof args.value === "string"
      ) {
        writes.push(JSON.parse(args.value));
        return new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      }
      return Promise.resolve(null);
    });

    const { appearanceStore } = await import("@/stores/appearance.store");

    appearanceStore.set("theme", "light");
    await waitFor(() => expect(writes).toHaveLength(1));

    appearanceStore.set("density", "compact");
    appearanceStore.set("theme", "system");
    resolvers[0]?.();

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({
      theme: "system",
      density: "compact",
    });
  });
});
