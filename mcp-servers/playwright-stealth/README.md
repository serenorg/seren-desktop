# Playwright Stealth MCP Server

A Model Context Protocol (MCP) server providing stealth browser automation with anti-bot detection bypass capabilities.

## Features

- **Multi-Browser Support**: Chromium (default), Firefox, WebKit, Google Chrome, Microsoft Edge, and any installed Playwright browser
- **Runtime Browser Switching**: Discover installed browsers and switch between them via MCP tools
- **Stealth Browser**: Uses `playwright-extra` with `puppeteer-extra-plugin-stealth` to avoid bot detection (Chromium-based browsers only)
- **Anti-Detection Measures** (Chromium/Edge/Chrome only):
  - Removes `navigator.webdriver` flag
  - Mocks plugins array
  - Sets realistic browser headers
  - Configures proper timezone and locale
  - Disables automation-controlled Chrome features
- **Full Playwright API**: All standard Playwright tools (navigate, screenshot, click, fill, etc.)

## Installation

```bash
cd mcp-servers/playwright-stealth
pnpm install
pnpm build
```

## Usage

This MCP server is automatically configured in Seren Desktop. It provides the same tools as the standard Playwright server but with stealth features enabled:

### Available Tools

- `playwright_navigate` - Navigate to a URL with stealth features
- `playwright_screenshot` - Capture screenshots
- `playwright_click` - Click elements
- `playwright_fill` - Fill form inputs
- `playwright_evaluate` - Execute JavaScript
- `playwright_extract_content` - Extract text content
- `playwright_navigate_back` - Go back in history
- `playwright_navigate_forward` - Go forward in history
- `playwright_select` - Select dropdown options
- `playwright_hover` - Hover over elements
- `playwright_press` - Press keyboard keys
- `playwright_close` - Close browser
- `playwright_reset` - Reset page
- `playwright_list_browsers` - List all installed browsers available for automation
- `playwright_set_browser` - Switch to a different installed browser at runtime
- `playwright_get_cookie` - Read a cookie value (including HttpOnly cookies) from the active page's origin

## Browser Configuration

### Default Browser (Environment Variable)

The server auto-detects the best system browser (preferring Chrome > Edge > Firefox). Override with `BROWSER_TYPE`:

```bash
# Auto-detect (uses system Chrome if available)
node dist/index.js

# Explicit: Google Chrome
BROWSER_TYPE=chrome node dist/index.js

# Explicit: Microsoft Edge
BROWSER_TYPE=msedge node dist/index.js

# Explicit: Mozilla Firefox
BROWSER_TYPE=moz-firefox node dist/index.js
```

"edge" is accepted as an alias for "msedge".

### Profile Compatibility Controls

The default profile is Privy-compatible: headed launch, the safe stealth plugin
for Chromium-based browsers, `iframe.contentWindow` and
`navigator.permissions` evasions disabled, and the manual page init patch off.
This supports embedded-wallet provisioning flows while preserving the remaining
Chromium stealth evasions. Set only the controls needed when a workflow needs
the older full-stealth/headless profile or a custom profile:

```bash
# Opt back into headless mode.
SEREN_PLAYWRIGHT_HEADLESS=1 node dist/index.js

# Skip the puppeteer-extra stealth plugin entirely.
SEREN_PLAYWRIGHT_DISABLE_STEALTH=1 node dist/index.js

# Keep stealth enabled but remove specific evasions by name.
SEREN_PLAYWRIGHT_STEALTH_EVASIONS_DISABLE=navigator.webdriver node dist/index.js

# Opt back into the hand-written addInitScript patch for new Chromium pages.
SEREN_PLAYWRIGHT_DISABLE_PAGE_INIT_PATCH=0 node dist/index.js
```

The `SEREN_PLAYWRIGHT_STEALTH_EVASIONS_DISABLE` value is a comma-separated list
of evasion names. When the variable is unset, `iframe.contentWindow` and
`navigator.permissions` are disabled by default. When it is set, the provided
list replaces the default disabled set; set it to an empty string to opt back
into all stealth evasions except `chrome.app`, which is always disabled for
macOS notarization compatibility.

### In Seren Desktop

Configure the browser in MCP server settings by adding to the server's environment:

```json
{
  "env": {
    "BROWSER_TYPE": "moz-firefox",
    "SEREN_PLAYWRIGHT_HEADLESS": "0"
  }
}
```

### Ping / Idle Timeout

By default, the bundled transport keeps its existing stdio behavior. Agents
that keep a browser session warm while doing long server-side work between MCP
tool calls can opt into an idle watchdog with `PLAYWRIGHT_MCP_PING_TIMEOUT_MS`:

```bash
# Keep the MCP transport alive through long no-traffic windows.
PLAYWRIGHT_MCP_PING_TIMEOUT_MS=300000 node dist/index.js
```

Leave the variable unset for casual use. For workflows with long no-traffic
windows between `tools/call` requests, such as waiting on a remote AI
calculation before returning to the browser, use `300000` (5 minutes) or higher.
Seren Desktop and skill subprocesses pass this variable through to the bundled
MCP child when it is present in the process environment.

### Runtime Browser Switching

Use MCP tools to discover and switch browsers during a session:

1. Call `playwright_list_browsers` to see all installed browsers
2. Call `playwright_set_browser` with the desired browser name to switch

This is useful for A/B testing across browsers or falling back when a site requires a specific browser.

### Supported Browsers

Only system-installed browsers are used. Playwright's bundled test browsers (`chromium`, `firefox`, `webkit`) are excluded because they are identifiable automation binaries that get flagged by bot detection.

| Name | Engine | Stealth | Notes |
| ---- | ------ | ------- | ----- |
| `chrome` | Chromium | Yes | Google Chrome |
| `chrome-beta` | Chromium | Yes | Google Chrome Beta |
| `chrome-dev` | Chromium | Yes | Google Chrome Dev |
| `chrome-canary` | Chromium | Yes | Google Chrome Canary |
| `msedge` | Chromium | Yes | Microsoft Edge |
| `msedge-beta` | Chromium | Yes | Microsoft Edge Beta |
| `msedge-dev` | Chromium | Yes | Microsoft Edge Dev |
| `msedge-canary` | Chromium | Yes | Microsoft Edge Canary |
| `moz-firefox` | Firefox | No | Mozilla Firefox |
| `moz-firefox-beta` | Firefox | No | Mozilla Firefox Beta |
| `moz-firefox-nightly` | Firefox | No | Mozilla Firefox Nightly |

Only browsers actually installed on your system will appear in `playwright_list_browsers`.

### Stealth Compatibility

The stealth plugin (`puppeteer-extra-plugin-stealth`) targets Chromium internals:

- **Chrome/Edge**: Full stealth evasions (webdriver flag, plugins mock, automation flags, etc.)
- **Firefox**: No stealth evasions. Firefox has different automation detection mechanisms.

### Installing Browsers

System browsers must be installed via their normal installers:

- **Google Chrome**: [google.com/chrome](https://www.google.com/chrome/)
- **Microsoft Edge**: [microsoft.com/edge](https://www.microsoft.com/edge)
- **Mozilla Firefox**: [mozilla.org/firefox](https://www.mozilla.org/firefox/)

## How Stealth Works

The stealth plugin applies multiple evasion techniques (Chromium-based browsers only):

1. **WebDriver Flag**: Sets `navigator.webdriver = false` (normally `true` in automated browsers)
2. **Plugins**: Mocks `navigator.plugins` to appear like a real browser
3. **Languages**: Sets `navigator.languages` to realistic values
4. **Permissions**: Overrides permission queries to behave like a real browser
5. **Chrome Features**: Disables `AutomationControlled` and other automation flags
6. **User Agent**: Uses browser-appropriate realistic user agent string
7. **Viewport**: Sets standard desktop viewport (1920x1080)

## Example Usage

```typescript
// List available browsers
const browsers = await playwright_list_browsers();

// Switch to Firefox for this workflow
await playwright_set_browser({ browser: "firefox" });

// Navigate to a site
await playwright_navigate({ url: "https://example.com" });

// Use a stricter wait only when the target can actually become idle
await playwright_navigate({
  url: "https://example.com",
  waitUntil: "networkidle",
  timeout: 10000,
});

// Extract data
const content = await playwright_extract_content();

// Switch to Chrome with stealth for a bot-protected site
await playwright_set_browser({ browser: "chrome" });
await playwright_navigate({ url: "https://protected-site.com" });
```

## When to Use Stealth

Use this server instead of standard Playwright when:
- Website blocks automated browsers
- Site checks for `navigator.webdriver`
- Bot detection systems are in place
- You need to appear as a regular user
- You need to test across multiple browser engines

## Technical Details

- **Package**: `@seren/mcp-playwright-stealth`
- **Dependencies**:
  - `playwright-extra` - Playwright with plugin support
  - `puppeteer-extra-plugin-stealth` - Anti-detection plugin
  - `@modelcontextprotocol/sdk` - MCP protocol implementation
- **Transport**: stdio (command-line invocation)
  - Accepts legacy newline-delimited JSON-RPC used by Seren Desktop.
  - Accepts `Content-Length` framed JSON-RPC used by first-party MCP gateways.
  - Responses mirror the framing mode used by the caller's request.
  - `PLAYWRIGHT_MCP_PING_TIMEOUT_MS` optionally closes an idle transport after
    the configured no-traffic window. Leave unset to preserve the default
    bundled behavior.
- **Navigation waits**: `playwright_navigate` defaults to Playwright's `load`
  event. Callers may pass `waitUntil: "domcontentloaded"` or
  `waitUntil: "networkidle"` and `timeout` in milliseconds when they need
  different semantics. Avoid `networkidle` for SPAs that keep websocket,
  GraphQL, auth-refresh, or analytics requests alive.
- **Timeout layering**: When this server is driven by another subprocess, keep
  the MCP-side navigation timeout strictly lower than the client-side request
  timeout. Equal timeouts can cause the client to report an opaque transport
  timeout before it receives Playwright's own error envelope.

## License

MIT
