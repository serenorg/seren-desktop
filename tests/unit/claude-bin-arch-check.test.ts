// ABOUTME: Critical guard for #1862 — binaryRunsOnHost must reject wrong-arch
// ABOUTME: Mach-O/ELF/PE binaries so a wrong-arch claude no longer spawns with EBADARCH.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/agent-registry.mjs",
  import.meta.url,
).href;
const { binaryRunsOnHost } = (await import(/* @vite-ignore */ modulePath)) as {
  binaryRunsOnHost: (filePath: string) => boolean;
};

// Mach-O 64-bit little-endian magic (modern macOS binaries).
const MH_MAGIC_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const MACHO_CPUTYPE_X86_64 = Buffer.from([0x07, 0x00, 0x00, 0x01]);
const MACHO_CPUTYPE_ARM64 = Buffer.from([0x0c, 0x00, 0x00, 0x01]);

// Universal Mach-O fat header (BE magic). cputype slices follow but the kernel
// picks the matching one — universals are always runnable.
const FAT_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

// ELF: 7F 'E' 'L' 'F', then class=64-bit, data=little-endian. Machine field
// lives at offset 18 (e_machine, 2 bytes LE).
function elfHeader(machine: number): Buffer {
  const buf = Buffer.alloc(64, 0);
  buf.writeUInt8(0x7f, 0);
  buf.writeUInt8(0x45, 1); // E
  buf.writeUInt8(0x4c, 2); // L
  buf.writeUInt8(0x46, 3); // F
  buf.writeUInt8(0x02, 4); // EI_CLASS = ELFCLASS64
  buf.writeUInt8(0x01, 5); // EI_DATA = ELFDATA2LSB (little-endian)
  buf.writeUInt16LE(machine, 18);
  return buf;
}

// PE/COFF: "MZ" header, PE offset at 0x3C, then "PE\0\0" + IMAGE_FILE_HEADER
// where Machine is the first 2 bytes after the signature.
function peHeader(machine: number): Buffer {
  const peOffset = 0x80;
  const buf = Buffer.alloc(peOffset + 8, 0);
  buf.writeUInt16LE(0x5a4d, 0); // "MZ"
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x00004550, peOffset); // "PE\0\0"
  buf.writeUInt16LE(machine, peOffset + 4); // IMAGE_FILE_HEADER.Machine
  return buf;
}

function machoHeader(cputype: Buffer): Buffer {
  return Buffer.concat([
    MH_MAGIC_64,
    cputype,
    Buffer.alloc(20, 0), // pad out the rest of the mach_header_64 we need
  ]);
}

describe("#1862 — binaryRunsOnHost arch detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "arch-check-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixture(name: string, bytes: Buffer): string {
    const p = path.join(tmpDir, name);
    writeFileSync(p, bytes);
    return p;
  }

  it("accepts a Mach-O matching this host's process.arch", () => {
    const cputype = process.arch === "arm64" ? MACHO_CPUTYPE_ARM64 : MACHO_CPUTYPE_X86_64;
    const fixture = writeFixture("matching.bin", machoHeader(cputype));
    expect(binaryRunsOnHost(fixture)).toBe(true);
  });

  it("rejects a Mach-O whose cputype does NOT match this host (the #1862 bug)", () => {
    // Pick the OPPOSITE arch from the host. This is the exact failure mode
    // on the M5: x86_64 claude binary on arm64 host → spawn returns -86.
    const wrongCputype = process.arch === "arm64" ? MACHO_CPUTYPE_X86_64 : MACHO_CPUTYPE_ARM64;
    const fixture = writeFixture("wrong-arch.bin", machoHeader(wrongCputype));
    expect(binaryRunsOnHost(fixture)).toBe(false);
  });

  it("accepts a universal (fat) Mach-O regardless of host arch", () => {
    // Universals contain every slice; kernel picks the matching one. Don't
    // reject what the kernel will happily run.
    const fixture = writeFixture("universal.bin", Buffer.concat([FAT_MAGIC, Buffer.alloc(60, 0)]));
    expect(binaryRunsOnHost(fixture)).toBe(true);
  });

  it("accepts an ELF whose e_machine matches this host", () => {
    // EM_X86_64 = 0x3E, EM_AARCH64 = 0xB7
    const machine = process.arch === "arm64" ? 0xb7 : 0x3e;
    const fixture = writeFixture("matching.elf", elfHeader(machine));
    expect(binaryRunsOnHost(fixture)).toBe(true);
  });

  it("rejects an ELF whose e_machine does NOT match this host", () => {
    const wrongMachine = process.arch === "arm64" ? 0x3e : 0xb7;
    const fixture = writeFixture("wrong.elf", elfHeader(wrongMachine));
    expect(binaryRunsOnHost(fixture)).toBe(false);
  });

  it("accepts a PE/COFF whose Machine matches this host", () => {
    // IMAGE_FILE_MACHINE_AMD64 = 0x8664, IMAGE_FILE_MACHINE_ARM64 = 0xAA64
    const machine = process.arch === "arm64" ? 0xaa64 : 0x8664;
    const fixture = writeFixture("matching.exe", peHeader(machine));
    expect(binaryRunsOnHost(fixture)).toBe(true);
  });

  it("rejects a PE/COFF whose Machine does NOT match this host", () => {
    const wrongMachine = process.arch === "arm64" ? 0x8664 : 0xaa64;
    const fixture = writeFixture("wrong.exe", peHeader(wrongMachine));
    expect(binaryRunsOnHost(fixture)).toBe(false);
  });

  it("accepts non-binary files (shell scripts, text) so we don't reject what we can't classify", () => {
    // Wrapper scripts and shebang launchers are legitimate claude install
    // forms in some environments. If we can't read a CPU type, defer to the
    // spawn — it will surface a real error.
    const fixture = writeFixture("script.sh", Buffer.from("#!/bin/sh\necho hi\n"));
    expect(binaryRunsOnHost(fixture)).toBe(true);
  });

  it("accepts missing files (defers to existsSync upstream)", () => {
    // resolvers check existsSync before calling binaryRunsOnHost; if a file
    // disappears between those calls, treat it as runnable so we don't
    // silently skip a candidate the upstream caller intended to use.
    expect(binaryRunsOnHost(path.join(tmpDir, "does-not-exist"))).toBe(true);
  });
});
