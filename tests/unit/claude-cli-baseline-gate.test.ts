// ABOUTME: Guards for #3443 — claude-code spawn must enforce the shared CLI version baseline.
// ABOUTME: Source wiring checks plus behavioral coverage of the gate's decision logic via its test seams.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/agent-registry.mjs",
  import.meta.url,
).href;
const { _ensureCliBaselineViaUpdater: ensureCliBaselineViaUpdater } =
  await import(/* @vite-ignore */ modulePath);

const agentRegistrySource = readFileSync(
  new URL("../../bin/browser-local/agent-registry.mjs", import.meta.url),
  "utf8",
);

const CLAUDE_BASELINE_CONFIG = {
  label: "Claude Code",
  bareCommand: "claude",
  packageName: "@anthropic-ai/claude-code",
};

type EmittedEvent = { name: string; payload: Record<string, unknown> };

function makeEmit(events: EmittedEvent[]) {
  return (name: string, payload: Record<string, unknown>) => {
    events.push({ name, payload });
  };
}

describe("#3443 claude-code spawn wiring enforces the baseline", () => {
  it("ensureClaudeCodeCli routes resolved installs through the shared gate", () => {
    const start = agentRegistrySource.indexOf(
      "async function ensureClaudeCodeCli",
    );
    const end = agentRegistrySource.indexOf(
      "export function resolveInstalledClaudeBinary",
    );
    const helper = agentRegistrySource.slice(start, end);

    expect(helper).toContain("ensureCliBaselineViaUpdater(emit");
    expect(helper).toContain('packageName: "@anthropic-ai/claude-code"');
    expect(helper).toContain("resolveBinary: resolveInstalledClaudeBinary");
    // A determinately stale custom PATH install is replaced by Seren's
    // verified managed copy without a manual update handoff.
    expect(helper).toContain("isBelowBaseline(installed, baseline)");
    expect(agentRegistrySource).toContain("installIfMissing: true");
    // A large JS CLI can outlive the version-probe timeout on a slow
    // machine; failing closed there turned a slow disk into "not
    // installed" and broke the v3.75.0 release gate (#3471).
    expect(helper).toContain("allowUnprobeableInstall: true");
  });
});

describe("#3443 shared baseline gate decision logic", () => {
  it("returns the resolved path without any update attempt at or above baseline", async () => {
    for (const version of ["2.1.197", "9.9.9"]) {
      const events: EmittedEvent[] = [];
      const updaterCalls: unknown[] = [];
      const result = await ensureCliBaselineViaUpdater(makeEmit(events), {
        ...CLAUDE_BASELINE_CONFIG,
        resolveBinary: () => "/fake/bin/claude",
        _runInstalledVersion: async () => version,
        _backgroundUpdateCli: async (options: unknown) => {
          updaterCalls.push(options);
          return { outcome: "success" };
        },
      });

      expect(result).toBe("/fake/bin/claude");
      expect(updaterCalls).toHaveLength(0);
      expect(events).toHaveLength(0);
    }
  });

  it("stays permissive when the version has a pre-release suffix", async () => {
    const events: EmittedEvent[] = [];
    const result = await ensureCliBaselineViaUpdater(makeEmit(events), {
      ...CLAUDE_BASELINE_CONFIG,
      resolveBinary: () => "/fake/bin/claude",
      _runInstalledVersion: async () => "2.2.0-beta.1",
      _backgroundUpdateCli: async () => {
        throw new Error("updater must not run");
      },
    });

    expect(result).toBe("/fake/bin/claude");
  });

  it("force-updates a below-baseline CLI and returns the refreshed path", async () => {
    const events: EmittedEvent[] = [];
    const versions = ["2.1.100", "2.1.200"];
    const updaterCalls: Array<Record<string, unknown>> = [];
    const result = await ensureCliBaselineViaUpdater(makeEmit(events), {
      ...CLAUDE_BASELINE_CONFIG,
      resolveBinary: () => "/fake/bin/claude",
      _runInstalledVersion: async () => versions.shift() ?? null,
      _backgroundUpdateCli: async (options: Record<string, unknown>) => {
        updaterCalls.push(options);
        return { outcome: "success" };
      },
    });

    expect(result).toBe("/fake/bin/claude");
    expect(updaterCalls).toHaveLength(1);
    expect(updaterCalls[0].force).toBe(true);
    expect(updaterCalls[0].packageName).toBe("@anthropic-ai/claude-code");
    const stages = events
      .filter((event) => event.name === "provider://cli-install-progress")
      .map((event) => event.payload.stage);
    expect(stages).toEqual(["installing", "complete"]);
  });

  it("fails closed when the updater cannot confirm the baseline offline", async () => {
    const events: EmittedEvent[] = [];
    await expect(
      ensureCliBaselineViaUpdater(makeEmit(events), {
        ...CLAUDE_BASELINE_CONFIG,
        resolveBinary: () => "/fake/bin/claude",
        _runInstalledVersion: async () => "2.1.100",
        _backgroundUpdateCli: async () => ({ outcome: "skipped:network" }),
      }),
    ).rejects.toThrow(/requires 2\.1\.197.*skipped:network/s);
  });

  it("fails closed when the update reports success but the binary is stale", async () => {
    const events: EmittedEvent[] = [];
    await expect(
      ensureCliBaselineViaUpdater(makeEmit(events), {
        ...CLAUDE_BASELINE_CONFIG,
        resolveBinary: () => "/fake/bin/claude",
        _runInstalledVersion: async () => "2.1.100",
        _backgroundUpdateCli: async () => ({ outcome: "success" }),
      }),
    ).rejects.toThrow(/still 2\.1\.100; Seren requires 2\.1\.197/);
  });

  it("automatically provisions a missing CLI with no action-required handoff (#3680)", async () => {
    const events: EmittedEvent[] = [];
    const updaterCalls: Array<Record<string, unknown>> = [];
    const resolved = ["claude", "/managed/bin/claude"];
    let versionCalls = 0;
    const result = await ensureCliBaselineViaUpdater(makeEmit(events), {
      ...CLAUDE_BASELINE_CONFIG,
      resolveBinary: () => resolved.shift() ?? "/managed/bin/claude",
      _runInstalledVersion: async () =>
        versionCalls++ === 0 ? null : "2.1.221",
      _backgroundUpdateCli: async (options: Record<string, unknown>) => {
        updaterCalls.push(options);
        return { outcome: "success" };
      },
    });

    expect(result).toBe("/managed/bin/claude");
    expect(updaterCalls).toHaveLength(1);
    expect(updaterCalls[0]).toMatchObject({
      force: true,
      installIfMissing: true,
    });
    expect(updaterCalls[0].installPrefix).toEqual(expect.any(String));
    expect(
      events.some(
        (event) => event.name === "provider://cli-update-action-required",
      ),
    ).toBe(false);
  });

  it("uses a verified first install when the updater's cold health probe times out (#3680)", async () => {
    const resolved = ["claude", "/managed/bin/claude"];
    let versionCalls = 0;
    const result = await ensureCliBaselineViaUpdater(makeEmit([]), {
      ...CLAUDE_BASELINE_CONFIG,
      resolveBinary: () => resolved.shift() ?? "/managed/bin/claude",
      _runInstalledVersion: async () =>
        versionCalls++ === 0 ? null : "2.1.221",
      _backgroundUpdateCli: async () => ({
        outcome: "skipped:verification_required",
      }),
    });

    expect(result).toBe("/managed/bin/claude");
  });

  it("spawns a resolved install permissively when the probe fails and the CLI opts in (#3471)", async () => {
    const events: EmittedEvent[] = [];
    const updaterCalls: unknown[] = [];
    const result = await ensureCliBaselineViaUpdater(makeEmit(events), {
      ...CLAUDE_BASELINE_CONFIG,
      resolveBinary: () => "/fake/bin/claude",
      allowUnprobeableInstall: true,
      _runInstalledVersion: async () => null,
      _backgroundUpdateCli: async (options: unknown) => {
        updaterCalls.push(options);
        return { outcome: "success" };
      },
    });

    expect(result).toBe("/fake/bin/claude");
    expect(updaterCalls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("repairs an unprobeable strict CLI automatically — the Codex contract (#3680)", async () => {
    const resolved = ["/broken/bin/codex", "/managed/bin/codex"];
    let versionCalls = 0;
    const result = await ensureCliBaselineViaUpdater(makeEmit([]), {
      label: "Codex",
      bareCommand: "codex",
      packageName: "@openai/codex",
      resolveBinary: () => resolved.shift() ?? "/managed/bin/codex",
      _runInstalledVersion: async () =>
        versionCalls++ === 0 ? null : "0.146.0",
      _backgroundUpdateCli: async () => ({ outcome: "success" }),
    });

    expect(result).toBe("/managed/bin/codex");
  });
});
