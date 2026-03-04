// ABOUTME: Tests for directory listing detection and collapse utilities.
// ABOUTME: Covers ls -l, find output, bare path listings, traversal errors, and tree output.

import { describe, expect, it } from "vitest";
import {
  isDirectoryListing,
  summarizeDirectoryListing,
  collapseDirectoryListings,
} from "@/lib/directory-listing";

describe("isDirectoryListing", () => {
  it("detects ls -l output", () => {
    const text = [
      "total 48",
      "drwxr-xr-x  10 user  staff   320 Mar  1 12:00 .",
      "drwxr-xr-x   5 user  staff   160 Mar  1 12:00 ..",
      "-rw-r--r--   1 user  staff  1024 Mar  1 12:00 file1.ts",
      "-rw-r--r--   1 user  staff  2048 Mar  1 12:00 file2.ts",
      "-rw-r--r--   1 user  staff   512 Mar  1 12:00 file3.ts",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(true);
  });

  it("detects bare Unix path listings from find", () => {
    const text = [
      "/Users/alice/Projects/app/src/index.ts",
      "/Users/alice/Projects/app/src/main.ts",
      "/Users/alice/Projects/app/src/utils.ts",
      "/Users/alice/Projects/app/src/config.ts",
      "/Users/alice/Projects/app/src/routes.ts",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(true);
  });

  it("detects Windows path listings", () => {
    const text = [
      "C:\\Users\\ishan\\Projects\\app\\src\\index.ts",
      "C:\\Users\\ishan\\Projects\\app\\src\\main.ts",
      "C:\\Users\\ishan\\Projects\\app\\src\\utils.ts",
      "C:\\Users\\ishan\\Projects\\app\\src\\config.ts",
      "C:\\Users\\ishan\\Projects\\app\\src\\routes.ts",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(true);
  });

  it("detects macOS permission error output", () => {
    const text = [
      "/Users/alice/Library/AppleMediaServices: Operation not permitted (os error 1)",
      "/Users/alice/Library/Calendars: Operation not permitted (os error 1)",
      "/Users/alice/Library/Photos: Operation not permitted (os error 1)",
      "/Users/alice/Library/Mail: Operation not permitted (os error 1)",
      "/Users/alice/Library/Safari: Operation not permitted (os error 1)",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(true);
  });

  it("detects find error output", () => {
    const text = [
      "find: '/root/.ssh': Permission denied",
      "find: '/root/.gnupg': Permission denied",
      "find: '/root/.cache': Permission denied",
      "find: '/root/.config': Permission denied",
      "find: '/root/.local': Permission denied",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(true);
  });

  it("detects tree command output", () => {
    const text = [
      "├── src",
      "│   ├── index.ts",
      "│   ├── utils.ts",
      "│   └── config.ts",
      "├── package.json",
      "└── tsconfig.json",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(true);
  });

  it("detects mixed paths and errors", () => {
    const text = [
      "/Users/alice/Library/Caches/com.apple.Safari",
      "/Users/alice/Library/Mail: Operation not permitted (os error 1)",
      "/Users/alice/Library/Containers/com.apple.Photos",
      "/Users/alice/Library/Group Containers: Permission denied",
      "/Users/alice/Library/Preferences/com.apple.finder.plist",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(true);
  });

  it("returns false for normal text", () => {
    const text = [
      "Here is some explanation of the code.",
      "The function takes two parameters.",
      "It returns a boolean value.",
      "This is used in the chat panel.",
      "Let me know if you have questions.",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(false);
  });

  it("returns false for code blocks", () => {
    const text = [
      "function hello() {",
      '  console.log("hello");',
      "  return true;",
      "}",
      "",
      "hello();",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(false);
  });

  it("requires MIN_CONSECUTIVE lines to trigger", () => {
    const text = [
      "/Users/alice/file1.ts",
      "/Users/alice/file2.ts",
      "/Users/alice/file3.ts",
      "/Users/alice/file4.ts",
      "some normal text here",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(false);
  });

  it("resets consecutive count on non-matching lines", () => {
    const text = [
      "/Users/alice/file1.ts",
      "/Users/alice/file2.ts",
      "--- some separator ---",
      "/Users/alice/file3.ts",
      "/Users/alice/file4.ts",
    ].join("\n");
    expect(isDirectoryListing(text)).toBe(false);
  });
});

describe("summarizeDirectoryListing", () => {
  it("summarizes path listings with entry count", () => {
    const text = [
      "/Users/alice/Projects/app/src/index.ts",
      "/Users/alice/Projects/app/src/main.ts",
      "/Users/alice/Projects/app/src/utils.ts",
    ].join("\n");
    expect(summarizeDirectoryListing(text)).toBe("File listing (3 entries)");
  });

  it("summarizes error output with error label", () => {
    const text = [
      "/Users/alice/Library/Mail: Operation not permitted (os error 1)",
      "/Users/alice/Library/Safari: Operation not permitted (os error 1)",
    ].join("\n");
    expect(summarizeDirectoryListing(text)).toBe(
      "File listing with errors (2 lines)",
    );
  });

  it("summarizes find errors with error label", () => {
    const text = [
      "find: '/root/.ssh': Permission denied",
      "find: '/root/.cache': Permission denied",
    ].join("\n");
    expect(summarizeDirectoryListing(text)).toBe(
      "File listing with errors (2 lines)",
    );
  });

  it("uses singular for single entry", () => {
    const text = "/Users/alice/file.ts";
    expect(summarizeDirectoryListing(text)).toBe("File listing (1 entry)");
  });
});

describe("collapseDirectoryListings", () => {
  it("wraps path listing in pre/code blocks with details", () => {
    const paths = Array.from(
      { length: 6 },
      (_, i) => `/Users/alice/file${i}.ts`,
    ).join("\n");
    const html = `<pre><code>${paths}</code></pre>`;
    const result = collapseDirectoryListings(html);
    expect(result).toContain("<details");
    expect(result).toContain("File listing (6 entries)");
    expect(result).toContain("</details>");
  });

  it("wraps br-separated path listing with details", () => {
    const paths = Array.from(
      { length: 6 },
      (_, i) => `/Users/alice/file${i}.ts`,
    ).join("<br>");
    const result = collapseDirectoryListings(paths);
    expect(result).toContain("<details");
    expect(result).toContain("File listing (6 entries)");
  });

  it("does not collapse normal text", () => {
    const html = "This is a normal message about file handling.";
    expect(collapseDirectoryListings(html)).toBe(html);
  });

  it("handles HTML-encoded paths in pre blocks", () => {
    const paths = Array.from(
      { length: 6 },
      (_, i) => `/Users/alice/project&amp;app/file${i}.ts`,
    ).join("\n");
    const html = `<pre><code>${paths}</code></pre>`;
    const result = collapseDirectoryListings(html);
    expect(result).toContain("<details");
  });
});
