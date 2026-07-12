// ABOUTME: Runs the real Windows signing-budget barrier against temporary telemetry and block-state files.
// ABOUTME: Covers under-cap passage, cumulative over-cap blocking, persisted skips, and fail-closed bad configuration.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..");
const barrier = path.join(root, "scripts", "windows-signing-budget.ps1");
const pwshCheck = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
  encoding: "utf8",
});
const runnable = pwshCheck.status === 0;

let dir: string;
let telemetry: string;
let blockFile: string;

function successRecord(signed: number): string {
  return `${JSON.stringify({
    status: "success",
    source: `prior-${signed}`,
    discovered: signed,
    skipped: 0,
    would_sign: signed,
    signed,
    previous_signed: 0,
    max_signatures: 100,
  })}\n`;
}

function runBarrier(max: string | undefined, wouldSign = 1) {
  return spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      barrier,
      "-Source",
      "test-source",
      "-Discovered",
      String(wouldSign),
      "-Skipped",
      "0",
      "-WouldSign",
      String(wouldSign),
      "-TelemetryFile",
      telemetry,
      "-BlockFile",
      blockFile,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, MAX_SIGNATURES: max },
    },
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "windows-signing-budget-"));
  telemetry = path.join(dir, "telemetry.jsonl");
  blockFile = path.join(dir, "blocked.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(runnable)("Windows signing budget barrier", () => {
  it("allows an under-cap signing source without mutating the ledger", () => {
    writeFileSync(telemetry, successRecord(2));
    const result = runBarrier("3", 1);

    expect(result.status).toBe(0);
    expect(existsSync(blockFile)).toBe(false);
    expect(readFileSync(telemetry, "utf8")).toBe(successRecord(2));
  });

  it("aggregates prior invocations and blocks before the next source can sign", () => {
    writeFileSync(telemetry, successRecord(2) + successRecord(1));
    const result = runBarrier("4", 2);

    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain("blocked before signtool");
    const records = readFileSync(telemetry, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      status: "blocked_over_budget",
      previous_signed: 3,
      would_sign: 2,
      signed: 0,
      projected_total: 5,
      max_signatures: 4,
      blocked: true,
    });
    expect(JSON.parse(readFileSync(blockFile, "utf8"))).toMatchObject({
      status: "blocked_over_budget",
      projected_total: 5,
    });
  });

  it("keeps later signing sources blocked and records their breakdown", () => {
    writeFileSync(telemetry, successRecord(2));
    writeFileSync(blockFile, JSON.stringify({ status: "blocked_over_budget" }));
    const result = runBarrier("100", 4);

    expect(result.status).toBe(2);
    const records = readFileSync(telemetry, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      status: "skipped_budget_blocked",
      source: "test-source",
      would_sign: 4,
      signed: 0,
    });
  });

  it.each([
    [undefined, "MAX_SIGNATURES is required"],
    ["invalid", "must be a non-negative integer"],
    ["-1", "must be a non-negative integer"],
  ])("fails closed for missing or invalid MAX_SIGNATURES (%s)", (max, message) => {
    const result = runBarrier(max);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
    expect(existsSync(blockFile)).toBe(false);
  });

  it("fails closed on malformed cumulative telemetry", () => {
    writeFileSync(telemetry, "not-json\n");
    const result = runBarrier("100");

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Malformed Windows signing telemetry");
    expect(existsSync(blockFile)).toBe(false);
  });
});
