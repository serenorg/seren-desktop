# MCP Integration Guide

This guide explains how to configure and use MCP (Model Context Protocol) servers with Seren Desktop.

## Overview

MCP enables Seren Desktop to connect to external tools and resources through a standardized protocol. MCP servers provide:

- **Tools**: Executable functions the AI can call (with user approval)
- **Resources**: Data sources the AI can read for context

## Configuring MCP Servers

### Adding a Server

1. Open Settings > MCP Servers
2. Click "Add Server"
3. Fill in the configuration:
   - **Name**: Unique identifier for the server
   - **Command**: Executable path (e.g., `npx`, `node`, `python`)
   - **Arguments**: Comma-separated arguments for the command
   - **Auto-connect**: Enable to connect automatically on app startup

### Example Configurations

#### Filesystem Server
```
Name: filesystem
Command: npx
Arguments: -y, @modelcontextprotocol/server-filesystem, /path/to/directory
Auto-connect: Yes
```

#### SQLite Server
```
Name: sqlite
Command: npx
Arguments: -y, @modelcontextprotocol/server-sqlite, /path/to/database.db
Auto-connect: No
```

#### Custom Python Server
```
Name: custom-tools
Command: python
Arguments: -m, my_mcp_server
Auto-connect: Yes
```

## Using MCP in Chat

### Tool Calls

When the AI wants to use an MCP tool, you'll see a tool call request in the chat:

1. Review the tool name and arguments
2. Click "Approve & Execute" to run the tool
3. Or click "Deny" to reject the request

The tool result will be displayed inline and used by the AI for context.

### Available Tools

View all available tools across connected servers:

1. Open the MCP Tools panel from the sidebar
2. Browse tools by server
3. View tool descriptions and input schemas
4. Execute tools directly with custom arguments

## Browsing Resources

MCP resources provide read-only data access:

1. Open the MCP Resources panel from the sidebar
2. Search or browse available resources
3. Click a resource to view its contents
4. Use the "Copy" button to copy content to clipboard

## Connection Status

The status bar shows MCP connection status:

- 🟢 All servers connected
- 🟡 Some servers connecting
- 🔴 Connection errors present
- ⚪ No servers configured

Hover over the indicator to see detailed server status.

## Troubleshooting

### Server Won't Connect

1. Verify the command is installed and accessible
2. Check arguments are correct and comma-separated
3. Review server logs for errors
4. Try running the command manually in terminal

### Tools Not Appearing

1. Ensure the server is connected (green status)
2. Some servers require initialization time
3. Click refresh in the Tools panel
4. Check server supports the tools/list method

### Permission Errors

MCP server commands run with user permissions. Ensure:
- The command has execute permissions
- Required files/directories are accessible
- Environment variables are set correctly

## Security Considerations

### Tool Approval

All tool calls require explicit user approval. This prevents:
- Unintended file modifications
- Unwanted external API calls
- Accidental data exposure

### Server Isolation

Each MCP server runs as a separate process with:
- Its own environment
- Limited to configured paths
- No access to Seren internals

### Best Practices

1. Only add servers from trusted sources
2. Review tool calls before approving
3. Limit filesystem access to necessary directories
4. Disable auto-connect for sensitive servers

## API Reference

### TypeScript Types

```typescript
import type {
  McpTool,
  McpResource,
  McpServerConfig,
  McpConnection
} from '@/lib/mcp';
```

### Client Usage

```typescript
import { mcpClient } from '@/lib/mcp';

// Connect to a server
await mcpClient.connect('my-server', 'npx', ['-y', 'server-package']);

// List tools
const tools = await mcpClient.listTools('my-server');

// Call a tool
const result = await mcpClient.callTool('my-server', {
  name: 'read_file',
  arguments: { path: '/some/file.txt' }
});

// Read a resource
const content = await mcpClient.readResource('my-server', 'file:///path');

// Disconnect
await mcpClient.disconnect('my-server');
```

### Error Handling

```typescript
import {
  McpError,
  McpConnectionError,
  parseMcpError,
  isRecoverableError
} from '@/lib/mcp';

try {
  await mcpClient.connect('server', 'cmd', []);
} catch (error) {
  const mcpError = parseMcpError(error);

  if (isRecoverableError(mcpError)) {
    // Can retry
  }

  console.error(mcpError.code, mcpError.message);
}
```

## Further Reading

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Official MCP Servers](https://github.com/modelcontextprotocol/servers)
- [Building MCP Servers](https://modelcontextprotocol.io/docs/concepts/servers)
