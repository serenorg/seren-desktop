// ABOUTME: TDD coverage for spawn-root and permission-response boundaries.
// ABOUTME: Uses real temporary filesystem entries and caller-supplied state only.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import {
  validatePermissionResponse,
  validateSpawnRoot,
} from "../../bin/happy-bridge/validate.mjs";

const temporaryDirectories: string[] = [];

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "seren-happy-bridge-"));
  const advertisedRoot = join(directory, "advertised-root");
  const prefixTrick = join(directory, "advertised-root-evil");
  mkdirSync(advertisedRoot);
  mkdirSync(prefixTrick);
  temporaryDirectories.push(directory);
  return { directory, advertisedRoot, prefixTrick };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("validateSpawnRoot", () => {
  it("accepts an exact advertised root", () => {
    const { advertisedRoot } = makeFixture();
    expect(validateSpawnRoot(advertisedRoot, [advertisedRoot])).toEqual({
      ok: true,
      root: realpathSync(advertisedRoot),
    });
  });

  it("rejects .. traversal to an advertised root parent", () => {
    const { directory, advertisedRoot } = makeFixture();
    expect(validateSpawnRoot(join(advertisedRoot, ".."), [advertisedRoot])).toEqual({
      ok: false,
      reason: "requested path is not an advertised root",
    });
    expect(existsSync(directory)).toBe(true);
  });

  it("accepts a symlink whose canonical target is an advertised root", () => {
    const { directory, advertisedRoot } = makeFixture();
    const link = join(directory, "advertised-link");
    symlinkSync(advertisedRoot, link, process.platform === "win32" ? "junction" : "dir");
    expect(validateSpawnRoot(link, [advertisedRoot])).toEqual({
      ok: true,
      root: realpathSync(advertisedRoot),
    });
  });

  it("rejects a prefix trick", () => {
    const { advertisedRoot, prefixTrick } = makeFixture();
    expect(validateSpawnRoot(prefixTrick, [advertisedRoot])).toEqual({
      ok: false,
      reason: "requested path is not an advertised root",
    });
  });

  it("rejects an empty advertised list", () => {
    const { advertisedRoot } = makeFixture();
    expect(validateSpawnRoot(advertisedRoot, [])).toEqual({
      ok: false,
      reason: "no advertised roots",
    });
  });

  it("rejects relative paths", () => {
    makeFixture();
    expect(validateSpawnRoot("advertised-root", ["advertised-root"])).toEqual({
      ok: false,
      reason: "requested path must be absolute",
    });
  });

  it("rejects nonexistent paths", () => {
    const { directory, advertisedRoot } = makeFixture();
    expect(validateSpawnRoot(join(directory, "missing"), [advertisedRoot])).toEqual({
      ok: false,
      reason: "requested path does not exist",
    });
  });
});

describe("validatePermissionResponse", () => {
  const trackedState = {
    liveSessions: new Set(["session-1"]),
    pendingRequests: {
      "session-1": {
        "request-1": { optionIds: ["allow-once", "deny"] },
      },
    },
  };

  it("accepts an offered option for a live session", () => {
    expect(
      validatePermissionResponse("session-1", "request-1", "allow-once", trackedState),
    ).toEqual({ ok: true });
  });

  it("accepts a Set of offered options", () => {
    expect(
      validatePermissionResponse("session-1", "request-1", "deny", {
        liveSessions: new Set(["session-1"]),
        pendingRequests: {
          "session-1": { "request-1": { options: new Set(["deny"]) } },
        },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a response for a dead session", () => {
    expect(
      validatePermissionResponse("session-dead", "request-1", "allow-once", trackedState),
    ).toEqual({ ok: false, reason: "session is not live" });
  });

  it("rejects a response for a non-pending request", () => {
    expect(
      validatePermissionResponse("session-1", "request-missing", "allow-once", trackedState),
    ).toEqual({ ok: false, reason: "permission request is not pending" });
  });

  it("rejects an option that was not offered", () => {
    expect(
      validatePermissionResponse("session-1", "request-1", "admin", trackedState),
    ).toEqual({ ok: false, reason: "permission option was not offered" });
  });

  it("rejects inherited live-session ids", () => {
    expect(
      validatePermissionResponse("constructor", "request-1", "allow-once", {
        liveSessions: {},
        pendingRequests: {},
      }),
    ).toEqual({ ok: false, reason: "session is not live" });
  });

  it("rejects inherited pending-request ids", () => {
    expect(
      validatePermissionResponse("session-1", "toString", "allow-once", {
        liveSessions: { "session-1": true },
        pendingRequests: { "session-1": {} },
      }),
    ).toEqual({ ok: false, reason: "permission request is not pending" });
  });
});
