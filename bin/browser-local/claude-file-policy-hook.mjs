#!/usr/bin/env node
// ABOUTME: Claude PreToolUse hook that enforces Seren's project-root policy in bypass mode.
// ABOUTME: Emits only denials so approved in-project work remains promptless.

import { evaluateFileAccess } from "./file-access-policy.mjs";

const input = await new Promise((resolve) => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  process.stdin.on("end", () => {
    try {
      resolve(JSON.parse(raw));
    } catch {
      resolve({});
    }
  });
});

const toolName = input?.tool_name;
const toolInput = input?.tool_input ?? {};
const pathFields = {
  Read: ["file_path", "read"],
  Edit: ["file_path", "write"],
  Write: ["file_path", "write"],
  Glob: ["path", "read"],
  Grep: ["path", "read"],
  NotebookEdit: ["notebook_path", "write"],
};

let permissionDecision = null;
let permissionDecisionReason = null;
if (
  (toolName === "WebFetch" || toolName === "WebSearch") &&
  process.env.SEREN_AGENT_NETWORK_ENABLED === "false"
) {
  permissionDecision = "deny";
  permissionDecisionReason = "Network access is disabled in Settings → Agent.";
} else if (pathFields[toolName]) {
  const [field, kind] = pathFields[toolName];
  const requestedPath = toolInput[field] ?? process.env.SEREN_AGENT_PROJECT_ROOT;
  const result = evaluateFileAccess({
    requestedPath,
    projectRoot: process.env.SEREN_AGENT_PROJECT_ROOT,
    kind,
    sandboxMode: process.env.SEREN_AGENT_SANDBOX_MODE,
    approvalPolicy: process.env.SEREN_AGENT_APPROVAL_POLICY,
    autoApproveReads: process.env.SEREN_AGENT_AUTO_APPROVE_READS !== "false",
  });
  if (result.decision === "require_approval") {
    permissionDecision = "ask";
    permissionDecisionReason =
      "This file is outside the active project and needs one-time approval.";
  } else if (result.decision === "deny") {
    permissionDecision = "deny";
    permissionDecisionReason =
      result.reason ??
      "File access is outside the active project. Select Full Access in Settings → Agent to allow it.";
  }
}

if (permissionDecision) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason,
      },
    }),
  );
}
