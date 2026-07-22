// ABOUTME: Protects the validation launcher's hermetic child environment.
// ABOUTME: Covers worktree state roots while keeping toolchain caches stable.

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validationChildEnv,
  validationHomeForSlot,
} from "../../scripts/validation-env";

describe("validation environment", () => {
  it("roots HOME in the repo-local slot directory", () => {
    const repoRoot = "/repo";
    const env = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot,
      realHome: "/real-home",
    });

    expect(env.HOME).toBe(
      path.join(repoRoot, "artifacts", "validation-home", "slot1422"),
    );
    expect(validationHomeForSlot(repoRoot, 1422)).toBe(
      path.join(repoRoot, "artifacts", "validation-home", "slot1422"),
    );
  });

  it("preserves configured toolchain homes and defaults missing ones", () => {
    const configured = validationChildEnv({
      baseEnv: {
        CARGO_HOME: "/custom/cargo",
        RUSTUP_HOME: "/custom/rustup",
      },
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
    });
    const defaults = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
    });

    expect(configured.CARGO_HOME).toBe("/custom/cargo");
    expect(configured.RUSTUP_HOME).toBe("/custom/rustup");
    expect(defaults.CARGO_HOME).toBe(path.join("/real-home", ".cargo"));
    expect(defaults.RUSTUP_HOME).toBe(path.join("/real-home", ".rustup"));
  });

  it("sets the pnpm store only when one is provided", () => {
    const withStore = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
      pnpmStoreDir: "/pnpm/store",
    });
    const withoutStore = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
    });

    expect(withStore.npm_config_store_dir).toBe("/pnpm/store");
    expect(withoutStore.npm_config_store_dir).toBeUndefined();
  });

  it("passes unrelated environment variables through unchanged", () => {
    const env = validationChildEnv({
      baseEnv: { SEREN_TEST_VALUE: "preserved" },
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
    });

    expect(env.SEREN_TEST_VALUE).toBe("preserved");
  });

  it("rejects invalid ports", () => {
    expect(() => validationHomeForSlot("/repo", 65_536)).toThrow(
      "validation port must be an integer from 1 to 65535",
    );
  });
});
