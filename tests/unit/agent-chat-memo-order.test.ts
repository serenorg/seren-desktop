// ABOUTME: Verifies no forward references to threadSession before its declaration in AgentChat.
// ABOUTME: Prevents TDZ crash when SolidJS eagerly evaluates memos during selectThread.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("AgentChat memo declaration order", () => {
  const source = readFileSync(
    resolve("src/components/chat/AgentChat.tsx"),
    "utf-8",
  );

  it("threadValidationRun is declared after threadSession", () => {
    const sessionDeclPos = source.indexOf("const threadSession = createMemo");
    const validationDeclPos = source.indexOf(
      "const threadValidationRun = createMemo",
    );

    expect(sessionDeclPos).toBeGreaterThan(-1);
    expect(validationDeclPos).toBeGreaterThan(-1);
    expect(validationDeclPos).toBeGreaterThan(sessionDeclPos);
  });

  it("no createMemo calls threadSession() before its declaration", () => {
    const sessionDeclPos = source.indexOf("const threadSession = createMemo");
    const beforeDecl = source.slice(0, sessionDeclPos);
    // Check that no createMemo in the region before threadSession's
    // declaration contains a call to threadSession()
    const memoBlocks = beforeDecl.match(/createMemo\(\(\) => \{[^}]*\}/g) ?? [];
    for (const block of memoBlocks) {
      expect(block).not.toContain("threadSession()");
    }
  });
});
