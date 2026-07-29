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
      "function resolveInstalledGeminiBinary",
    );
    const helper = agentRegistrySource.slice(start, end);

    expect(helper).toContain("ensureCliBaselineViaUpdater(emit");
    expect(helper).toContain('packageName: "@anthropic-ai/claude-code"');
    expect(helper).toContain("resolveBinary: resolveInstalledClaudeBinary");
    // Custom PATH installs cannot be auto-updated, but a determinately
    // below-baseline one must still be refused with an actionable error.
    expect(helper).toContain("isBelowBaseline(installed, baseline)");
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

  it("hands off with installation_required when no version can be probed", async () => {
    const events: EmittedEvent[] = [];
    const updaterCalls: unknown[] = [];
    await expect(
      ensureCliBaselineViaUpdater(makeEmit(events), {
        ...CLAUDE_BASELINE_CONFIG,
        resolveBinary: () => "claude",
        _runInstalledVersion: async () => null,
        _backgroundUpdateCli: async (options: unknown) => {
          updaterCalls.push(options);
          return { outcome: "success" };
        },
      }),
    ).rejects.toThrow(/not installed in a verifiable location/);

    expect(updaterCalls).toHaveLength(0);
    const action = events.find(
      (event) => event.name === "provider://cli-update-action-required",
    );
    expect(action?.payload.reason).toBe("installation_required");
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

  it("still hands off an UNRESOLVED install even when the CLI opts in (#3471)", async () => {
    await expect(
      ensureCliBaselineViaUpdater(makeEmit([]), {
        ...CLAUDE_BASELINE_CONFIG,
        resolveBinary: () => "claude",
        allowUnprobeableInstall: true,
        _runInstalledVersion: async () => null,
        _backgroundUpdateCli: async () => ({ outcome: "success" }),
      }),
    ).rejects.toThrow(/not installed in a verifiable location/);
  });

  it("keeps the strict handoff for CLIs that do not opt in — the Codex contract (#2904)", async () => {
    await expect(
      ensureCliBaselineViaUpdater(makeEmit([]), {
        ...CLAUDE_BASELINE_CONFIG,
        resolveBinary: () => "/fake/bin/codex",
        _runInstalledVersion: async () => null,
        _backgroundUpdateCli: async () => ({ outcome: "success" }),
      }),
    ).rejects.toThrow(/not installed in a verifiable location/);
  });
});
