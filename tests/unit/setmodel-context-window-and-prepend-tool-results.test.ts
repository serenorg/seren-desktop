// ABOUTME: Critical pins for #1858 — setModel must update contextWindowSize so
// ABOUTME: mid-session [1m] upgrades stop firing auto-compact 5x early, and the
// ABOUTME: passive prepend must keep tool-result content so MCP resource IDs survive.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

/**
 * Slice a fixed-size window forward from a unique anchor. The two fixes in
 * #1858 each live in a tightly localized region, so a windowed slice keeps
 * the assertions immune to drift in unrelated code below.
 */
function regionAfter(anchor: string, len: number): string {
  const start = agentStoreSource.indexOf(anchor);
  if (start < 0) {
    throw new Error(`anchor not found in agent.store.ts: ${anchor}`);
  }
  return agentStoreSource.slice(start, start + len);
}

describe("#1858 Defect 1 — setModel updates contextWindowSize on mid-session model swap", () => {
  // Pre-#1858: setModel updated currentModelId/pendingModelId/userSelectedModelId
  // and persisted the choice to SQLite, but never recomputed contextWindowSize.
  // Switching `claude-opus-4-7` -> `claude-opus-4-7[1m]` mid-conversation left
  // the auto-compact denominator pinned at the spawn-time 200K, so compaction
  // fired at ~88% of 200K (~176K tokens) instead of waiting for ~88% of 1M
  // (~880K). All prior fixes (#1700, #1733, #1761, #1769, #1798) hardened the
  // CLI-report -> contextWindowSize path; setModel was the remaining hole.

  const setModelRegion = () =>
    regionAfter("async setModel(modelId: string, forSessionId?: string)", 1500);

  it("setModel writes contextWindowSize from defaultContextWindowFor against the new modelId", () => {
    // The picker promise is the new denominator. The CLI-report path's
    // #1798 isOneMTierMismatch guard refines this on the next promptComplete
    // if the runtime emits a different value. Without this write, the
    // denominator stays whatever the spawn picked.
    expect(setModelRegion()).toMatch(
      /setState\(\s*"sessions",\s*sessionId,\s*"contextWindowSize",\s*defaultContextWindowFor\(/,
    );
  });

  it("setModel clears contextWindowMismatchReported so the once-per-session alarm re-arms for the new tier", () => {
    // The #1798 alarm is one-shot per session. Switching to a [1m] tier must
    // reset the gate so a future CLI downgrade for the new tier is captured,
    // not silenced by a prior tier's alarm having already fired.
    expect(setModelRegion()).toMatch(
      /setState\(\s*"sessions",\s*sessionId,\s*"contextWindowMismatchReported",\s*false,?\s*\)/,
    );
  });

  it("setModel passes the session's agentType (not a hardcoded provider) into defaultContextWindowFor", () => {
    // Hardcoding "claude-code" would silently mis-tier Codex and Gemini
    // sessions if the picker is ever wired up there in the future. Use the
    // session's own agentType so the lookup stays correct across providers.
    expect(setModelRegion()).toMatch(
      /defaultContextWindowFor\(\s*[\w.?]+\.info\.agentType/,
    );
  });
});

describe("#1858 Defect 2 — passive prepend preserves tool-result content", () => {
  // Pre-#1858: the prepend builder filtered toPreserve to user/assistant only,
  // dropping every `tool` message. MCP tool results (Google Sheets spreadsheet
  // IDs, SerenDB project handles, R2 keys, ...) ride on toolCall.result and
  // were lost on every compaction. The structured summary template has no
  // resource-id slot, so opaque handles got summarized away and the user had
  // to re-supply them post-compaction.

  // Anchor on the unique "Build the structured prepend up-front" comment that
  // introduces the prepend-builder block in compactAgentConversation. This
  // keeps assertions inside the prepend region only — not the toCompact
  // serialization above it nor the post-prepend spawn flows below.
  const prependRegion = () =>
    regionAfter("Build the structured prepend up-front", 2500);

  it("prepend builder includes m.type === \"tool\" alongside user/assistant", () => {
    // The filter must allow tool messages through. Pre-fix shape was a literal
    // .filter((m) => m.type === "user" || m.type === "assistant") which silently
    // dropped tool. Pin the presence of the "tool" branch.
    expect(prependRegion()).toMatch(/m\.type\s*===\s*"tool"/);
  });

  it("prepend builder reads toolCall.result so the actual MCP payload is what gets prepended", () => {
    // The result string is the only field carrying the resource handle the
    // compaction needs to preserve. toolCall.title alone is not enough —
    // titles are e.g. "search google" with no payload.
    expect(prependRegion()).toMatch(/toolCall(?:\?\.|\.)result/);
  });

  it("prepend builder applies a tighter character cap to tool results than to user/assistant turns", () => {
    // Tool results can be huge (full file contents, JSON dumps). Capping
    // them at the same 2000-char ceiling as user/assistant turns lets a
    // single verbose tool result dominate the prepend. The fix introduces
    // a tighter MAX_TOOL_CHARS or equivalent literal.
    expect(prependRegion()).toMatch(/MAX_TOOL_CHARS\s*=\s*\d+/);
  });
});
