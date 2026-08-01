// ABOUTME: Protects the validation app-ready walkthrough from passing on the root loading fallback.
// ABOUTME: Verifies shell readiness is required before walkthrough evidence is captured.

import { describe, expect, it, vi } from "vitest";
import type { ScenarioContext } from "../../scripts/validate-walkthrough";
import runAppReady from "../validation/scenarios/app-ready";

describe("validation app-ready scenario", () => {
  it("waits for the mounted application shell before capturing evidence", async () => {
    const calls: string[] = [];
    const client = {
      waitFor: vi.fn(async (selector: string) => {
        calls.push(`waitFor:${selector}`);
      }),
      dumpText: vi.fn(async () => {
        calls.push("dumpText");
        return { text: "Sign In" };
      }),
      screenshot: vi.fn(async () => {
        calls.push("screenshot");
        return { rasterSuccess: true };
      }),
      nativeScreenshot: vi.fn(async () => {
        calls.push("nativeScreenshot");
        return { rasterSuccess: true };
      }),
    } as unknown as ScenarioContext["client"];
    const writeArtifact = vi.fn(async () => undefined);

    await runAppReady({
      client,
      artifactsDir: "/unused",
      validationHome: "/unused",
      writeArtifact,
    });

    expect(client.waitFor).toHaveBeenCalledWith(
      "[data-testid='thread-sidebar']",
      30_000,
    );
    expect(calls).toEqual([
      "waitFor:[data-testid='thread-sidebar']",
      "dumpText",
      "screenshot",
      "nativeScreenshot",
    ]);
  });
});
