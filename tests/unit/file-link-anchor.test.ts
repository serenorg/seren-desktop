// ABOUTME: Critical regression test for agent-link line/column anchor stripping.
// ABOUTME: Guards openFileInTab against passing :line[:col] suffixes to readFile (#1746).

import { describe, expect, it } from "vitest";
import { extractLineAnchor, stripLineAnchor } from "@/lib/files/service";

describe("file-link anchor parsing", () => {
  it("strips grep/editor :line and :line:col suffixes", () => {
    expect(stripLineAnchor("/Users/x/Downloads/audit.md:44")).toBe(
      "/Users/x/Downloads/audit.md",
    );
    expect(stripLineAnchor("src/lib/files/service.ts:203:7")).toBe(
      "src/lib/files/service.ts",
    );
    expect(extractLineAnchor("/Users/x/Downloads/audit.md:44")).toBe(44);
  });

  it("strips markdown #L anchors and ranges", () => {
    expect(stripLineAnchor("src/lib/files/service.ts#L42")).toBe(
      "src/lib/files/service.ts",
    );
    expect(stripLineAnchor("src/lib/files/service.ts#L10-L20")).toBe(
      "src/lib/files/service.ts",
    );
    expect(extractLineAnchor("src/lib/files/service.ts#L10-L20")).toBe(10);
  });

  it("preserves Windows drive-letter paths", () => {
    expect(stripLineAnchor("C:\\Users\\x\\file.md")).toBe(
      "C:\\Users\\x\\file.md",
    );
    expect(extractLineAnchor("C:\\Users\\x\\file.md")).toBeUndefined();
  });

  it("returns plain paths unchanged when no anchor is present", () => {
    expect(stripLineAnchor("/Users/x/Downloads/audit.md")).toBe(
      "/Users/x/Downloads/audit.md",
    );
    expect(extractLineAnchor("/Users/x/Downloads/audit.md")).toBeUndefined();
  });
});
