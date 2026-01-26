#!/usr/bin/env node
// ABOUTME: MCP Gateway bridge - connects to mcp.serendb.com via SSE
// ABOUTME: Proxies JSON-RPC between stdio (for Rust backend) and SSE (for Gateway)

const https = require('https');
const { once } = require('events');

// Parse command line arguments
const args = process.argv.slice(2);
const tokenArg = args.find(arg => arg.startsWith('--token='));
const token = tokenArg ? tokenArg.slice('--token='.length) : process.env.SEREN_TOKEN;

if (!token) {
  console.error('Error: No authentication token provided');
  console.error('Usage: node mcp-gateway-bridge.js --token=YOUR_TOKEN');
  process.exit(1);
}

const MCP_URL = 'https://mcp.serendb.com/mcp';
const GATEWAY_HOST = 'mcp.serendb.com';

// Track pending requests
const pendingRequests = new Map();

// SSE connection
let sseRequest = null;
let reconnectTimeout = null;

function connectSSE() {
  if (sseRequest) {
    sseRequest.destroy();
  }

  const options = {
    hostname: GATEWAY_HOST,
    path: '/mcp',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  };

  sseRequest = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      console.error(`SSE connection failed: ${res.statusCode}`);
      scheduleReconnect();
      return;
    }

    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const message = JSON.parse(data);
            handleGatewayMessage(message);
          } catch (err) {
            console.error('Failed to parse SSE message:', err.message);
          }
        }
      }
    });

    res.on('end', () => {
      console.error('SSE connection closed');
      scheduleReconnect();
    });

    res.on('error', (err) => {
      console.error('SSE error:', err.message);
      scheduleReconnect();
    });
  });

  sseRequest.on('error', (err) => {
    console.error('SSE request error:', err.message);
    scheduleReconnect();
  });

  sseRequest.end();
}

function scheduleReconnect() {
  if (reconnectTimeout) return;
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectSSE();
  }, 5000);
}

function sendToGateway(message) {
  const body = JSON.stringify(message);
  const options = {
    hostname: GATEWAY_HOST,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      if (res.statusCode === 200) {
        try {
          const response = JSON.parse(data);
          handleGatewayMessage(response);
        } catch (err) {
          console.error('Failed to parse gateway response:', err.message);
        }
      } else {
        console.error(`Gateway request failed: ${res.statusCode}`);
        // Send error back to Rust
        if (message.id) {
          sendToRust({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32000,
              message: `Gateway error: ${res.statusCode}`,
            },
          });
        }
      }
    });
  });

  req.on('error', (err) => {
    console.error('Gateway request error:', err.message);
    if (message.id) {
      sendToRust({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: `Connection error: ${err.message}`,
        },
      });
    }
  });

  req.write(body);
  req.end();
}

function handleGatewayMessage(message) {
  // Forward to Rust via stdout
  sendToRust(message);
}

function sendToRust(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

// Handle stdin from Rust
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() || '';

  for (const line of lines) {
    if (line.trim()) {
      try {
        const message = JSON.parse(line);
        sendToGateway(message);
      } catch (err) {
        console.error('Failed to parse stdin message:', err.message);
      }
    }
  }
});

process.stdin.on('end', () => {
  if (sseRequest) {
    sseRequest.destroy();
  }
  process.exit(0);
});

// Handle process termination
process.on('SIGINT', () => {
  if (sseRequest) {
    sseRequest.destroy();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (sseRequest) {
    sseRequest.destroy();
  }
  process.exit(0);
});

// Start SSE connection
connectSSE();
