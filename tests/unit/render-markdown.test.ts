// ABOUTME: Unit tests for render-markdown normalisation helpers.
// ABOUTME: Covers isCodeLine and wrapCodeIslands against real Codex output patterns.

import { describe, expect, it } from "vitest";
import { isCodeLine, wrapCodeIslands } from "@/lib/render-markdown";

describe("isCodeLine", () => {
  it("recognises JSDoc openers", () => {
    expect(isCodeLine("/**", false)).toBe(true);
    expect(isCodeLine("/*", false)).toBe(true);
  });

  it("recognises JSDoc closers and continuations only inside a comment", () => {
    expect(isCodeLine("*/", true)).toBe(true);
    expect(isCodeLine("* Branch ID", true)).toBe(true);
    // Outside a comment block, * lines are markdown bullets — not code
    expect(isCodeLine("*/", false)).toBe(false);
    expect(isCodeLine("* Branch ID", false)).toBe(false);
  });

  it("recognises TypeScript declarations", () => {
    expect(isCodeLine("export type CreateDatabaseErrors = {", false)).toBe(
      true,
    );
    expect(isCodeLine("interface GetOptions {", false)).toBe(true);
    expect(isCodeLine("export interface Foo extends Bar {", false)).toBe(true);
    expect(isCodeLine("export class MyClass {", false)).toBe(true);
    expect(isCodeLine("export function doThing(): void {", false)).toBe(true);
    expect(isCodeLine("const result = await fetch(url);", false)).toBe(true);
    expect(isCodeLine("let count: number;", false)).toBe(true);
    expect(isCodeLine("var legacy = 1;", false)).toBe(true);
    expect(isCodeLine("export enum Status {", false)).toBe(true);
    expect(isCodeLine("import { foo } from 'bar';", false)).toBe(true);
    expect(isCodeLine("import type { Foo } from './types';", false)).toBe(true);
  });

  it("recognises lines ending with semicolon (not prose)", () => {
    expect(isCodeLine("branch_id: string;", false)).toBe(true);
    expect(isCodeLine("query?: never;", false)).toBe(true);
    expect(isCodeLine("400: unknown;", false)).toBe(true);
  });

  it("does NOT treat prose sentences ending with ; as code", () => {
    // "This returns a value;" starts uppercase + lowercase word
    expect(isCodeLine("This returns a value;", false)).toBe(false);
    expect(isCodeLine("Remember to handle errors;", false)).toBe(false);
  });

  it("recognises closing brace lines", () => {
    expect(isCodeLine("};", false)).toBe(true);
    expect(isCodeLine("}", false)).toBe(true);
    expect(isCodeLine("},", false)).toBe(true);
  });

  it("recognises HTTP status-code type entries", () => {
    expect(isCodeLine("400: unknown;", false)).toBe(true);
    expect(isCodeLine("404: string;", false)).toBe(true);
  });

  it("does NOT treat normal prose as code", () => {
    expect(
      isCodeLine("I have enough context and will implement now.", false),
    ).toBe(false);
    expect(isCodeLine("Plan:", false)).toBe(false);
    expect(isCodeLine("Here are the steps:", false)).toBe(false);
    expect(isCodeLine("- Install dependencies", false)).toBe(false);
    expect(isCodeLine("1. Do something", false)).toBe(false);
  });

  it("does NOT treat markdown bullet lines outside JSDoc as code", () => {
    expect(isCodeLine("* Handle error cases", false)).toBe(false);
    expect(isCodeLine("* This is a bullet", false)).toBe(false);
  });
});

describe("wrapCodeIslands", () => {
  it("wraps Codex JSDoc+TypeScript output in a typescript fence", () => {
    const input = [
      "/**",
      " * Branch ID",
      " */",
      "branch_id: string;",
      "};",
      "I have enough context and will implement now.",
    ].join("\n");

    const result = wrapCodeIslands(input);
    expect(result).toContain("```typescript");
    expect(result).toContain("/**");
    expect(result).toContain("branch_id: string;");
    expect(result).toContain("```");
    // Prose should NOT be inside the fence
    const fenceEnd = result.lastIndexOf("```");
    const proseStart = result.indexOf("I have enough");
    expect(proseStart).toBeGreaterThan(fenceEnd);
  });

  it("wraps multi-type Codex output like the screenshot scenario", () => {
    const input = [
      "/**",
      " * Branch ID",
      " */",
      "branch_id: string;",
      "};",
      "query?: never;",
      "url: '/projects/{project_id}/branches/{branch_id}/databases';",
      "export type CreateDatabaseErrors = {",
      "  /**",
      "   * Bad request - database already exists or invalid parameters",
      "   */",
      "  400: unknown;",
      "};",
      "I have enough context and will implement the full execution layer now.",
      "",
      "Plan:",
      "1. Do something",
    ].join("\n");

    const result = wrapCodeIslands(input);
    // Code section must be in a fence
    expect(result).toContain("```typescript");
    // Prose must be outside the fence
    const lastFence = result.lastIndexOf("```");
    expect(result.indexOf("I have enough")).toBeGreaterThan(lastFence);
    expect(result).toContain("Plan:");
  });

  it("does not wrap runs of fewer than 2 code-like lines", () => {
    const input = "export type Foo = string;\n\nSome prose here.";
    const result = wrapCodeIslands(input);
    // Single code line — should NOT be wrapped
    expect(result).not.toContain("```typescript");
  });

  it("leaves existing fenced blocks untouched", () => {
    const input = "```typescript\nconst x = 1;\n```\nSome prose.";
    const result = wrapCodeIslands(input);
    // Should still have exactly one fence pair — no extra wrapping
    const fenceCount = (result.match(/```/g) ?? []).length;
    expect(fenceCount).toBe(2);
  });

  it("handles content that is entirely prose with no code", () => {
    const input =
      "Here is the plan.\n\nStep one: do the thing.\n\nStep two: done.";
    const result = wrapCodeIslands(input);
    expect(result).not.toContain("```");
    expect(result).toBe(input);
  });

  it("preserves blank lines between code and prose correctly", () => {
    const input = [
      "export type Foo = {",
      "  bar: string;",
      "};",
      "",
      "This is prose after a blank line.",
    ].join("\n");

    const result = wrapCodeIslands(input);
    expect(result).toContain("```typescript");
    expect(result).toContain("This is prose after a blank line.");
    // Blank line should appear after the closing fence
    const closingFence = result.lastIndexOf("```");
    const proseIdx = result.indexOf("This is prose");
    expect(proseIdx).toBeGreaterThan(closingFence);
  });

  it("does not wrap real markdown bullet lists as code", () => {
    const input = [
      "Here are the steps:",
      "",
      "* Install dependencies",
      "* Run the tests",
      "* Deploy",
    ].join("\n");

    const result = wrapCodeIslands(input);
    expect(result).not.toContain("```typescript");
  });
});
