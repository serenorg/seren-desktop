// ABOUTME: Pins the post-Add-removal contract on the Skills panel.
// ABOUTME: Skills are tools-on-demand — no auto-attach to the active thread.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve("src/components/sidebar/SkillsExplorer.tsx"),
  "utf-8",
);

const chatContent = readFileSync(
  resolve("src/components/chat/ChatContent.tsx"),
  "utf-8",
);

const agentChat = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

const skillDrag = readFileSync(resolve("src/lib/skill-drag.ts"), "utf-8");

const threadContent = readFileSync(
  resolve("src/components/layout/ThreadContent.tsx"),
  "utf-8",
);

function handlerBody(source: string, signature: string): string {
  const idx = source.indexOf(signature);
  if (idx < 0) return "";
  // Walk forward from the handler signature until braces balance to zero.
  let depth = 0;
  let started = false;
  for (let i = idx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      started = true;
    } else if (ch === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(idx, i + 1);
    }
  }
  return source.slice(idx);
}

describe("SkillsExplorer panel verb cleanup", () => {
  it("no longer exposes the Add button on installed-skill rows", () => {
    expect(source).not.toContain("handleAddInstalledSkill");
    expect(source).not.toContain("activeThreadHasSkill");
    expect(source).not.toContain("addActionTitle");
  });

  it("does not auto-attach catalog installs to the active thread", () => {
    expect(source).not.toContain("attachInstalledToActiveThread");
    // The catalog install handler is still here; the side-effect call is gone.
    expect(source).toContain("handleAddCatalogSkill");
  });

  it("skill drag into chat or agent panes drafts a run event instead of attaching", () => {
    expect(skillDrag).toContain("draftSkillInvocationFromDrag");
    expect(skillDrag).toContain("RUN_SKILL_EVENT");
    expect(skillDrag).not.toContain("attachSkillToThread");
    expect(chatContent).toContain("draftSkillInvocationFromDrag");
    expect(agentChat).toContain("draftSkillInvocationFromDrag");
    expect(threadContent).toContain("draftSkillInvocationFromDrag");
    expect(chatContent).not.toContain("attachSkillFromDrag");
    expect(agentChat).not.toContain("attachSkillFromDrag");
    expect(threadContent).not.toContain("attachSkillFromDrag");
  });

  it("does not advertise the dropped 'Install and Add' / 'Install and Paste' labels", () => {
    expect(source).not.toContain("Install and Add");
    expect(source).not.toContain("Install and Paste");
  });

  it("keeps the Run button as the sole invocation surface in the panel", () => {
    expect(source).toContain("handleRunSkill");
    expect(source).toContain("Insert /slug into the active chat composer");
  });

  it("Run no longer auto-sends — ChatContent handler only fills the composer", () => {
    const handler = handlerBody(
      chatContent,
      "const handleRunSkillEvent =",
    );
    expect(handler).toContain("setInput");
    expect(handler).not.toContain("sendMessageImmediate");
    expect(handler).not.toContain("buildSkillInvocationDirective");
  });

  it("Run no longer auto-sends — AgentChat handler only fills the composer", () => {
    const handler = handlerBody(agentChat, "const handleRunSkillEvent =");
    expect(handler).toContain("setInput");
    expect(handler).not.toContain("agentStore.sendPrompt");
    expect(handler).not.toContain("buildSkillInvocationDirective");
  });
});
