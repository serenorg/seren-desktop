// ABOUTME: Critical tests for the MCP `run_sql` → QueryResult parser in databases.ts.
// ABOUTME: This is the path every SerenDB SQL call now goes through.

import { describe, expect, it } from "vitest";
import {
  extractMcpText,
  parseQueryResultFromMcp,
} from "@/services/databases";

describe("extractMcpText", () => {
  it("returns the first text content item", () => {
    const content = [
      { type: "text", text: "first text" },
      { type: "text", text: "second text" },
    ];
    expect(extractMcpText(content)).toBe("first text");
  });

  it("skips non-text content types", () => {
    const content = [
      { type: "image", data: "…", mimeType: "image/png" },
      { type: "text", text: "real text" },
    ];
    expect(extractMcpText(content)).toBe("real text");
  });

  it("returns empty string for unknown shapes without throwing", () => {
    expect(extractMcpText(null)).toBe("");
    expect(extractMcpText(undefined)).toBe("");
    expect(extractMcpText({})).toBe("");
    expect(extractMcpText([])).toBe("");
    expect(extractMcpText([{ type: "text" }])).toBe("");
  });
});

describe("parseQueryResultFromMcp", () => {
  it("parses the bare { columns, row_count, rows } shape", () => {
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          columns: ["?column?"],
          row_count: 1,
          rows: [[1]],
        }),
      },
    ];
    const result = parseQueryResultFromMcp(content);
    expect(result.columns).toEqual(["?column?"]);
    expect(result.row_count).toBe(1);
    expect(result.rows).toEqual([[1]]);
  });

  it("parses a wrapped { data: { columns, row_count, rows } } envelope", () => {
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          data: {
            columns: ["id", "name"],
            row_count: 2,
            rows: [
              [1, "alice"],
              [2, "bob"],
            ],
          },
        }),
      },
    ];
    const result = parseQueryResultFromMcp(content);
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.row_count).toBe(2);
    expect(result.rows).toEqual([
      [1, "alice"],
      [2, "bob"],
    ]);
  });

  it("throws a clear error for non-JSON text content", () => {
    const content = [{ type: "text", text: "not json at all" }];
    expect(() => parseQueryResultFromMcp(content)).toThrow(
      /non-JSON text/i,
    );
  });

  it("throws a clear error when the response has no text payload", () => {
    expect(() => parseQueryResultFromMcp([])).toThrow(
      /no text content/i,
    );
  });

  it("defaults missing fields gracefully", () => {
    const content = [{ type: "text", text: JSON.stringify({}) }];
    const result = parseQueryResultFromMcp(content);
    expect(result.columns).toEqual([]);
    expect(result.row_count).toBe(0);
    expect(result.rows).toEqual([]);
  });
});
