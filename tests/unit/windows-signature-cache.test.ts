// ABOUTME: Functional tests for the Windows Authenticode signature cache helper (#2823).
// ABOUTME: Uses mocked PowerShell signature checks so cache trust and manifest behavior are covered without a Windows signer.

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const cacheScript = path.join(repoRoot, "scripts", "windows-signature-cache.ps1");
const pwshCheck = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
  encoding: "utf8",
});
const hasPwsh = pwshCheck.status === 0;

let root: string;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runCacheScript(args: string[], signatureMock: string): { out: string; status: number } {
  const command = `
$ErrorActionPreference = "Stop"
${signatureMock}
& ${psSingleQuoted(cacheScript)} ${args.join(" ")}
if ($?) { exit 0 } else { exit 1 }
`;
  const r = spawnSync("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
  });
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status ?? 1 };
}

function validSignatureMock(thumbprint: string): string {
  return `
function global:Get-AuthenticodeSignature {
  param([string]$LiteralPath)
  [PSCustomObject]@{
    Status = "Valid"
    SignerCertificate = [PSCustomObject]@{ Thumbprint = ${psSingleQuoted(thumbprint)} }
  }
}
`;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "win-sig-cache-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("windows-signature-cache.ps1", () => {
  const pwshTimeout = 30_000;

  it.runIf(hasPwsh)(
    "restores a valid cached signature by the pre-sign content hash",
    () => {
      const payload = path.join(root, "payload.exe");
      const list = path.join(root, "sign-targets.txt");
      const cache = path.join(root, "cache");
      const manifest = path.join(root, "manifest.tsv");
      const unsigned = "unsigned bytes";
      const signed = "signed bytes";
      const hash = sha256(unsigned);

      mkdirSync(cache, { recursive: true });
      writeFileSync(payload, unsigned);
      writeFileSync(list, `${payload}\n`);
      writeFileSync(path.join(cache, `${hash}.signed`), signed);

      const { out, status } = runCacheScript(
        [
          "-Mode restore",
          "-ListFile",
          psSingleQuoted(list),
          "-CacheDir",
          psSingleQuoted(cache),
          "-Manifest",
          psSingleQuoted(manifest),
          "-Thumbprint",
          psSingleQuoted("ABC123"),
        ],
        validSignatureMock("ABC123"),
      );

      expect(status).toBe(0);
      expect(out).toContain("restored 1 of 1");
      expect(readFileSync(payload, "utf8")).toBe(signed);
      expect(readFileSync(manifest, "utf8").trim()).toBe(`${hash}\t${payload}`);
    },
    pwshTimeout,
  );

  it.runIf(hasPwsh)(
    "discards a wrong-thumbprint cache entry before overwriting the payload",
    () => {
      const payload = path.join(root, "payload.exe");
      const list = path.join(root, "sign-targets.txt");
      const cache = path.join(root, "cache");
      const manifest = path.join(root, "manifest.tsv");
      const unsigned = "unsigned bytes";
      const hash = sha256(unsigned);
      const blob = path.join(cache, `${hash}.signed`);

      mkdirSync(cache, { recursive: true });
      writeFileSync(payload, unsigned);
      writeFileSync(list, `${payload}\n`);
      writeFileSync(blob, "foreign signed bytes");

      const { out, status } = runCacheScript(
        [
          "-Mode restore",
          "-ListFile",
          psSingleQuoted(list),
          "-CacheDir",
          psSingleQuoted(cache),
          "-Manifest",
          psSingleQuoted(manifest),
          "-Thumbprint",
          psSingleQuoted("ABC123"),
        ],
        validSignatureMock("DEF456"),
      );

      expect(status).toBe(0);
      expect(out).toContain("Discarded untrusted Windows signature-cache entry");
      expect(out).toContain("restored 0 of 1");
      expect(readFileSync(payload, "utf8")).toBe(unsigned);
      expect(() => readFileSync(blob, "utf8")).toThrow();
      expect(readFileSync(manifest, "utf8").trim()).toBe(`${hash}\t${payload}`);
    },
    pwshTimeout,
  );

  it.runIf(hasPwsh)(
    "saves a newly signed file under the manifest's original pre-sign hash",
    () => {
      const payload = path.join(root, "payload.exe");
      const list = path.join(root, "sign-targets.txt");
      const cache = path.join(root, "cache");
      const manifest = path.join(root, "manifest.tsv");
      const originalHash = sha256("unsigned bytes");
      const signed = "signed bytes";

      mkdirSync(cache, { recursive: true });
      writeFileSync(payload, signed);
      writeFileSync(list, `${payload}\n`);
      writeFileSync(manifest, `${originalHash}\t${payload}\n`);

      const { out, status } = runCacheScript(
        [
          "-Mode save",
          "-ListFile",
          psSingleQuoted(list),
          "-CacheDir",
          psSingleQuoted(cache),
          "-Manifest",
          psSingleQuoted(manifest),
          "-Thumbprint",
          psSingleQuoted("ABC123"),
        ],
        validSignatureMock("ABC123"),
      );

      expect(status).toBe(0);
      expect(out).toContain("saved 1 newly signed");
      expect(readFileSync(path.join(cache, `${originalHash}.signed`), "utf8")).toBe(signed);
    },
    pwshTimeout,
  );
});
