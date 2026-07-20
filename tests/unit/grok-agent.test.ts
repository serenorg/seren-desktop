// ABOUTME: Critical regression guards for the native Grok ACP agent (#3084).
// ABOUTME: Protects its thin-adapter boundary, auth ordering, CLI safety flags, and desktop routing.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveGrokBinary } from "../../bin/browser-local/grok-binary.mjs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(resolve(relativePath), "utf8");
}

const acpSource = readSource("bin/browser-local/acp-runtime.mjs");
const grokSource = readSource("bin/browser-local/grok-runtime.mjs");
const providersSource = readSource("bin/browser-local/providers.mjs");
const registrySource = readSource("bin/browser-local/agent-registry.mjs");
const providerServiceSource = readSource("src/services/providers.ts");

describe("Grok native ACP agent (#3084)", () => {
  it("is a thin adapter over the shared Gemini-derived ACP transport", () => {
    expect(grokSource).toContain(
      'import { createAcpRuntime } from "./acp-runtime.mjs"',
    );
    expect(grokSource).toContain("adapter: GROK_ADAPTER");
    expect(grokSource).not.toContain("function sendRequest(");
    expect(grokSource).not.toContain("function handleSessionUpdate(");
  });

  it("authenticates after initialize and before session/new", () => {
    const initializeAt = acpSource.indexOf('"initialize"');
    const authenticateAt = acpSource.indexOf("await adapter.authenticate");
    const sessionNewAt = acpSource.indexOf('"session/new"', authenticateAt);

    expect(initializeAt).toBeGreaterThan(-1);
    expect(authenticateAt).toBeGreaterThan(initializeAt);
    expect(sessionNewAt).toBeGreaterThan(authenticateAt);
    expect(grokSource).toContain('"xai.api_key"');
    expect(grokSource).toContain('"grok.com"');
    expect(grokSource).toContain('"cached_token"');
    expect(grokSource).toContain("_meta: { headless: true }");
  });

  it("launches official Grok ACP mode without child-process self-updates", () => {
    expect(grokSource).toContain('modelId: "grok-4.5"');
    expect(grokSource).toContain(
      'const GROK_DEFAULT_MODEL_ID = "grok-4.5"',
    );
    expect(grokSource).not.toContain('modelId: "grok-build"');
    expect(grokSource).toContain('"--no-auto-update"');
    expect(grokSource).toContain('"--permission-mode"');
    expect(grokSource).toContain('"--sandbox"');
    expect(grokSource).toContain('"agent"');
    expect(grokSource).toContain('"stdio"');
    expect(registrySource).toContain('packageName: "@xai-official/grok"');
  });

  it("prefers the package-owned native binary over a Tauri-relocated npm shim", () => {
    const root = mkdtempSync(join(tmpdir(), "seren-grok-binary-"));
    try {
      const prefix = join(root, "node");
      const execPath = join(prefix, "bin", "node");
      const relocatedShim = join(prefix, "bin", "grok");
      const nativeBinary = join(
        prefix,
        "lib",
        "node_modules",
        "@xai-official",
        "grok",
        "node_modules",
        "@xai-official",
        "grok-darwin-x64",
        "bin",
        "grok",
      );
      mkdirSync(join(prefix, "bin"), { recursive: true });
      mkdirSync(dirname(nativeBinary), { recursive: true });
      writeFileSync(execPath, "");
      writeFileSync(relocatedShim, "const { spawn } = require('child_process');\n");
      writeFileSync(nativeBinary, "native executable");

      expect(
        resolveGrokBinary({
          execPath,
          platform: "darwin",
          arch: "x64",
          home: join(root, "home"),
          appData: "",
        }),
      ).toBe(nativeBinary);

      rmSync(nativeBinary);
      expect(
        resolveGrokBinary({
          execPath,
          platform: "darwin",
          arch: "x64",
          home: join(root, "home"),
          appData: "",
        }),
      ).toBe("grok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes Grok through the registry, runtime dispatcher, and public agent type", () => {
    expect(registrySource).toContain("grok: {");
    expect(providersSource).toContain('import("./grok-runtime.mjs")');
    expect(providersSource).toMatch(
      /if\s*\(\s*agentType\s*===\s*"grok"\s*\)\s*\{[^}]*grokRuntime\.spawnSession/s,
    );
    expect(providerServiceSource).toContain('| "grok"');
    expect(providerServiceSource).toContain("ensureGrokCli");
  });
});
