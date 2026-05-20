// ABOUTME: Centralized reset for user-scoped client state.
// ABOUTME: Keeps logout cleanup in one boundary instead of scattered store calls.

import { queryClient } from "@/lib/query-client";
import { agentStore } from "@/stores/agent.store";
import { resetAgentTasksState } from "@/stores/agent-tasks.store";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { chatStore } from "@/stores/chat.store";
import { conversationStore } from "@/stores/conversation.store";
import { employeeStore } from "@/stores/employees.store";
import { indexingStore } from "@/stores/indexing.store";
import { resetMcpChatState } from "@/stores/mcp-chat.store";
import { projectStore } from "@/stores/project.store";
import { sessionStore } from "@/stores/session.store";
import { threadStore } from "@/stores/thread.store";
import { resetWalletState } from "@/stores/wallet.store";
import { workspaceStore } from "@/stores/workspace.store";

export function resetUserSessionState(): void {
  queryClient.clear();
  autocompleteStore.disable();
  chatStore.resetSessionState();
  conversationStore.resetSessionState();
  agentStore.resetSessionState();
  resetMcpChatState();
  employeeStore.clear();
  threadStore.clear();
  workspaceStore.reset();
  projectStore.clear();
  sessionStore.clear();
  resetWalletState();
  resetAgentTasksState();
  indexingStore.reset();
}
