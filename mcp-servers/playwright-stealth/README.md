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

## Browser Configuration

### Default Browser (Environment Variable)

Set `BROWSER_TYPE` to choose the default browser at startup:

```bash
# Chromium (default)
node dist/index.js

# Firefox
BROWSER_TYPE=firefox node dist/index.js

# Google Chrome (system install)
BROWSER_TYPE=chrome node dist/index.js

# Microsoft Edge
BROWSER_TYPE=msedge node dist/index.js

# WebKit (Safari engine)
BROWSER_TYPE=webkit node dist/index.js
```

"edge" is accepted as an alias for "msedge".

### In Seren Desktop

Configure the browser in MCP server settings by adding to the server's environment:

```json
{
  "env": {
    "BROWSER_TYPE": "firefox"
  }
}
```

### Runtime Browser Switching

Use MCP tools to discover and switch browsers during a session:

1. Call `playwright_list_browsers` to see all installed browsers
2. Call `playwright_set_browser` with the desired browser name to switch

This is useful for A/B testing across browsers or falling back when a site requires a specific browser.

### Supported Browsers

| Name | Engine | Stealth | Notes |
| ---- | ------ | ------- | ----- |
| `chromium` | Chromium | Yes | Playwright's bundled Chromium (default) |
| `chrome` | Chromium | Yes | System Google Chrome |
| `chrome-beta` | Chromium | Yes | System Google Chrome Beta |
| `msedge` | Chromium | Yes | System Microsoft Edge |
| `msedge-beta` | Chromium | Yes | System Microsoft Edge Beta |
| `firefox` | Firefox | No | Playwright's bundled Firefox |
| `firefox-beta` | Firefox | No | Playwright's bundled Firefox Beta |
| `moz-firefox` | Firefox | No | System Mozilla Firefox |
| `webkit` | WebKit | No | Playwright's bundled WebKit (Safari engine) |

Only browsers actually installed on your system will appear in `playwright_list_browsers`.

### Stealth Compatibility

The stealth plugin (`puppeteer-extra-plugin-stealth`) targets Chromium internals:

- **Chromium/Chrome/Edge**: Full stealth evasions (webdriver flag, plugins mock, automation flags, etc.)
- **Firefox**: No stealth evasions. Firefox has different automation detection mechanisms.
- **WebKit**: No stealth evasions. WebKit/Safari detection works differently.

### Installing Additional Browsers

```bash
# Install Playwright's bundled browsers
npx playwright install chromium
npx playwright install firefox
npx playwright install webkit

# System browsers (Chrome, Edge) must be installed via their normal installers
```

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

## License

MIT
