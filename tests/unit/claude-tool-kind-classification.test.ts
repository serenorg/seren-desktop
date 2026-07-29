// ABOUTME: Guards for #3453 — toolKindForName must not classify reads by bare substring.
// ABOUTME: A false fileRead kind hides the tool's real output behind a Happy Mobile read summary.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const { _toolKindForName: toolKindForName } = await import(
  /* @vite-ignore */ modulePath
);

describe("#3453 toolKindForName read classification", () => {
  it("classifies real read tools as fileRead", () => {
    expect(toolKindForName("Read")).toBe("fileRead");
    expect(toolKindForName("read_file")).toBe("fileRead");
    expect(toolKindForName("ReadFile")).toBe("fileRead");
    expect(toolKindForName("readFile")).toBe("fileRead");
    expect(toolKindForName("NotebookRead")).toBe("fileRead");
    expect(toolKindForName("read-many-files")).toBe("fileRead");
    expect(toolKindForName("mcp__fs__read_text_file")).toBe("fileRead");
  });

  it("does not classify names that merely contain 'read' inside a word", () => {
    // "append_to_spreadsheet" ("sp-read-sheet") and "thread_reply"
    // ("th-read") matched the old substring test; since #3426 the fileRead
    // kind replaces their Happy Mobile output with "[N lines hidden]".
    expect(toolKindForName("append_to_spreadsheet")).toBe(
      "append_to_spreadsheet",
    );
    expect(toolKindForName("thread_reply")).toBe("thread_reply");
    expect(toolKindForName("update_spreadsheet_cell")).toBe(
      "update_spreadsheet_cell",
    );
  });

  it("keeps the other kind classifications stable", () => {
    expect(toolKindForName("Bash")).toBe("commandExecution");
    expect(toolKindForName("Edit")).toBe("fileChange");
    expect(toolKindForName("Write")).toBe("fileChange");
    expect(toolKindForName("Grep")).toBe("search");
    expect(toolKindForName("Glob")).toBe("search");
    expect(toolKindForName("WebFetch")).toBe("webFetch");
    expect(toolKindForName(undefined)).toBe("tool");
  });
});
