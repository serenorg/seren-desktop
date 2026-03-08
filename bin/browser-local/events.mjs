// ABOUTME: Event bus for browser-local runtime notifications.
// ABOUTME: Broadcasts JSON-RPC notifications to authenticated WebSocket clients.

const authenticatedClients = new Set();

export function addClient(ws) {
  authenticatedClients.add(ws);
  ws.on("close", () => authenticatedClients.delete(ws));
}

export function removeClient(ws) {
  authenticatedClients.delete(ws);
}

export function emit(method, params = null) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
  });

  for (const client of authenticatedClients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}
