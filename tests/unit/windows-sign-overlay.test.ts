// ABOUTME: Functional tests for the native-signCommand release pipeline (#2294): overlay CLI, signer fail-fast, and workflow contract.
// ABOUTME: Guards the regression class where Windows installers shipped unsigned Seren.exe / nsis_tauri_utils.dll (v3.52.4-6).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cli = path.join(repoRoot, "scripts", "print-windows-sign-overlay.ts");
const signerScript = path.join(repoRoot, "scripts", "sign-windows-payload.ps1");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(tsxBin, [cli, ...args], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

describe("print-windows-sign-overlay CLI", () => {
  it("emits a minimal signCommand overlay wired to the payload signer", () => {
    const { stdout, status } = runCli([repoRoot]);

    expect(status).toBe(0);
    const overlay = JSON.parse(stdout);

    // Minimal overlay: nothing but the sign command may be overridden at build
    // time, so a stray key cannot silently change bundle behavior.
    expect(Object.keys(overlay)).toEqual(["bundle"]);
    expect(Object.keys(overlay.bundle)).toEqual(["windows"]);
    expect(Object.keys(overlay.bundle.windows)).toEqual(["signCommand"]);

    const signCommand = overlay.bundle.windows.signCommand;
    expect(signCommand.cmd).toBe("pwsh");

    // %1 must be a standalone argv token (sign_command_custom replaces the
    // exact arg "%1"; embedded forms are the tauri-apps/tauri#11754 bug class)
    // and must be the value of the script's -File parameter.
    const args: string[] = signCommand.args;
    expect(args.filter((a) => a.includes("%1"))).toEqual(["%1"]);
    expect(args[args.length - 1]).toBe("%1");
    expect(args[args.length - 2]).toBe("-File");

    // The wrapper path must be absolute: the bundler absolutizes relative args
    // against its own cwd, and the !uninstfinalize NSIS hook runs the command
    // from a different directory entirely.
    const scriptArg = args.find((a) => a.endsWith("sign-windows-payload.ps1"));
    expect(scriptArg).toBe(path.join(repoRoot, "scripts", "sign-windows-payload.ps1"));
    expect(path.isAbsolute(scriptArg as string)).toBe(true);

    // pwsh contract: -File <script> must terminate pwsh's own parameters so
    // the trailing "-File %1" binds to the script, not to pwsh.
    expect(args[args.indexOf(scriptArg as string) - 1]).toBe("-File");
  });

  it("conforms to the installed tauri CLI's CustomSignCommandConfig schema (object notation)", () => {
    const { stdout, status } = runCli([repoRoot]);
    expect(status).toBe(0);
    const signCommand = JSON.parse(stdout).bundle.windows.signCommand;

    const schema = JSON.parse(
      readFileSync(path.join(repoRoot, "node_modules", "@tauri-apps", "cli", "config.schema.json"), "utf8"),
    );
    const objectNotation = schema.definitions.CustomSignCommandConfig.anyOf.find(
      (v: { type?: string }) => v.type === "object",
    );
    expect(objectNotation).toBeDefined();
    for (const key of objectNotation.required) {
      expect(signCommand[key]).toBeDefined();
    }
    expect(typeof signCommand.cmd).toBe("string");
    expect(Array.isArray(signCommand.args)).toBe(true);
    for (const arg of signCommand.args) {
      expect(typeof arg).toBe("string");
    }
  });

  it("rejects a missing workspace root with usage", () => {
    const { status } = runCli([]);
    expect(status).toBe(2);
  });

  it("rejects a relative workspace root", () => {
    const { status, stderr } = runCli(["some/relative/dir"]);
    expect(status).toBe(2);
    expect(stderr).toContain("absolute");
  });

  it("fails loud when the signer script is missing under the root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sign-overlay-"));
    try {
      const { status, stderr } = runCli([root]);
      expect(status).toBe(1);
      expect(stderr).toContain("sign-windows-payload.ps1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("local build safety", () => {
  it("tauri.conf.json does not enable signCommand (contributor Windows builds must stay unsigned)", () => {
    const conf = JSON.parse(readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
    expect(conf.bundle?.windows?.signCommand).toBeUndefined();
  });
});

describe("release workflow contract", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

  it("no longer contains the self-defeating sign/rebuild steps (#2294 root cause)", () => {
    expect(workflow).not.toContain("Sign app binary and NSIS helper DLLs");
    expect(workflow).not.toContain("Rebuild with signed NSIS helper DLLs");
    expect(workflow).not.toContain("name: Sign Windows NSIS installer");
  });

  it("builds Windows once, with the signCommand overlay", () => {
    expect(workflow).toContain("print-windows-sign-overlay.ts");
    expect(workflow).toMatch(/tauri build[^\n]*--config[^\n]*sign-overlay\.json/);
  });

  it("keeps the throttled embedded-runtime pre-sign and the payload verifiers", () => {
    expect(workflow).toContain("Sign embedded runtime (Windows)");
    expect(workflow).toContain("Verify embedded installer payload signatures (Windows)");
    expect(workflow).toContain("Audit Windows payload signature coverage");
  });

  it("wraps the embedded-runtime signer with the Windows signature cache (#2823)", () => {
    expect(workflow).toContain("Restore Windows signature cache");
    expect(workflow).toContain("uses: actions/cache@v6");
    expect(workflow).toContain(".sig-cache/windows-authenticode");
    expect(workflow).toContain("key: win-sigcache-${{ github.run_id }}");
    expect(workflow).toContain("win-sigcache-");
    expect(workflow).toContain("windows-signature-cache.ps1");

    const cacheActionAt = workflow.indexOf("Restore Windows signature cache");
    const signStepAt = workflow.indexOf("Sign embedded runtime (Windows)");
    const cacheRestoreAt = workflow.indexOf("-Mode restore", signStepAt);
    const signerAt = workflow.indexOf("sign-windows-payload.ps1", cacheRestoreAt);
    const cacheSaveAt = workflow.indexOf("-Mode save", signerAt);

    expect(cacheActionAt).toBeGreaterThanOrEqual(0);
    expect(signStepAt).toBeGreaterThan(cacheActionAt);
    expect(cacheRestoreAt).toBeGreaterThan(signStepAt);
    expect(signerAt).toBeGreaterThan(cacheRestoreAt);
    expect(cacheSaveAt).toBeGreaterThan(signerAt);
  });

  it("reports Windows signing budget telemetry as warning-only (#2818/#2821)", () => {
    const signer = readFileSync(signerScript, "utf8");

    expect(workflow).toContain("MAX_SIGNATURES");
    expect(workflow).toContain("vars.MAX_SIGNATURES");
    expect(workflow).toContain("Initialize Windows signing budget telemetry");
    expect(workflow).toContain("WINDOWS_SIGN_TELEMETRY_FILE");
    expect(workflow).toContain("Summarize Windows signing budget");
    expect(workflow).toContain("Cloud signatures spent");

    const initAt = workflow.indexOf("Initialize Windows signing budget telemetry");
    const signAt = workflow.indexOf("Sign embedded runtime (Windows)");
    const buildAt = workflow.indexOf("Build Tauri app (signed, Windows)");
    const summaryAt = workflow.indexOf("Summarize Windows signing budget");
    expect(initAt).toBeGreaterThanOrEqual(0);
    expect(signAt).toBeGreaterThan(initAt);
    expect(summaryAt).toBeGreaterThan(buildAt);

    expect(signer).toContain("Resolve-MaxSignatureBudget");
    expect(signer).toContain("Read-PreviousSignedCount");
    expect(signer).toContain("Write-SigningTelemetry");
    expect(signer).toContain("Windows signing budget exceeded");
    expect(signer).toContain("over_budget");
    expect(signer).toContain("MAX_SIGNATURES");
  });
});

describe("sign-windows-payload.ps1 thumbprint resolution", () => {
  const pwshCheck = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
  });
  const hasPwsh = pwshCheck.status === 0;
  // On a real Windows box a discovered signtool would try to sign the dummy
  // file; these tests only exercise the cross-platform validation prefix.
  const runnable = hasPwsh && process.platform !== "win32";

  let dummy: string;

  beforeEach(() => {
    dummy = mkdtempSync(path.join(tmpdir(), "signer-"));
    writeFileSync(path.join(dummy, "a.exe"), "x");
  });

  afterEach(() => {
    rmSync(dummy, { recursive: true, force: true });
  });

  function runSigner(env: Record<string, string | undefined>): { out: string; status: number } {
    const r = spawnSync(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signerScript, "-File", path.join(dummy, "a.exe")],
      { encoding: "utf8", env: { ...process.env, WINDOWS_SIGN_THUMBPRINT: undefined, ...env } },
    );
    return { out: `${r.stdout}\n${r.stderr}`, status: r.status ?? 1 };
  }

  // Per-test timeout absorbs pwsh cold-start on CI runners (~5–7s on a fresh
  // Linux runner vs ~400ms once warm). Default vitest 5s ceiling tripped #2362.
  const pwshTimeout = 30_000;

  it.runIf(runnable)(
    "fails fast with a clear error when no thumbprint is provided",
    () => {
      const { out, status } = runSigner({});
      expect(status).toBe(1);
      expect(out).toContain("WINDOWS_SIGN_THUMBPRINT");
      // Must fail on input validation, not deep in signtool discovery.
      expect(out).not.toContain("signtool");
    },
    pwshTimeout,
  );

  it.runIf(runnable)(
    "accepts the thumbprint from WINDOWS_SIGN_THUMBPRINT (signCommand passes no -Thumbprint)",
    () => {
      const { out, status } = runSigner({ WINDOWS_SIGN_THUMBPRINT: "933C679D86D0ACAF531B37A4D12C0B360EB4815C" });
      // Proceeds past validation into Windows-only signing work — proving the
      // env thumbprint was accepted.
      expect(status).toBe(1);
      expect(out).toMatch(/Get-AuthenticodeSignature|signtool/);
      expect(out).not.toContain("WINDOWS_SIGN_THUMBPRINT");
    },
    pwshTimeout,
  );

  it.runIf(runnable)(
    "warns over-budget signing, continues to signtool, and records telemetry (#2821)",
    () => {
      const telemetry = path.join(dummy, "telemetry.jsonl");
      const fakeSigntool = path.join(dummy, "kit\\x64\\signtool.exe");
      writeFileSync(fakeSigntool, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeSigntool, 0o755);
      writeFileSync(
        telemetry,
        `${JSON.stringify({
          status: "success",
          source: "previous",
          discovered: 2,
          skipped: 0,
          would_sign: 2,
          signed: 2,
          previous_signed: 0,
          max_signatures: 2,
        })}\n`,
      );

      const script = `
$global:sigChecks = 0
function global:Get-AuthenticodeSignature {
  param([string]$LiteralPath)
  $global:sigChecks++
  if ($global:sigChecks -eq 1) {
    [PSCustomObject]@{ Status = "NotSigned" }
  } else {
    [PSCustomObject]@{ Status = "Valid" }
  }
}
function global:Get-ChildItem {
  param(
    [string]$Path,
    [switch]$Recurse,
    [string]$Filter,
    [object]$ErrorAction
  )
  if ($Filter -eq "signtool.exe") {
    [PSCustomObject]@{ FullName = ${psSingleQuoted(fakeSigntool)} }
    return
  }
  Microsoft.PowerShell.Management\\Get-ChildItem @PSBoundParameters
}
& ${psSingleQuoted(signerScript)} -Thumbprint "933C679D86D0ACAF531B37A4D12C0B360EB4815C" -File ${psSingleQuoted(path.join(dummy, "a.exe"))} -MaxSignatures 2 -TelemetryFile ${psSingleQuoted(telemetry)}
exit $LASTEXITCODE
`;
      const r = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        encoding: "utf8",
      });
      const out = `${r.stdout}\n${r.stderr}`;

      expect(r.status).toBe(0);
      expect(out).toContain("Windows signing budget exceeded");
      expect(out).toContain(`Using signtool: ${fakeSigntool}`);

      const records = readFileSync(telemetry, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        status: "over_budget",
        discovered: 1,
        skipped: 0,
        would_sign: 1,
        signed: 1,
        previous_signed: 2,
        max_signatures: 2,
      });
    },
    pwshTimeout,
  );
});
