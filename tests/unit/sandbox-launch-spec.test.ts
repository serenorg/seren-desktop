// ABOUTME: Critical guard for #3230 — the sandbox launch spec comes from the trusted app binary only.
// ABOUTME: Runs the real resolver against a real child process; a caller can never supply the spec.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/sandbox-spec.mjs",
  import.meta.url,
).href;
const { resolveSandboxLaunchSpec } = await import(
  /* @vite-ignore */ modulePath
);

const originalSpecBin = process.env.SEREN_SANDBOX_SPEC_BIN;

/**
 * Stand in for the app binary. The resolver's contract is "execute this
 * program with the spec subcommand and read one JSON line from stdout", so a
 * real executable exercises the same argv, exit-code, and stdout path the
 * shipped binary uses. The Rust builder itself is covered by the Rust tests.
 */
function installSpecBinary(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "seren-spec-"));
  const binary = path.join(dir, "spec-binary.sh");
  writeFileSync(binary, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(binary, 0o755);
  process.env.SEREN_SANDBOX_SPEC_BIN = binary;
  return binary;
}

describe("trusted sandbox launch spec (#3230)", () => {
  afterEach(() => {
    if (originalSpecBin === undefined) {
      delete process.env.SEREN_SANDBOX_SPEC_BIN;
    } else {
      process.env.SEREN_SANDBOX_SPEC_BIN = originalSpecBin;
    }
  });

  it("passes the requested mode, network flag, and root to the binary", () => {
    installSpecBinary(
      'printf \'{"kind":"seatbelt","profile":"mode=%s network=%s root=%s"}\\n\' "$2" "$3" "$4"',
    );

    expect(
      resolveSandboxLaunchSpec({
        sandboxMode: "read-only",
        cwd: "/tmp/project",
        networkEnabled: false,
      }),
    ).toEqual({
      kind: "seatbelt",
      profile: "mode=read-only network=false root=/tmp/project",
    });
  });

  it("blocks the launch when the trusted binary is unavailable", () => {
    delete process.env.SEREN_SANDBOX_SPEC_BIN;

    expect(() =>
      resolveSandboxLaunchSpec({
        sandboxMode: "workspace-write",
        cwd: "/tmp/project",
        networkEnabled: false,
      }),
    ).toThrow(/trusted sandbox spec binary is unavailable/);
  });

  it("blocks the launch when the trusted binary fails", () => {
    installSpecBinary('echo "unsupported sandbox mode" >&2\nexit 70');

    expect(() =>
      resolveSandboxLaunchSpec({
        sandboxMode: "workspace-write",
        cwd: "/tmp/project",
        networkEnabled: true,
      }),
    ).toThrow(/unsupported sandbox mode/);
  });

  it("rejects a spec shape the Rust builder never emits", () => {
    installSpecBinary('printf \'{"kind":"anything-goes"}\\n\'');

    expect(() =>
      resolveSandboxLaunchSpec({
        sandboxMode: "workspace-write",
        cwd: "/tmp/project",
        networkEnabled: true,
      }),
    ).toThrow(/unrecognized sandbox launch spec/);
  });

  it("leaves full-access sessions without a spec", () => {
    installSpecBinary('echo "the binary must not be consulted" >&2\nexit 70');

    expect(
      resolveSandboxLaunchSpec({
        sandboxMode: "full-access",
        cwd: "/tmp/project",
        networkEnabled: true,
      }),
    ).toBeNull();
  });
});
