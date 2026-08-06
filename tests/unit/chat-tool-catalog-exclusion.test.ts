// ABOUTME: Verifies model-selection gateway tools are excluded from the chat catalog (#3721).
// ABOUTME: A chat turn answers as the picked model; it must not be able to look up or switch models.

import { beforeEach, describe, expect, it, vi } from "vitest";

const builtinSchemas = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("@/lib/mcp/client", () => ({
  mcpClient: { getAllTools: () => [] },
}));
vi.mock("@/services/mcp-gateway", () => ({
  getBuiltinToolSchemas: () => builtinSchemas.current,
  getGatewayTools: () => [],
}));
vi.mock("@/stores/settings.store", () => ({
  getActiveToolsetPublishers: () => null,
}));

import { getAllTools } from "@/lib/tools/definitions";

describe("chat tool catalog model-selection exclusion (#3721)", () => {
  beforeEach(() => {
    builtinSchemas.current = [
      { name: "call_publisher", description: "Call a publisher" },
      { name: "list_agent_publishers", description: "List publishers" },
      { name: "chat_private_models", description: "Chat with a private model" },
      {
        name: "list_seren_agent_private_models",
        description: "List private models",
      },
      { name: "list_private_models", description: "List private models" },
      { name: "run_sql", description: "Run a SQL query" },
    ];
  });

  it("excludes the three model-selection tools from the chat catalog", () => {
    const names = getAllTools("moonshotai/kimi-k3").map((t) => t.function.name);
    expect(names).not.toContain("seren__chat_private_models");
    expect(names).not.toContain("seren__list_seren_agent_private_models");
    expect(names).not.toContain("seren__list_private_models");
  });

  it("keeps call_publisher and ordinary built-in tools available", () => {
    const names = getAllTools("moonshotai/kimi-k3").map((t) => t.function.name);
    expect(names).toContain("seren__call_publisher");
    expect(names).toContain("seren__list_agent_publishers");
    expect(names).toContain("seren__run_sql");
  });
});
