// ABOUTME: Source-level regression tests for #1631 — deleted visible-restart UI.
// ABOUTME: Guards the deletion of the green button, compaction notice, and
// ABOUTME: the "Agent session restarted" system message.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

describe("#1631 — green 'Reconnecting Thread' fallback deleted", () => {
  it("AgentChat does not render the 'Reconnecting {agent} Thread' heading", () => {
    expect(agentChatSource).not.toContain("Reconnecting {lockedAgentName()}");
    expect(agentChatSource).not.toContain('"Reconnecting..."');
  });

  it("retrySessionConnection symbol is gone", () => {
    expect(agentChatSource).not.toContain("retrySessionConnection");
  });
});

describe("#1631 — compaction notice deleted (agent)", () => {
  it("AgentChat no longer imports CompactedMessage", () => {
    expect(agentChatSource).not.toContain(
      'from "@/components/chat/CompactedMessage"',
    );
    expect(agentChatSource).not.toContain("<CompactedMessage");
  });

  it("agent.store does not construct a compactionNotice AgentMessage", () => {
    expect(agentStoreSource).not.toContain("const compactionNotice:");
    expect(agentStoreSource).not.toContain(
      "Context compacted:",
    );
  });

  it("preCompactionMessages field removed from AgentCompactedSummary", () => {
    expect(agentStoreSource).not.toContain("preCompactionMessages");
    expect(agentStoreSource).not.toContain("interface PreCompactionMessage");
  });
});

describe("#1631 — recovery system messages deleted", () => {
  it('agent.store does not emit "Agent session restarted"', () => {
    expect(agentStoreSource).not.toContain(
      "Agent session restarted due to inactivity timeout",
    );
    expect(agentStoreSource).not.toContain(
      "Session restarted after cancellation",
    );
  });
});

describe("#1631 — UI history decoupled from model context", () => {
  it("reactive compaction inherits the full transcript on the new session", () => {
    // The new session's messages array is set from `session.messages`
    // (full scrollback) rather than a compactionNotice + toPreserve slice.
    expect(agentStoreSource).toContain(
      '"messages", fullTranscript',
    );
  });
});
