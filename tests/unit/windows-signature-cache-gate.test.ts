// ABOUTME: Regression tests for the Windows signature-cache hard gate (#2882).
// ABOUTME: Uses real telemetry and manifest files; no signer mocking is needed for this release assertion.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const gateScript = path.join(repoRoot, "scripts", "assert-windows-signature-cache.ps1");
const pwshCheck = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
  encoding: "utf8",
});
const hasPwsh = pwshCheck.status === 0;

let root: string;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function writeArtifacts(contentHash: string, signed: number): { list: string; manifest: string; telemetry: string } {
  const payload = path.join(root, "src-tauri", "embedded-runtime", "bin", "payload.exe");
  const list = path.join(root, "sign-targets.txt");
  const manifest = path.join(root, "windows-signature-cache-manifest.tsv");
  const telemetry = path.join(root, "windows-signing-telemetry.jsonl");

  mkdirSync(path.dirname(payload), { recursive: true });
  writeFileSync(payload, "unsigned payload");
  writeFileSync(list, `${payload}\n`);
  writeFileSync(manifest, `${contentHash}\t${payload}\n`);
  writeFileSync(
    telemetry,
    `${JSON.stringify({
      status: "success",
      source: "list:sign-targets.txt",
      discovered: 729,
      skipped: 195,
      would_sign: signed,
      signed,
      previous_signed: 0,
      max_signatures: 850,
    })}\n`,
  );

  return { list, manifest, telemetry };
}

function runGate(args: string[]): { out: string; status: number } {
  const r = spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", gateScript, ...args],
    { encoding: "utf8" },
  );
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status ?? 1 };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "win-sig-cache-gate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("assert-windows-signature-cache.ps1", () => {
  const pwshTimeout = 30_000;

  it.runIf(hasPwsh)(
    "fails when an unchanged embedded-runtime manifest freshly signs over the cache-hit floor",
    () => {
      const artifacts = writeArtifacts(sha256("unsigned payload"), 534);
      const previousState = path.join(root, "previous-state.json");
      const currentState = path.join(root, "current-state.json");

      const first = runGate([
        "-ListFile",
        artifacts.list,
        "-Manifest",
        artifacts.manifest,
        "-TelemetryFile",
        artifacts.telemetry,
        "-OutputState",
        previousState,
        "-Workspace",
        root,
        "-MaxSignedWhenUnchanged",
        "25",
      ]);
      expect(first.status).toBe(0);
      expect(first.out).toContain("no previous release state");

      const second = runGate([
        "-ListFile",
        artifacts.list,
        "-Manifest",
        artifacts.manifest,
        "-TelemetryFile",
        artifacts.telemetry,
        "-PreviousState",
        previousState,
        "-OutputState",
        currentState,
        "-Workspace",
        root,
        "-MaxSignedWhenUnchanged",
        "25",
      ]);

      expect(second.status).toBe(1);
      expect(second.out).toContain("Windows signature cache regression");
      expect(second.out).toContain("expected <= 25");

      const state = JSON.parse(readFileSync(currentState, "utf8"));
      expect(state.cache_gate_status).toBe("failed_unchanged_manifest_over_floor");
      expect(state.embedded_runtime_signed).toBe(534);
      expect(state.previous_manifest_hash).toBe(state.manifest_hash);
    },
    pwshTimeout,
  );

  it.runIf(hasPwsh)(
    "skips the hard gate when the embedded-runtime manifest changed",
    () => {
      const firstArtifacts = writeArtifacts(sha256("unsigned payload v1"), 534);
      const previousState = path.join(root, "previous-state.json");
      const currentState = path.join(root, "current-state.json");

      expect(
        runGate([
          "-ListFile",
          firstArtifacts.list,
          "-Manifest",
          firstArtifacts.manifest,
          "-TelemetryFile",
          firstArtifacts.telemetry,
          "-OutputState",
          previousState,
          "-Workspace",
          root,
          "-MaxSignedWhenUnchanged",
          "25",
        ]).status,
      ).toBe(0);

      const changedArtifacts = writeArtifacts(sha256("unsigned payload v2"), 534);
      const changed = runGate([
        "-ListFile",
        changedArtifacts.list,
        "-Manifest",
        changedArtifacts.manifest,
        "-TelemetryFile",
        changedArtifacts.telemetry,
        "-PreviousState",
        previousState,
        "-OutputState",
        currentState,
        "-Workspace",
        root,
        "-MaxSignedWhenUnchanged",
        "25",
      ]);

      expect(changed.status).toBe(0);
      expect(changed.out).toContain("manifest changed");

      const state = JSON.parse(readFileSync(currentState, "utf8"));
      expect(state.cache_gate_status).toBe("skipped_changed_manifest");
      expect(state.previous_manifest_hash).not.toBe(state.manifest_hash);
    },
    pwshTimeout,
  );
});
