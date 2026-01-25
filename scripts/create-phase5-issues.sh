#!/bin/bash

# Phase 5: MCP Integration Issues (#43-#52)
# Run this script to create all Phase 5 GitHub issues

set -e

REPO="serenorg/seren-desktop"

echo "Creating Phase 5 issues for MCP Integration..."

# Issue #43: MCP Protocol Types
gh issue create --repo "$REPO" \
  --title "Define MCP protocol TypeScript types and interfaces" \
  --label "phase:5-mcp,component:mcp,priority:high,agent: codex" \
  --body "## Overview
Define complete TypeScript types for MCP (Model Context Protocol) client implementation.

## Technical Requirements

### Type Definitions
Create \`src/lib/mcp/types.ts\`:
\`\`\`typescript
// MCP Protocol Types
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, McpPropertySchema>;
    required?: string[];
  };
}

export interface McpPropertySchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: McpPropertySchema;
  default?: unknown;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string } };

export interface McpError {
  code: number;
  message: string;
  data?: unknown;
}

// JSON-RPC types for MCP transport
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: McpError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
\`\`\`

## Files to Create
- \`src/lib/mcp/types.ts\`

## Definition of Done
- [ ] All MCP protocol types defined
- [ ] JSON-RPC transport types included
- [ ] Types exported from mcp module index
- [ ] No TypeScript errors"

# Issue #44: MCP Client Service
gh issue create --repo "$REPO" \
  --title "Implement MCP client service with JSON-RPC transport" \
  --label "phase:5-mcp,component:mcp,priority:high,agent: codex" \
  --body "## Overview
Implement MCP client service that communicates with MCP servers via stdio or WebSocket.

## Technical Requirements

### MCP Client Implementation
Create \`src/lib/mcp/client.ts\`:
\`\`\`typescript
import { createSignal } from 'solid-js';
import type {
  McpTool,
  McpResource,
  McpInitializeResult,
  McpToolCall,
  McpToolResult,
  JsonRpcRequest,
  JsonRpcResponse
} from './types';

export interface McpConnection {
  serverName: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  capabilities: McpInitializeResult | null;
  tools: McpTool[];
  resources: McpResource[];
}

export function createMcpClient() {
  const [connections, setConnections] = createSignal<Map<string, McpConnection>>(new Map());
  const [pendingRequests] = createSignal<Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>>(new Map());

  let requestId = 0;

  async function connect(serverName: string, command: string, args: string[]): Promise<void> {
    setConnections(prev => {
      const next = new Map(prev);
      next.set(serverName, {
        serverName,
        status: 'connecting',
        capabilities: null,
        tools: [],
        resources: []
      });
      return next;
    });

    try {
      // Spawn MCP server process via Tauri
      const result = await invoke<McpInitializeResult>('mcp_connect', {
        serverName,
        command,
        args
      });

      // Fetch available tools
      const tools = await listTools(serverName);
      const resources = await listResources(serverName);

      setConnections(prev => {
        const next = new Map(prev);
        next.set(serverName, {
          serverName,
          status: 'connected',
          capabilities: result,
          tools,
          resources
        });
        return next;
      });
    } catch (error) {
      setConnections(prev => {
        const next = new Map(prev);
        const conn = next.get(serverName);
        if (conn) {
          next.set(serverName, { ...conn, status: 'error' });
        }
        return next;
      });
      throw error;
    }
  }

  async function disconnect(serverName: string): Promise<void> {
    await invoke('mcp_disconnect', { serverName });
    setConnections(prev => {
      const next = new Map(prev);
      next.delete(serverName);
      return next;
    });
  }

  async function listTools(serverName: string): Promise<McpTool[]> {
    return invoke<McpTool[]>('mcp_list_tools', { serverName });
  }

  async function listResources(serverName: string): Promise<McpResource[]> {
    return invoke<McpResource[]>('mcp_list_resources', { serverName });
  }

  async function callTool(serverName: string, call: McpToolCall): Promise<McpToolResult> {
    return invoke<McpToolResult>('mcp_call_tool', {
      serverName,
      toolName: call.name,
      arguments: call.arguments
    });
  }

  async function readResource(serverName: string, uri: string): Promise<string> {
    return invoke<string>('mcp_read_resource', { serverName, uri });
  }

  return {
    connections,
    connect,
    disconnect,
    listTools,
    listResources,
    callTool,
    readResource
  };
}

export const mcpClient = createMcpClient();
\`\`\`

## Rust Backend Commands
Add to \`src-tauri/src/mcp.rs\`:
\`\`\`rust
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

pub struct McpState {
    processes: Mutex<HashMap<String, Child>>,
}

#[tauri::command]
pub async fn mcp_connect(
    state: State<'_, McpState>,
    server_name: String,
    command: String,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    let child = Command::new(&command)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    // Send initialize request
    // ... JSON-RPC communication

    state.processes.lock().unwrap().insert(server_name, child);
    Ok(serde_json::json!({}))
}

#[tauri::command]
pub async fn mcp_disconnect(
    state: State<'_, McpState>,
    server_name: String,
) -> Result<(), String> {
    if let Some(mut child) = state.processes.lock().unwrap().remove(&server_name) {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, McpState>,
    server_name: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Send tools/call request via JSON-RPC
    // Return result
    Ok(serde_json::json!({}))
}
\`\`\`

## Files to Create/Modify
- \`src/lib/mcp/client.ts\`
- \`src-tauri/src/mcp.rs\`
- \`src-tauri/src/main.rs\` (register commands)

## Definition of Done
- [ ] MCP client connects to servers via stdio
- [ ] Tool listing works
- [ ] Resource listing works
- [ ] Tool calls execute and return results
- [ ] Clean disconnection"

# Issue #45: MCP Server Configuration
gh issue create --repo "$REPO" \
  --title "Implement MCP server configuration management" \
  --label "phase:5-mcp,component:mcp,component:settings,priority:high,agent: codex" \
  --body "## Overview
Allow users to configure and manage MCP servers through settings.

## Technical Requirements

### Configuration Types
\`\`\`typescript
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
  autoConnect: boolean;
}

export interface McpSettings {
  servers: McpServerConfig[];
  defaultTimeout: number; // ms
}
\`\`\`

### Settings UI Component
Create \`src/components/settings/McpServersPanel.tsx\`:
\`\`\`typescript
import { For, createSignal, Show } from 'solid-js';
import { mcpSettings, updateMcpSettings } from '../../stores/settings';

export function McpServersPanel() {
  const [editingServer, setEditingServer] = createSignal<string | null>(null);
  const [newServer, setNewServer] = createSignal<Partial<McpServerConfig>>({});

  function addServer() {
    const server = newServer();
    if (!server.name || !server.command) return;

    updateMcpSettings(prev => ({
      ...prev,
      servers: [...prev.servers, {
        name: server.name!,
        command: server.command!,
        args: server.args || [],
        env: server.env || {},
        enabled: true,
        autoConnect: false
      }]
    }));
    setNewServer({});
  }

  function removeServer(name: string) {
    updateMcpSettings(prev => ({
      ...prev,
      servers: prev.servers.filter(s => s.name !== name)
    }));
  }

  function toggleServer(name: string) {
    updateMcpSettings(prev => ({
      ...prev,
      servers: prev.servers.map(s =>
        s.name === name ? { ...s, enabled: !s.enabled } : s
      )
    }));
  }

  return (
    <div class=\"mcp-servers-panel\">
      <h3>MCP Servers</h3>

      <div class=\"server-list\">
        <For each={mcpSettings().servers}>
          {(server) => (
            <div class=\"server-item\">
              <div class=\"server-info\">
                <span class=\"server-name\">{server.name}</span>
                <span class=\"server-command\">{server.command}</span>
              </div>
              <div class=\"server-actions\">
                <button onClick={() => toggleServer(server.name)}>
                  {server.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => removeServer(server.name)}>
                  Remove
                </button>
              </div>
            </div>
          )}
        </For>
      </div>

      <div class=\"add-server\">
        <h4>Add MCP Server</h4>
        <input
          placeholder=\"Server name\"
          value={newServer().name || ''}
          onInput={(e) => setNewServer(prev => ({ ...prev, name: e.target.value }))}
        />
        <input
          placeholder=\"Command (e.g., npx)\"
          value={newServer().command || ''}
          onInput={(e) => setNewServer(prev => ({ ...prev, command: e.target.value }))}
        />
        <input
          placeholder=\"Args (comma-separated)\"
          onInput={(e) => setNewServer(prev => ({
            ...prev,
            args: e.target.value.split(',').map(s => s.trim())
          }))}
        />
        <button onClick={addServer}>Add Server</button>
      </div>
    </div>
  );
}
\`\`\`

### Persistence
Store MCP configuration in app data directory alongside other settings.

## Files to Create/Modify
- \`src/components/settings/McpServersPanel.tsx\`
- \`src/stores/settings.ts\` (add MCP settings)
- \`src/lib/mcp/types.ts\` (add config types)

## Definition of Done
- [ ] MCP servers can be added via UI
- [ ] Servers can be enabled/disabled
- [ ] Servers can be removed
- [ ] Configuration persists across restarts
- [ ] Auto-connect option works"

# Issue #46: MCP Tools Panel
gh issue create --repo "$REPO" \
  --title "Create MCP tools discovery and execution panel" \
  --label "phase:5-mcp,component:mcp,component:ui,priority:medium,agent: codex" \
  --body "## Overview
Create a panel showing available MCP tools from connected servers with ability to execute them.

## Technical Requirements

### Tools Panel Component
Create \`src/components/mcp/ToolsPanel.tsx\`:
\`\`\`typescript
import { For, Show, createSignal } from 'solid-js';
import { mcpClient } from '../../lib/mcp/client';
import type { McpTool, McpToolResult } from '../../lib/mcp/types';

export function ToolsPanel() {
  const [selectedTool, setSelectedTool] = createSignal<{server: string; tool: McpTool} | null>(null);
  const [toolArgs, setToolArgs] = createSignal<Record<string, unknown>>({});
  const [result, setResult] = createSignal<McpToolResult | null>(null);
  const [executing, setExecuting] = createSignal(false);

  async function executeTool() {
    const selected = selectedTool();
    if (!selected) return;

    setExecuting(true);
    setResult(null);

    try {
      const res = await mcpClient.callTool(selected.server, {
        name: selected.tool.name,
        arguments: toolArgs()
      });
      setResult(res);
    } catch (error) {
      setResult({
        content: [{ type: 'text', text: \`Error: \${error}\` }],
        isError: true
      });
    } finally {
      setExecuting(false);
    }
  }

  return (
    <div class=\"tools-panel\">
      <h3>MCP Tools</h3>

      <div class=\"tools-list\">
        <For each={Array.from(mcpClient.connections().entries())}>
          {([serverName, connection]) => (
            <div class=\"server-tools\">
              <h4>{serverName}</h4>
              <For each={connection.tools}>
                {(tool) => (
                  <div
                    class=\"tool-item\"
                    classList={{ selected: selectedTool()?.tool.name === tool.name }}
                    onClick={() => {
                      setSelectedTool({ server: serverName, tool });
                      setToolArgs({});
                      setResult(null);
                    }}
                  >
                    <span class=\"tool-name\">{tool.name}</span>
                    <span class=\"tool-desc\">{tool.description}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>

      <Show when={selectedTool()}>
        {(selected) => (
          <div class=\"tool-detail\">
            <h4>{selected().tool.name}</h4>
            <p>{selected().tool.description}</p>

            <div class=\"tool-inputs\">
              <For each={Object.entries(selected().tool.inputSchema.properties)}>
                {([name, schema]) => (
                  <div class=\"input-field\">
                    <label>{name}</label>
                    <input
                      type={schema.type === 'number' ? 'number' : 'text'}
                      placeholder={schema.description}
                      onInput={(e) => setToolArgs(prev => ({
                        ...prev,
                        [name]: schema.type === 'number'
                          ? Number(e.target.value)
                          : e.target.value
                      }))}
                    />
                  </div>
                )}
              </For>
            </div>

            <button onClick={executeTool} disabled={executing()}>
              {executing() ? 'Executing...' : 'Execute Tool'}
            </button>

            <Show when={result()}>
              {(res) => (
                <div class=\"tool-result\" classList={{ error: res().isError }}>
                  <For each={res().content}>
                    {(content) => (
                      <Show when={content.type === 'text'}>
                        <pre>{(content as any).text}</pre>
                      </Show>
                    )}
                  </For>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
\`\`\`

## Files to Create
- \`src/components/mcp/ToolsPanel.tsx\`
- \`src/components/mcp/ToolsPanel.css\`

## Definition of Done
- [ ] Panel shows tools from all connected servers
- [ ] Tool selection shows input form
- [ ] Tool execution works with arguments
- [ ] Results display correctly
- [ ] Error states handled"

# Issue #47: MCP Resources Panel
gh issue create --repo "$REPO" \
  --title "Create MCP resources browser panel" \
  --label "phase:5-mcp,component:mcp,component:ui,priority:medium,agent: codex" \
  --body "## Overview
Create a panel for browsing and reading MCP resources from connected servers.

## Technical Requirements

### Resources Panel Component
Create \`src/components/mcp/ResourcesPanel.tsx\`:
\`\`\`typescript
import { For, Show, createSignal } from 'solid-js';
import { mcpClient } from '../../lib/mcp/client';
import type { McpResource } from '../../lib/mcp/types';

export function ResourcesPanel() {
  const [selectedResource, setSelectedResource] = createSignal<{server: string; resource: McpResource} | null>(null);
  const [content, setContent] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  async function loadResource() {
    const selected = selectedResource();
    if (!selected) return;

    setLoading(true);
    setContent(null);

    try {
      const data = await mcpClient.readResource(selected.server, selected.resource.uri);
      setContent(data);
    } catch (error) {
      setContent(\`Error loading resource: \${error}\`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class=\"resources-panel\">
      <h3>MCP Resources</h3>

      <div class=\"resources-list\">
        <For each={Array.from(mcpClient.connections().entries())}>
          {([serverName, connection]) => (
            <div class=\"server-resources\">
              <h4>{serverName}</h4>
              <For each={connection.resources}>
                {(resource) => (
                  <div
                    class=\"resource-item\"
                    classList={{ selected: selectedResource()?.resource.uri === resource.uri }}
                    onClick={() => {
                      setSelectedResource({ server: serverName, resource });
                      setContent(null);
                    }}
                  >
                    <span class=\"resource-name\">{resource.name}</span>
                    <span class=\"resource-uri\">{resource.uri}</span>
                    <Show when={resource.mimeType}>
                      <span class=\"resource-mime\">{resource.mimeType}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>

      <Show when={selectedResource()}>
        {(selected) => (
          <div class=\"resource-detail\">
            <h4>{selected().resource.name}</h4>
            <p>{selected().resource.description}</p>
            <p class=\"uri\">{selected().resource.uri}</p>

            <button onClick={loadResource} disabled={loading()}>
              {loading() ? 'Loading...' : 'Load Resource'}
            </button>

            <Show when={content()}>
              {(data) => (
                <div class=\"resource-content\">
                  <pre>{data()}</pre>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
\`\`\`

## Files to Create
- \`src/components/mcp/ResourcesPanel.tsx\`
- \`src/components/mcp/ResourcesPanel.css\`

## Definition of Done
- [ ] Panel shows resources from all connected servers
- [ ] Resource selection shows details
- [ ] Resource content loads on demand
- [ ] MIME types displayed
- [ ] Error handling works"

# Issue #48: Chat MCP Tool Integration
gh issue create --repo "$REPO" \
  --title "Integrate MCP tool calls into chat flow" \
  --label "phase:5-mcp,component:mcp,component:chat,priority:high,agent: codex" \
  --body "## Overview
Allow AI to use MCP tools during chat conversations with user approval.

## Technical Requirements

### Tool Call Detection
When AI response contains tool calls, show approval UI before execution.

### Tool Approval Component
Create \`src/components/chat/ToolApproval.tsx\`:
\`\`\`typescript
import { For, createSignal } from 'solid-js';
import { mcpClient } from '../../lib/mcp/client';
import type { McpToolCall, McpToolResult } from '../../lib/mcp/types';

interface ToolApprovalProps {
  serverName: string;
  toolCalls: McpToolCall[];
  onApprove: (results: McpToolResult[]) => void;
  onReject: () => void;
}

export function ToolApproval(props: ToolApprovalProps) {
  const [executing, setExecuting] = createSignal(false);
  const [results, setResults] = createSignal<McpToolResult[]>([]);

  async function executeAll() {
    setExecuting(true);
    const allResults: McpToolResult[] = [];

    for (const call of props.toolCalls) {
      try {
        const result = await mcpClient.callTool(props.serverName, call);
        allResults.push(result);
      } catch (error) {
        allResults.push({
          content: [{ type: 'text', text: \`Error: \${error}\` }],
          isError: true
        });
      }
    }

    setResults(allResults);
    props.onApprove(allResults);
  }

  return (
    <div class=\"tool-approval\">
      <div class=\"approval-header\">
        <span class=\"warning-icon\">⚠️</span>
        <span>AI wants to use {props.toolCalls.length} tool(s)</span>
      </div>

      <div class=\"tool-calls\">
        <For each={props.toolCalls}>
          {(call) => (
            <div class=\"tool-call\">
              <span class=\"tool-name\">{call.name}</span>
              <pre class=\"tool-args\">{JSON.stringify(call.arguments, null, 2)}</pre>
            </div>
          )}
        </For>
      </div>

      <div class=\"approval-actions\">
        <button
          class=\"approve-btn\"
          onClick={executeAll}
          disabled={executing()}
        >
          {executing() ? 'Executing...' : 'Approve & Run'}
        </button>
        <button
          class=\"reject-btn\"
          onClick={props.onReject}
          disabled={executing()}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
\`\`\`

### Chat Integration
Modify chat message handler to detect and handle tool calls:
\`\`\`typescript
// In chat service
function handleAssistantMessage(message: string, toolCalls?: McpToolCall[]) {
  if (toolCalls && toolCalls.length > 0) {
    // Show approval UI
    setPendingToolCalls(toolCalls);
  } else {
    // Normal message handling
    addMessage({ role: 'assistant', content: message });
  }
}

// After approval
async function handleToolApproval(results: McpToolResult[]) {
  // Add tool results to conversation
  // Continue with AI response
}
\`\`\`

## Files to Create/Modify
- \`src/components/chat/ToolApproval.tsx\`
- \`src/lib/chat/service.ts\` (add tool handling)
- \`src/components/chat/ChatPanel.tsx\` (integrate approval UI)

## Definition of Done
- [ ] Tool calls detected in AI responses
- [ ] Approval UI shows tool details
- [ ] User can approve or reject
- [ ] Results fed back to AI
- [ ] Conversation continues after tool use"

# Issue #49: MCP Status Indicator
gh issue create --repo "$REPO" \
  --title "Add MCP connection status indicator to status bar" \
  --label "phase:5-mcp,component:mcp,component:ui,priority:low,agent: codex" \
  --body "## Overview
Show MCP server connection status in the application status bar.

## Technical Requirements

### Status Indicator Component
Create \`src/components/status/McpStatus.tsx\`:
\`\`\`typescript
import { Show, createMemo } from 'solid-js';
import { mcpClient } from '../../lib/mcp/client';

export function McpStatus() {
  const connectionSummary = createMemo(() => {
    const connections = mcpClient.connections();
    const total = connections.size;
    const connected = Array.from(connections.values())
      .filter(c => c.status === 'connected').length;
    const hasErrors = Array.from(connections.values())
      .some(c => c.status === 'error');

    return { total, connected, hasErrors };
  });

  const statusClass = createMemo(() => {
    const { total, connected, hasErrors } = connectionSummary();
    if (hasErrors) return 'error';
    if (connected === total && total > 0) return 'connected';
    if (connected > 0) return 'partial';
    return 'disconnected';
  });

  return (
    <div class=\"mcp-status\" classList={{ [statusClass()]: true }}>
      <span class=\"mcp-icon\">🔌</span>
      <Show
        when={connectionSummary().total > 0}
        fallback={<span class=\"mcp-label\">No MCP</span>}
      >
        <span class=\"mcp-label\">
          MCP {connectionSummary().connected}/{connectionSummary().total}
        </span>
      </Show>
    </div>
  );
}
\`\`\`

### Styles
\`\`\`css
.mcp-status {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.mcp-status.connected {
  color: #4caf50;
}

.mcp-status.partial {
  color: #ff9800;
}

.mcp-status.error {
  color: #f44336;
}

.mcp-status.disconnected {
  color: #9e9e9e;
}
\`\`\`

## Files to Create/Modify
- \`src/components/status/McpStatus.tsx\`
- \`src/components/status/StatusBar.tsx\` (add MCP status)

## Definition of Done
- [ ] Status indicator in status bar
- [ ] Shows connection count
- [ ] Color indicates state
- [ ] Tooltip shows server names"

# Issue #50: MCP Auto-Connect
gh issue create --repo "$REPO" \
  --title "Implement MCP server auto-connect on startup" \
  --label "phase:5-mcp,component:mcp,priority:medium,agent: codex" \
  --body "## Overview
Automatically connect to configured MCP servers on application startup.

## Technical Requirements

### Startup Hook
\`\`\`typescript
// In App.tsx or main initialization
import { onMount } from 'solid-js';
import { mcpClient } from './lib/mcp/client';
import { mcpSettings } from './stores/settings';

function App() {
  onMount(async () => {
    await autoConnectMcpServers();
  });

  return (/* ... */);
}

async function autoConnectMcpServers() {
  const settings = mcpSettings();

  const autoConnectServers = settings.servers.filter(
    s => s.enabled && s.autoConnect
  );

  // Connect in parallel with error isolation
  await Promise.allSettled(
    autoConnectServers.map(async (server) => {
      try {
        await mcpClient.connect(server.name, server.command, server.args);
        console.log(\`MCP: Connected to \${server.name}\`);
      } catch (error) {
        console.error(\`MCP: Failed to connect to \${server.name}:\`, error);
      }
    })
  );
}
\`\`\`

### Retry Logic
\`\`\`typescript
async function connectWithRetry(
  server: McpServerConfig,
  maxRetries = 3,
  delay = 1000
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mcpClient.connect(server.name, server.command, server.args);
      return;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }
}
\`\`\`

## Files to Modify
- \`src/App.tsx\` (add auto-connect)
- \`src/lib/mcp/client.ts\` (add retry logic)

## Definition of Done
- [ ] Servers with autoConnect=true connect on startup
- [ ] Failed connections don't block app startup
- [ ] Retry logic with backoff
- [ ] Errors logged but non-fatal"

# Issue #51: MCP Error Handling
gh issue create --repo "$REPO" \
  --title "Implement comprehensive MCP error handling" \
  --label "phase:5-mcp,component:mcp,priority:medium,agent: codex" \
  --body "## Overview
Handle MCP-specific errors gracefully with user feedback.

## Technical Requirements

### Error Types
\`\`\`typescript
export class McpError extends Error {
  constructor(
    message: string,
    public code: McpErrorCode,
    public serverName?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export enum McpErrorCode {
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  SERVER_NOT_FOUND = 'SERVER_NOT_FOUND',
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  TIMEOUT = 'TIMEOUT',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
}

export function formatMcpError(error: McpError): string {
  switch (error.code) {
    case McpErrorCode.CONNECTION_FAILED:
      return \`Failed to connect to MCP server \"\${error.serverName}\". Check that the server command is correct.\`;
    case McpErrorCode.TOOL_NOT_FOUND:
      return \`Tool not found on server \"\${error.serverName}\". The server may have been updated.\`;
    case McpErrorCode.TOOL_EXECUTION_FAILED:
      return \`Tool execution failed: \${error.message}\`;
    case McpErrorCode.TIMEOUT:
      return \`MCP request timed out after \${error.details}ms\`;
    default:
      return error.message;
  }
}
\`\`\`

### Toast Notifications
\`\`\`typescript
function handleMcpError(error: McpError) {
  const message = formatMcpError(error);

  showToast({
    type: 'error',
    title: 'MCP Error',
    message,
    duration: 5000
  });

  // Log for debugging
  console.error('MCP Error:', error);
}
\`\`\`

### Connection Recovery
\`\`\`typescript
// Monitor connection health
function monitorConnection(serverName: string) {
  let missedPings = 0;

  const interval = setInterval(async () => {
    try {
      await mcpClient.ping(serverName);
      missedPings = 0;
    } catch {
      missedPings++;
      if (missedPings >= 3) {
        // Mark as disconnected and attempt reconnect
        await attemptReconnect(serverName);
      }
    }
  }, 30000); // Every 30 seconds

  return () => clearInterval(interval);
}
\`\`\`

## Files to Create/Modify
- \`src/lib/mcp/errors.ts\`
- \`src/lib/mcp/client.ts\` (add error handling)
- \`src/components/common/Toast.tsx\` (if not exists)

## Definition of Done
- [ ] Typed error classes
- [ ] User-friendly error messages
- [ ] Toast notifications for errors
- [ ] Connection health monitoring
- [ ] Automatic reconnection attempts"

# Issue #52: MCP Documentation
gh issue create --repo "$REPO" \
  --title "Create MCP integration documentation" \
  --label "phase:5-mcp,type:docs,priority:low,agent: codex" \
  --body "## Overview
Document how to configure and use MCP servers with Seren Desktop.

## Documentation Sections

### 1. What is MCP?
- Brief explanation of Model Context Protocol
- Link to official MCP documentation
- Benefits for AI-powered development

### 2. Configuring MCP Servers
- How to add servers via Settings
- Server configuration options:
  - name
  - command
  - args
  - environment variables
  - auto-connect option

### 3. Popular MCP Servers
List compatible servers:
- @anthropic-ai/mcp-server-filesystem
- @anthropic-ai/mcp-server-github
- @anthropic-ai/mcp-server-brave-search
- Community servers

### 4. Using MCP Tools
- How to access the Tools Panel
- Executing tools manually
- Tool approval in chat

### 5. Using MCP Resources
- Browsing available resources
- Reading resource content
- Resource types (files, data, etc.)

### 6. Troubleshooting
- Common connection issues
- Server compatibility
- Debug logging

## Files to Create
- \`docs/guides/mcp-integration.md\`
- Update \`README.md\` with MCP section

## Definition of Done
- [ ] Comprehensive MCP documentation
- [ ] Configuration examples
- [ ] Troubleshooting guide
- [ ] Screenshots of UI elements"

echo "Phase 5 issues created successfully!"
echo "Created issues #43-#52 for MCP Integration"
