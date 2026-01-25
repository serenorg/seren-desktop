// ABOUTME: Utility helpers for categorizing MCP tools by risk level.

export type McpToolRiskLevel = "low" | "medium" | "high";

const LOW_RISK_PREFIXES = ["read_", "list_", "get_"];
const MEDIUM_RISK_PREFIXES = ["write_", "create_", "update_"];
const HIGH_RISK_PREFIXES = ["delete_", "remove_", "execute_"];

export function getToolRiskLevel(toolName: string): McpToolRiskLevel {
  const normalized = toolName.toLowerCase();

  if (HIGH_RISK_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "high";
  }

  if (MEDIUM_RISK_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "medium";
  }

  if (LOW_RISK_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "low";
  }

  return "medium";
}

export function getRiskLabel(level: McpToolRiskLevel): string {
  switch (level) {
    case "low":
      return "Low Risk";
    case "high":
      return "High Risk";
    default:
      return "Medium Risk";
  }
}
