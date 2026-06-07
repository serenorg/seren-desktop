// ABOUTME: Critical coverage for #2115 chat compaction request-overhead accounting.
// ABOUTME: Ensures tool schemas, system prompt, and skills affect the trigger estimate.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  estimateChatRequestTokens,
  type ChatSkillEstimate,
} from "@/lib/compaction/chat-request-accounting";

describe("#2115 estimateChatRequestTokens", () => {
  it("counts system prompt, tool schemas, and skill metadata even when messages are unchanged", () => {
    const messages = [{ content: "same user-visible conversation" }];
    const base = estimateChatRequestTokens({ messages });

    const skills: ChatSkillEstimate[] = [
      {
        slug: "large-skill",
        name: "Large Skill",
        description: "z".repeat(4000),
        tags: ["automation", "context"],
        path: "/Users/example/.config/seren/skills/large-skill/SKILL.md",
      },
    ];

    const withOverhead = estimateChatRequestTokens({
      messages,
      systemPrompt: "x".repeat(4000),
      toolSchemas: [
        {
          type: "function",
          function: {
            name: "large_tool",
            description: "y".repeat(4000),
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
      ],
      skills,
    });

    expect(withOverhead.messageTokens).toBe(base.messageTokens);
    expect(withOverhead.systemPromptTokens).toBeGreaterThan(900);
    expect(withOverhead.toolSchemaTokens).toBeGreaterThan(900);
    expect(withOverhead.skillTokens).toBeGreaterThan(900);
    expect(withOverhead.totalTokens).toBeGreaterThan(base.totalTokens + 2700);
  });

  it("includes compacted-summary injection and optional dynamic context reserve", () => {
    const estimate = estimateChatRequestTokens({
      messages: [{ content: "tail" }],
      compactedSummary:
        "ACTIVE_TASK: audit compaction\nRESOURCES: src/stores/chat.store.ts",
      dynamicContextReserveTokens: 2048,
    });

    expect(estimate.compactedSummaryTokens).toBeGreaterThan(0);
    expect(estimate.dynamicContextReserveTokens).toBe(2048);
    expect(estimate.totalTokens).toBe(
      estimate.messageTokens +
        estimate.systemPromptTokens +
        estimate.toolSchemaTokens +
        estimate.skillTokens +
        estimate.compactedSummaryTokens +
        estimate.dynamicContextReserveTokens,
    );
  });
});

describe("#2115 chatStore wiring", () => {
  it("uses chat request accounting instead of message-only request accounting", () => {
    const chatStore = readFileSync(
      resolve("src/stores/chat.store.ts"),
      "utf-8",
    );

    expect(chatStore).toContain("estimateActiveChatRequestTokens(");
    expect(chatStore).not.toContain("estimateRequestTokens({\n      messages");
  });
});
