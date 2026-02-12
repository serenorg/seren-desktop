# Polymarket WebSocket Implementation

**Issue:** #649
**Branch:** `feature/polymarket-websocket`
**Status:** Ready for PR

## Summary

Added WebSocket support to Seren Desktop's Polymarket integration for real-time market data and order updates.

## Architecture

**WebSocket is ADDITIONAL to MCP Publishers:**
- **Python trading agent** → Uses Seren MCP publishers (`polymarket`, `polymarket-data`, etc.)
- **Seren Desktop backend** → WebSocket provides real-time feeds to frontend UI
- **They work together:** MCP for trading actions, WebSocket for live UI updates

## Files Added

### src-tauri/src/polymarket/websocket.rs
WebSocket client implementation:
- Connects to `wss://ws-subscriptions-clob.polymarket.com/ws/`
- Handles market price updates (public)
- Handles user order status updates (authenticated)
- Auto-reconnect support
- Emits Tauri events for frontend consumption

**Key Types:**
- `PolymarketWebSocket` - Main WebSocket client
- `Channel` - Subscription channel enum (Market, User)
- `PolymarketWsMessage` - Message types from server

**Tauri Events Emitted:**
- `polymarket-market-update` - Real-time price/orderbook updates
- `polymarket-user-update` - User order status changes
- `polymarket-ws-subscribed` - Subscription confirmed
- `polymarket-ws-unsubscribed` - Unsubscription confirmed
- `polymarket-ws-error` - WebSocket error
- `polymarket-ws-disconnected` - Connection closed

## Files Modified

### src-tauri/src/polymarket/mod.rs
- Exposed `websocket` module
- Exported `Channel` and `PolymarketWebSocket` types

### src-tauri/src/polymarket/types.rs
- Added WebSocket-specific error types:
  - `WebSocketError(String)`
  - `ConnectionFailed(String)`

### src-tauri/src/polymarket/commands.rs
Added Tauri commands:
- `connect_polymarket_websocket` - Connect to WebSocket
- `subscribe_polymarket_market(market_id)` - Subscribe to market updates
- `subscribe_polymarket_user` - Subscribe to user order updates (authenticated)

Added state type:
- `PolymarketWsState` - Global WebSocket client state

### src-tauri/src/lib.rs
- Added WebSocket state management: `.manage(PolymarketWsState::default())`
- Registered WebSocket commands in `invoke_handler!`

## Dependencies

Uses existing dependencies:
- `tokio-tungstenite` - Already available via `openclaw` feature
- `tokio` - Already in use
- `futures` - Already in use
- No new dependencies added

## Usage

### Frontend TypeScript

```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Connect to WebSocket
await invoke('connect_polymarket_websocket');

// Subscribe to market price updates
await invoke('subscribe_polymarket_market', {
  marketId: '0x123...'
});

// Subscribe to user order updates (authenticated)
await invoke('subscribe_polymarket_user');

// Listen for real-time updates
await listen('polymarket-market-update', (event) => {
  console.log('Market update:', event.payload);
});

await listen('polymarket-user-update', (event) => {
  console.log('Order update:', event.payload);
});

await listen('polymarket-ws-error', (event) => {
  console.error('WebSocket error:', event.payload);
});
```

### Message Format

**Market Updates:**
```json
{
  "event": "price_change",
  "market": "0x123...",
  "data": {
    "price": 0.54,
    "volume": 12000,
    "timestamp": "2026-02-12T22:00:00Z"
  }
}
```

**User Order Updates:**
```json
{
  "event": "order_filled",
  "data": {
    "order_id": "abc123",
    "status": "filled",
    "filled_amount": 5.0,
    "timestamp": "2026-02-12T22:00:00Z"
  }
}
```

## Security

- **API Key Protection:** User subscriptions use API key from encrypted store
- **Automatic Auth:** Credentials loaded from Tauri encrypted store
- **No Credential Logging:** API keys never logged or exposed

## Error Handling

- **Connection Failures:** Returns error via command result
- **WebSocket Errors:** Emitted as `polymarket-ws-error` events
- **Disconnections:** Emitted as `polymarket-ws-disconnected` events
- **Auto-Reconnect:** Client can call `connect_polymarket_websocket` again

## Testing Checklist

- [ ] WebSocket connects successfully
- [ ] Market subscription works (public channel)
- [ ] User subscription works (authenticated channel)
- [ ] Market update events received
- [ ] User order update events received
- [ ] Error events emitted correctly
- [ ] Disconnect events emitted correctly
- [ ] Reconnection works after disconnect
- [ ] Multiple market subscriptions work
- [ ] Credentials loaded from encrypted store

## Integration with Polymarket Trader Skill

The WebSocket support enhances the trading skill by providing:
1. **Real-time price feeds** for the frontend UI
2. **Live order status** updates without polling
3. **Lower API costs** (WebSocket vs repeated HTTP calls)
4. **Better UX** for monitoring trades

**Note:** The Python trading agent still uses MCP publishers for executing trades. WebSocket is for UI updates only.

## Future Enhancements

- [ ] Automatic reconnection with exponential backoff
- [ ] Subscription management (unsubscribe from specific channels)
- [ ] Connection health monitoring (heartbeat/ping)
- [ ] Rate limiting on subscriptions
- [ ] Message buffering during disconnections
- [ ] Frontend component for live market prices
- [ ] Frontend component for live order status

## Related Work

- **Issue:** #649 - Add WebSocket support for real-time Polymarket updates
- **Polymarket Trading Skill:** Uses MCP publishers for trading actions
- **Polymarket API Docs:** https://docs.polymarket.com/

## References

- Polymarket WebSocket endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/`
- Polymarket API documentation: https://docs.polymarket.com/
- Tauri event system: https://v2.tauri.app/develop/calling-frontend/
