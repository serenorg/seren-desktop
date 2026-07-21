// ABOUTME: Protects validation launcher argument forwarding.
// ABOUTME: Covers pnpm's optional separator without changing direct Tauri flags.

import { describe, expect, it } from "vitest";
import { validationDevArgs } from "../../scripts/validation-dev-args";

describe("validation dev arguments", () => {
  it("removes only the leading package-manager separator", () => {
    expect(validationDevArgs(["--", "--no-watch"])).toEqual(["--no-watch"]);
    expect(validationDevArgs(["--no-watch"])).toEqual(["--no-watch"]);
  });
});
