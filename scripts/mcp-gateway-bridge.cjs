#!/usr/bin/env node
// ABOUTME: MCP Gateway bridge - connects to mcp.serendb.com via SSE
// ABOUTME: Proxies JSON-RPC between stdio (for Rust backend) and SSE (for Gateway)

const https = require('https');
const { once } = require('events');
const fs = require('fs');
const path = require('path');

// Log to file for debugging
const logFile = path.join(require('os').tmpdir(), 'mcp-bridge.log');
function log(...args) {
  const message = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(logFile, message);
  } catch (err) {
    // Silent fail if can't write log
  }
}

// Log startup immediately (even before arg parsing)
log('[Bridge] Process started, pid:', process.pid);
log('[Bridge] Working directory:', process.cwd());
log('[Bridge] Node version:', process.version);
log('[Bridge] Args:', process.argv.join(' '));

// Parse command line arguments
const args = process.argv.slice(2);
const tokenArg = args.find(arg => arg.startsWith('--token='));
const token = tokenArg ? tokenArg.slice('--token='.length) : process.env.SEREN_TOKEN;

if (!token) {
  log('Error: No authentication token provided');
  log('Usage: node mcp-gateway-bridge.js --token=YOUR_TOKEN');
  process.exit(1);
}

const MCP_URL = 'https://mcp.serendb.com/mcp';
const GATEWAY_HOST = 'mcp.serendb.com';

function sendToGateway(message) {
  const body = JSON.stringify(message);
  log('[Bridge] Sending to Gateway:', message.method || 'response', 'id:', message.id);

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
    log('[Bridge] Got response from Gateway, status:', res.statusCode);
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      if (res.statusCode === 200) {
        try {
          const response = JSON.parse(data);
          log('[Bridge] Gateway response parsed successfully');
          sendToRust(response);
        } catch (err) {
          log('[Bridge] Failed to parse gateway response:', err.message);
          log('[Bridge] Response data:', data.substring(0, 200));
        }
      } else {
        log(`[Bridge] Gateway request failed with status: ${res.statusCode}`);
        log('[Bridge] Response body:', data.substring(0, 200));
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
    log('[Bridge] Gateway request error:', err.message);
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

  req.on('timeout', () => {
    log('[Bridge] Gateway request timed out');
    req.destroy();
    if (message.id) {
      sendToRust({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: 'Gateway request timed out',
        },
      });
    }
  });

  // Set 30 second timeout
  req.setTimeout(30000);

  req.write(body);
  req.end();
}

// Gateway messages come via POST responses, not SSE

function sendToRust(message) {
  log('[Bridge] Sending to Rust:', message.method || (message.result ? 'result' : 'error'), 'id:', message.id);
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
        log('[Bridge] Received message:', message.method || 'response', 'id:', message.id);
        sendToGateway(message);
      } catch (err) {
        log('[Bridge] Failed to parse stdin:', err.message);
      }
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

// Handle process termination
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

// Log startup to stderr (won't interfere with JSON-RPC on stdout)
log('[Bridge] Starting MCP Gateway Bridge...');
log('[Bridge] Token length:', token ? token.length : 0);
log('[Bridge] Waiting for initialize message from client...');

// Ready to process stdin messages
