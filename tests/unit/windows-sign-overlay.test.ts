// ABOUTME: Functional tests for the native-signCommand release pipeline (#2294): overlay CLI, signer fail-fast, and workflow contract.
// ABOUTME: Guards the regression class where Windows installers shipped unsigned Seren.exe / nsis_tauri_utils.dll (v3.52.4-6).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("wraps the embedded-runtime signer with the R2-backed Windows signature cache (#2823/#2883)", () => {
    expect(workflow).toContain("WINDOWS_SIGNATURE_CACHE_R2_PREFIX");
    expect(workflow).toContain("windows-signature-cache/authenticode");
    expect(workflow).toContain("Setup AWS CLI for Windows signature cache");
    expect(workflow).toContain("Restore Windows signature cache from R2");
    expect(workflow).toContain("Save Windows signature cache to R2");
    expect(workflow).toContain(".sig-cache/windows-authenticode");
    expect(workflow).toContain("aws s3 sync");
    expect(workflow).toContain("--size-only");
    expect(workflow).toContain("windows-signature-cache.ps1");
    expect(workflow).not.toContain("key: win-sigcache-${{ github.run_id }}");
    expect(workflow).not.toContain("win-sigcache-");

    const awsCliAt = workflow.indexOf("Setup AWS CLI for Windows signature cache");
    const r2RestoreAt = workflow.indexOf("Restore Windows signature cache from R2");
    const signStepAt = workflow.indexOf("Sign embedded runtime (Windows)");
    const cacheRestoreAt = workflow.indexOf("-Mode restore", signStepAt);
    const signerAt = workflow.indexOf("sign-windows-payload.ps1", cacheRestoreAt);
    const cacheSaveAt = workflow.indexOf("-Mode save", signerAt);
    const r2SaveAt = workflow.indexOf("Save Windows signature cache to R2");

    expect(awsCliAt).toBeGreaterThanOrEqual(0);
    expect(r2RestoreAt).toBeGreaterThan(awsCliAt);
    expect(signStepAt).toBeGreaterThan(r2RestoreAt);
    expect(cacheRestoreAt).toBeGreaterThan(signStepAt);
    expect(signerAt).toBeGreaterThan(cacheRestoreAt);
    expect(cacheSaveAt).toBeGreaterThan(signerAt);
    expect(r2SaveAt).toBeGreaterThan(cacheSaveAt);
  });

  it("hard-gates unchanged embedded-runtime signature cache misses before Windows artifacts upload (#2882)", () => {
    expect(workflow).toContain("WINDOWS_EMBEDDED_RUNTIME_CACHE_HIT_MAX_SIGNED");
    expect(workflow).toContain("Fetch previous Windows signing cache state");
    expect(workflow).toContain("windows-signing-cache-previous-state.json");
    expect(workflow).toContain("Assert Windows signature cache hit budget");
    expect(workflow).toContain("assert-windows-signature-cache.ps1");
    expect(workflow).toContain("windows-signing-cache-state.json");
    expect(workflow).toContain("Upload Windows signing cache state");

    const stageAt = workflow.indexOf("Stage embedded runtime for signing (Windows)");
    const fetchStateAt = workflow.indexOf("Fetch previous Windows signing cache state");
    const cacheRestoreAt = workflow.indexOf("Restore Windows signature cache from R2");
    const signAt = workflow.indexOf("Sign embedded runtime (Windows)");
    const cacheSaveAt = workflow.indexOf("Save Windows signature cache to R2");
    const assertAt = workflow.indexOf("Assert Windows signature cache hit budget");
    const buildAt = workflow.indexOf("Build Tauri app (budget-aware, Windows)");
    const uploadWindowsAt = workflow.indexOf("Upload Windows NSIS");
    const uploadStateAt = workflow.indexOf("Upload Windows signing cache state");

    expect(stageAt).toBeGreaterThanOrEqual(0);
    expect(fetchStateAt).toBeGreaterThan(stageAt);
    expect(cacheRestoreAt).toBeGreaterThan(fetchStateAt);
    expect(signAt).toBeGreaterThan(cacheRestoreAt);
    expect(cacheSaveAt).toBeGreaterThan(signAt);
    expect(assertAt).toBeGreaterThan(cacheSaveAt);
    expect(assertAt).toBeLessThan(buildAt);
    expect(uploadStateAt).toBeGreaterThan(uploadWindowsAt);
  });

  it("keeps the embedded-runtime sign source recognized by the cache-hit assert (#2948)", () => {
    // The sign step's -SigningSource becomes the telemetry `source` field, and
    // the cache-hit assert isolates the embedded-runtime batch by that field's
    // prefix. When #2930 renamed the source to "embedded-runtime-and-mcp" but
    // the assert still only matched "list:", every Windows release failed with
    // zero embedded records (v3.69.2). This ties the producer to the consumer.
    const signStepAt = workflow.indexOf("Sign embedded runtime (Windows)");
    const nextStepAt = workflow.indexOf("Save Windows signature cache to R2", signStepAt);
    const signStep = workflow.slice(signStepAt, nextStepAt);
    const sourceMatch = signStep.match(/-SigningSource\s+"([^"]+)"/);
    expect(sourceMatch).not.toBeNull();
    const signingSource = sourceMatch?.[1] ?? "";

    const assertScript = readFileSync(
      path.join(repoRoot, "scripts", "assert-windows-signature-cache.ps1"),
      "utf8",
    );
    const prefixes = [...assertScript.matchAll(/StartsWith\("([^"]+)"/g)].map((match) => match[1]);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.some((prefix) => signingSource.startsWith(prefix))).toBe(true);
  });

  it("gives the Windows signing build the R2 creds its signCommand needs to reserve the monthly ledger (#2950)", () => {
    // Tauri's signCommand child runs sign-windows-payload.ps1 on each fresh
    // app/setup binary, which reserves against the monthly R2 ledger before
    // signtool. That reservation reads R2_BUCKET / AWS_ENDPOINT_URL and the AWS
    // credentials; if the build step omits them the bundle dies at "failed to
    // run pwsh" (v3.69.2). Keep the signing build step carrying them.
    const stepAt = workflow.indexOf("- name: Build Tauri app (budget-aware, Windows)");
    const nextStepAt = workflow.indexOf("\n      - name:", stepAt + 1);
    const step = workflow.slice(stepAt, nextStepAt === -1 ? undefined : nextStepAt);
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ENDPOINT_URL",
      "R2_BUCKET",
    ]) {
      expect(step).toContain(key);
    }
  });

  it("hard-blocks Windows signing before signtool and preserves the unsigned fallback (#2929)", () => {
    const signer = readFileSync(signerScript, "utf8");
    const budget = readFileSync(path.join(repoRoot, "scripts", "windows-signing-budget.ps1"), "utf8");

    expect(workflow).toContain("MAX_SIGNATURES");
    expect(workflow).toContain("vars.MAX_SIGNATURES");
    expect(workflow).toContain("Initialize Windows signing budget telemetry");
    expect(workflow).toContain("WINDOWS_SIGN_TELEMETRY_FILE");
    expect(workflow).toContain("WINDOWS_SIGNING_BLOCK_FILE");
    expect(workflow).toContain("Summarize Windows signing budget");
    expect(workflow).toContain("Projected cloud signatures");
    expect(workflow).toContain("Actual cloud signatures spent");
    expect(workflow).toContain("Verify budget-blocked Windows fallback is unsigned");
    expect(workflow).toContain("windows-signing-budget-state.json");
    expect(workflow).toContain("Windows artifacts in this release are NOT EV code signed.");

    const initAt = workflow.indexOf("Initialize Windows signing budget telemetry");
    const signAt = workflow.indexOf("Sign embedded runtime (Windows)");
    const buildAt = workflow.indexOf("Build Tauri app (budget-aware, Windows)");
    const summaryAt = workflow.indexOf("Summarize Windows signing budget");
    expect(initAt).toBeGreaterThanOrEqual(0);
    expect(signAt).toBeGreaterThan(initAt);
    expect(summaryAt).toBeGreaterThan(buildAt);

    expect(signer).toContain("Resolve-MaxSignatureBudget");
    expect(signer).toContain("Write-SigningTelemetry");
    expect(signer).toContain("windows-signing-budget.ps1");
    expect(signer.indexOf("windows-signing-budget.ps1")).toBeLessThan(signer.indexOf("signtool.exe"));
    expect(budget).toContain("blocked_over_budget");
    expect(budget).toContain("exit 2");
    expect(budget).not.toContain("::warning::Windows signing budget exceeded");
    expect(signer).toContain("MAX_SIGNATURES");
  });

  it("reserves the persistent monthly budget immediately before every signtool attempt (#2931)", () => {
    const signer = readFileSync(signerScript, "utf8");
    const monthly = readFileSync(path.join(repoRoot, "scripts", "windows-signing-monthly-budget.ps1"), "utf8");
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const loopAt = signer.indexOf("while ($true)");
    const attemptAt = signer.indexOf("$attempt++", loopAt);
    const reserveAt = signer.indexOf("Block-MonthlySigning", attemptAt);
    const signtoolAt = signer.indexOf("& $signtool.FullName sign", reserveAt);

    expect(attemptAt).toBeGreaterThan(loopAt);
    expect(reserveAt).toBeGreaterThan(attemptAt);
    expect(signtoolAt).toBeGreaterThan(reserveAt);
    expect(monthly).toContain('"--if-match"');
    expect(monthly).toContain('"--if-none-match"');
    expect(monthly).toContain("reserved_before_cloud_call");
    expect(monthly).toContain("BootstrapApprovedBy");
    expect(workflow).toContain("blocked_monthly_budget");
    expect(workflow).toContain("SSL_SIGNING_BILLING_TIMEZONE");
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
      {
        encoding: "utf8",
        env: {
          ...process.env,
          WINDOWS_SIGN_THUMBPRINT: undefined,
          MAX_SIGNATURES: "100",
          WINDOWS_SIGN_TELEMETRY_FILE: path.join(dummy, "telemetry.jsonl"),
          WINDOWS_SIGNING_BLOCK_FILE: path.join(dummy, "blocked.json"),
          ...env,
        },
      },
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

});
